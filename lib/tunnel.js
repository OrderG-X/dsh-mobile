/**
 * 出门也能用：Cloudflare 免费快速隧道（trycloudflare.com），不用注册账号、不用公网 IP。
 *
 *   cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:<网关端口>
 *   → 打印 https://<随机词>.trycloudflare.com，外网的手机走 HTTPS 连到网关
 *
 * 隧道只是一条路：门禁照旧是网关的配对 + 设备 Cookie，没配对的从外网也只能看到配对页。
 * 快速隧道每起一次地址就变一次，所以 cloudflared 单独跑（不跟 DSH 一起退出）：
 * DSH 重启后按 tunnel.json 认回还在跑的那个，地址不变、手机不用重扫；电脑重启或关掉手机访问才会换。
 * 地址和连通状态都问 cloudflared 自己的本机状态接口（--metrics 的 /quicktunnel、/ready），不靠解析日志。
 * cloudflared 优先用系统里装好的；没有就下载 Cloudflare 官方 GitHub 发布的那个。
 */

import { spawn, execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const RELEASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/'

/** 这台机器该下哪个文件；不支持给 null */
export function assetFor(platform = process.platform, arch = process.arch) {
  const a = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }[arch]
  if (!a) return null
  if (platform === 'darwin' && (a === 'amd64' || a === 'arm64')) return { name: `cloudflared-darwin-${a}.tgz`, tgz: true }
  if (platform === 'linux') return { name: `cloudflared-linux-${a}`, tgz: false }
  if (platform === 'win32' && (a === 'amd64' || a === '386')) return { name: `cloudflared-windows-${a}.exe`, tgz: false }
  return null
}

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name)

/** 找 cloudflared：插件自己下的 → PATH → 常见安装位置 */
export function findCloudflared(binDir, env = process.env) {
  const cands = [path.join(binDir, exe('cloudflared'))]
  for (const d of String(env.PATH || '').split(path.delimiter)) if (d) cands.push(path.join(d, exe('cloudflared')))
  if (process.platform === 'darwin') cands.push('/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared')
  if (process.platform === 'win32') {
    for (const d of [env.ProgramFiles, env['ProgramFiles(x86)']]) if (d) cands.push(path.join(d, 'cloudflared', 'cloudflared.exe'))
  }
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return c } catch {}
  }
  return null
}

/**
 * 下载 cloudflared 到 binDir。
 * @param onProgress ({ got, total }) => void
 * @returns 可执行文件路径
 */
export async function downloadCloudflared(binDir, { onProgress = () => {}, fetchImpl = globalThis.fetch } = {}) {
  const asset = assetFor()
  if (!asset) throw new Error(`no cloudflared build for ${process.platform}/${process.arch}`)
  fs.mkdirSync(binDir, { recursive: true })
  const res = await fetchImpl(RELEASE + asset.name, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  const tmp = path.join(binDir, `.${asset.name}.${process.pid}.part`)
  const out = fs.createWriteStream(tmp, { mode: 0o755 })
  let got = 0
  try {
    for await (const chunk of res.body) {
      got += chunk.length
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      onProgress({ got, total })
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())))
  } catch (e) {
    out.destroy()
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
  const target = path.join(binDir, exe('cloudflared'))
  if (asset.tgz) {
    await new Promise((resolve, reject) => execFile('tar', ['-xzf', tmp, '-C', binDir, 'cloudflared'], (e) => (e ? reject(e) : resolve())))
    fs.unlinkSync(tmp)
  } else {
    fs.renameSync(tmp, target)
  }
  fs.chmodSync(target, 0o755)
  return target
}

/** 这个 pid 还活着吗 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/** 这个 pid 是不是一个快速隧道的 cloudflared（防止 pid 被别的程序复用后误杀） */
export function isCloudflared(pid) {
  try {
    if (process.platform === 'win32') {
      return /cloudflared/i.test(execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true }))
    }
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
    return /cloudflared/.test(cmd) && /trycloudflare|--url/.test(cmd)
  } catch {
    return false
  }
}

/** 旧版（0.1.0）留下的 cloudflared.pid：确认真是 cloudflared 再杀掉 */
export function killStale(pidFile, log = () => {}) {
  let pid
  try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()) } catch { return false }
  try { fs.unlinkSync(pidFile) } catch {}
  if (!pidAlive(pid) || !isCloudflared(pid)) return false
  try { process.kill(pid) } catch { return false }
  log(`清掉上次留下的 cloudflared（pid ${pid}）`)
  return true
}

/** 本机挑一个空闲端口给 cloudflared 的状态接口 */
export function freeLocalPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

/**
 * 管一个 cloudflared 进程：开着就保持开着（掉了按 2s→60s 退避重启），关掉就杀掉。
 * 进程单独跑：DSH 退出时 detach() 留着它，下次 start() 先认回来（同一个网关地址、状态接口报的地址对得上），
 * 认不回来才重新起。
 *
 * @param opts.bin       () → cloudflared 路径或 null
 * @param opts.target    () → 网关地址 http://127.0.0.1:<port>
 * @param opts.onChange  (status) => void   地址变了 / 状态变了
 * @param opts.stateFile 记下正在跑的那个：{ pid, metrics, target, url }
 * @param opts.logFile   cloudflared 的输出（出错时从这里捞原因）
 */
export function createTunnel({
  bin,
  target,
  log = () => {},
  onChange = () => {},
  stateFile = '',
  logFile = '',
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  pickPort = freeLocalPort,
  alive = pidAlive,
  verify = isCloudflared,
  kill = (pid) => process.kill(pid),
  pollMs = 500,
  readyMs = 60000,
  watchMs = 10000,
  staleChecks = 12,
}) {
  let wanted = false
  let gen = 0 // start / stop / detach 一次就 +1，进行到一半的异步步骤看到变了就收手
  let proc = null // { pid, metrics, child? }
  let status = { state: 'off', url: '', error: '' }
  let backoff = 2000
  let retry = null
  let poll = null
  let watch = null

  function set(patch) {
    const before = JSON.stringify(status)
    status = { ...status, ...patch }
    if (JSON.stringify(status) !== before) onChange({ ...status })
  }

  function readRec() {
    if (!stateFile) return null
    try {
      const r = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      return r && Number.isInteger(r.pid) ? r : null
    } catch {
      return null
    }
  }
  function writeRec(r) {
    if (!stateFile) return
    try { fs.writeFileSync(stateFile, JSON.stringify(r), { mode: 0o600 }) } catch {}
  }
  function dropRec() {
    if (!stateFile) return
    try { fs.unlinkSync(stateFile) } catch {}
  }

  async function metricsGet(port, p) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 3000)
    try {
      const r = await fetchImpl(`http://127.0.0.1:${port}${p}`, { signal: ctl.signal })
      return await r.json()
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
  const readyOf = (j) => !!j && Number(j.readyConnections) > 0

  /** cloudflared 出错退出时，日志里最后一句像原因的话 */
  function lastError() {
    if (!logFile) return ''
    try {
      const fd = fs.openSync(logFile, 'r')
      const size = fs.fstatSync(fd).size
      const buf = Buffer.alloc(Math.min(size, 8192))
      fs.readSync(fd, buf, 0, buf.length, size - buf.length)
      fs.closeSync(fd)
      const all = buf.toString('utf8').match(/failed to [^\n]+|error="[^"]*"/gi)
      return all ? all[all.length - 1].slice(0, 200) : ''
    } catch {
      return ''
    }
  }

  function clearTimers() {
    if (poll) { clearTimeout(poll); poll = null }
    if (watch) { clearInterval(watch); watch = null }
  }

  /** 把手上的 / tunnel.json 里记着的 cloudflared 杀掉 */
  function killAll() {
    const pids = new Set()
    if (proc) pids.add(proc.pid)
    const rec = readRec()
    if (rec && rec.pid !== (proc && proc.pid)) {
      if (alive(rec.pid) && verify(rec.pid)) pids.add(rec.pid)
    }
    if (proc && proc.child) { try { proc.child.kill() } catch {} ; pids.delete(proc.pid) }
    for (const pid of pids) { try { kill(pid) } catch {} }
    proc = null
    dropRec()
  }

  async function launch() {
    if (!wanted || proc || status.state === 'starting') return
    const my = gen
    const b = bin()
    if (!b) return set({ state: 'missing', url: '', error: '' })
    const t = target()
    if (!t) return set({ state: 'error', url: '', error: 'gateway not running' })
    set({ state: 'starting', url: '', error: '' })
    if (await adopt(t, my)) return
    if (my !== gen) return
    await spawnFresh(b, t, my)
  }

  /** 上次的 cloudflared 还在、连的是同一个网关、地址对得上 → 接着用 */
  async function adopt(t, my) {
    const rec = readRec()
    if (!rec) return false
    let host = ''
    if (rec.target === t && rec.url && alive(rec.pid) && verify(rec.pid)) {
      const j = await metricsGet(rec.metrics, '/quicktunnel')
      host = (j && j.hostname) || ''
    }
    if (my !== gen) return true
    if (!host || `https://${host}` !== rec.url) {
      if (alive(rec.pid) && verify(rec.pid)) { try { kill(rec.pid) } catch {} }
      dropRec()
      return false
    }
    proc = { pid: rec.pid, metrics: rec.metrics }
    log(`接着用上次的隧道：${rec.url}（pid ${rec.pid}）`)
    waitReady(proc, my, rec.url)
    return true
  }

  async function spawnFresh(b, t, my) {
    let metrics
    try { metrics = await pickPort() } catch (e) { return fail(e.message) }
    if (my !== gen) return
    log(`启动隧道：${b} → ${t}`)
    // 用一个空配置：用户自己的 ~/.cloudflared/config.yml 不该影响快速隧道
    const cfg = path.join(os.tmpdir(), 'dsh-mobile-cloudflared.yml')
    try { fs.writeFileSync(cfg, '{}\n') } catch {}
    let out = 'ignore'
    if (logFile) { try { out = fs.openSync(logFile, 'w', 0o600) } catch {} }
    let c
    try {
      // --protocol http2：默认的 QUIC 走 UDP，碰上代理 / 公司网络常常很慢甚至不通，实测 HTTP/2 快好几倍
      // detached + 输出写文件：DSH 退出后它照样跑（输出要是接在管道上，DSH 一走它写日志就会被 SIGPIPE 打死）
      c = spawnImpl(b, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--config', cfg, '--metrics', `127.0.0.1:${metrics}`, '--url', t], {
        detached: true,
        stdio: ['ignore', out, out],
        windowsHide: true,
      })
    } catch (e) {
      return fail(e.message)
    } finally {
      if (typeof out === 'number') { try { fs.closeSync(out) } catch {} }
    }
    if (c.unref) c.unref()
    const p = { pid: c.pid, metrics, child: c }
    proc = p
    writeRec({ pid: c.pid, metrics, target: t, url: '' })
    c.on('error', (e) => gone(p, e.message))
    c.on('exit', (code) => gone(p, `cloudflared exited (${code})`))
    waitReady(p, my, '')
  }

  /** 等它从 Cloudflare 领到地址、至少连上一条线，才算开好（之前手机扫了也打不开） */
  function waitReady(p, my, known) {
    const until = Date.now() + readyMs
    let url = known
    const step = async () => {
      poll = null
      if (my !== gen || proc !== p) return
      if (!url) {
        const j = await metricsGet(p.metrics, '/quicktunnel')
        if (j && j.hostname) url = `https://${j.hostname}`
      }
      const ready = url && readyOf(await metricsGet(p.metrics, '/ready'))
      if (my !== gen || proc !== p) return
      if (ready) {
        backoff = 2000
        writeRec({ ...(readRec() || {}), pid: p.pid, metrics: p.metrics, target: target(), url })
        set({ state: 'on', url, error: '' })
        log(`隧道地址：${url}`)
        return startWatch(p, my)
      }
      if (Date.now() > until) return fail(lastError() || 'tunnel not ready')
      poll = setTimeout(step, pollMs)
      if (poll.unref) poll.unref()
    }
    step()
  }

  /** 开好之后：进程没了就重启；连续很久一条线都没连上（比如 Cloudflare 把隧道收回了）也重启 */
  function startWatch(p, my) {
    let misses = 0
    watch = setInterval(async () => {
      if (my !== gen || proc !== p) return
      if (!alive(p.pid)) return gone(p, 'cloudflared exited')
      const ok = readyOf(await metricsGet(p.metrics, '/ready'))
      if (my !== gen || proc !== p) return
      misses = ok ? 0 : misses + 1
      if (misses >= staleChecks) {
        log('隧道很久没连上 Cloudflare，重启')
        fail('tunnel lost connection')
      }
    }, watchMs)
    if (watch.unref) watch.unref()
  }

  function gone(p, msg) {
    if (proc !== p) return
    proc = null
    clearTimers()
    dropRec()
    if (wanted) fail(lastError() || msg)
    else set({ state: 'off', url: '', error: '' })
  }

  function fail(msg) {
    clearTimers()
    killAll()
    set({ state: 'error', url: '', error: String(msg).slice(0, 200) })
    log(`隧道出错：${msg}；${Math.round(backoff / 1000)} 秒后重试`)
    if (!wanted || retry) return
    retry = setTimeout(() => { retry = null; launch() }, backoff)
    if (retry.unref) retry.unref()
    backoff = Math.min(backoff * 2, 60000)
  }

  function start() {
    if (wanted && (proc || status.state === 'starting')) return { ...status }
    wanted = true
    backoff = 2000
    launch()
    return { ...status }
  }

  /** 关掉：连上次留下的一起杀 */
  function stop() {
    wanted = false
    gen++
    if (retry) { clearTimeout(retry); retry = null }
    clearTimers()
    killAll()
    set({ state: 'off', url: '', error: '' })
  }

  /** DSH 要退出了：开好的隧道留着给下次接着用；没开好的照常杀掉。返回是否留下了 */
  function detach() {
    const keep = !!proc && status.state === 'on'
    if (!keep) { stop(); return false }
    wanted = false
    gen++
    if (retry) { clearTimeout(retry); retry = null }
    clearTimers()
    log(`DSH 退出，隧道留着下次接着用（pid ${proc.pid}）`)
    proc = null
    return true
  }

  return {
    start,
    stop,
    detach,
    get status() { return { ...status } },
    get wanted() { return wanted },
  }
}
