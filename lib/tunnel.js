/**
 * 出门也能用：Cloudflare 免费快速隧道（trycloudflare.com），不用注册账号、不用公网 IP。
 *
 *   cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:<网关端口>
 *   → 打印 https://<随机词>.trycloudflare.com，外网的手机走 HTTPS 连到网关
 *
 * 隧道只是一条路：门禁照旧是网关的配对 + 设备 Cookie，没配对的从外网也只能看到配对页。
 * 每次起隧道地址都会变（快速隧道的规矩），所以 DSH 重启后外网要重新扫一次码。
 * cloudflared 优先用系统里装好的；没有就下载 Cloudflare 官方 GitHub 发布的那个（用户在设置页点了才下）。
 */

import { spawn, execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
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

/**
 * 管一个 cloudflared 进程：开着就保持开着（掉了按 2s→60s 退避重启），关掉就杀掉。
 * @param opts.bin      () → cloudflared 路径或 null
 * @param opts.target   () → 网关地址 http://127.0.0.1:<port>
 * @param opts.onChange (status) => void   地址变了 / 状态变了
 */
/**
 * 上次 DSH 没正常退出（崩溃、强退）时留下的 cloudflared：按 pid 文件找到它，确认真是 cloudflared 再杀掉。
 */
export function killStale(pidFile, log = () => {}) {
  let pid
  try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()) } catch { return false }
  try { fs.unlinkSync(pidFile) } catch {}
  if (!Number.isInteger(pid) || pid <= 1 || process.platform === 'win32') return false
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
    if (!/cloudflared/.test(cmd) || !/trycloudflare|--url/.test(cmd)) return false
    process.kill(pid)
    log(`清掉上次留下的 cloudflared（pid ${pid}）`)
    return true
  } catch {
    return false
  }
}

export function createTunnel({ bin, target, log = () => {}, onChange = () => {}, spawnImpl = spawn, pidFile = '' }) {
  if (pidFile) killStale(pidFile, log)
  let wanted = false
  let child = null
  let status = { state: 'off', url: '', error: '' }
  let backoff = 2000
  let retry = null

  function set(patch) {
    const before = JSON.stringify(status)
    status = { ...status, ...patch }
    if (JSON.stringify(status) !== before) onChange({ ...status })
  }

  function launch() {
    if (!wanted || child) return
    const b = bin()
    if (!b) return set({ state: 'missing', url: '', error: '' })
    const t = target()
    if (!t) return set({ state: 'error', url: '', error: 'gateway not running' })
    set({ state: 'starting', url: '', error: '' })
    log(`启动隧道：${b} → ${t}`)
    // 用一个空配置：用户自己的 ~/.cloudflared/config.yml 不该影响快速隧道
    const cfg = path.join(os.tmpdir(), 'dsh-mobile-cloudflared.yml')
    try { fs.writeFileSync(cfg, '{}\n') } catch {}
    let c
    try {
      // --protocol http2：默认的 QUIC 走 UDP，碰上代理 / 公司网络常常很慢甚至不通，实测 HTTP/2 快好几倍
      c = spawnImpl(b, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--config', cfg, '--url', t], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      return fail(e.message)
    }
    child = c
    if (pidFile && c.pid) { try { fs.writeFileSync(pidFile, String(c.pid)) } catch {} }
    let buf = ''
    const onData = (d) => {
      buf = (buf + d.toString()).slice(-8192)
      const m = URL_RE.exec(buf)
      if (m && status.url !== m[0]) {
        backoff = 2000
        set({ state: 'on', url: m[0], error: '' })
        log(`隧道地址：${m[0]}`)
      }
      if (/failed to (request|create) quick tunnel|error="[^"]*"/i.test(buf) && status.state === 'starting') {
        const e = /(failed to [^\n]+|error="[^"]*")/i.exec(buf)
        if (e) status.error = e[1].slice(0, 200)
      }
    }
    c.stdout.on('data', onData)
    c.stderr.on('data', onData)
    c.on('error', (e) => { child = null; fail(e.message) })
    c.on('exit', (code) => {
      if (pidFile) { try { if (fs.readFileSync(pidFile, 'utf8').trim() === String(c.pid)) fs.unlinkSync(pidFile) } catch {} }
      if (child !== c) return
      child = null
      if (wanted) fail(status.error || `cloudflared exited (${code})`)
      else set({ state: 'off', url: '', error: '' })
    })
  }

  function fail(msg) {
    set({ state: 'error', url: '', error: String(msg).slice(0, 200) })
    log(`隧道出错：${msg}；${Math.round(backoff / 1000)} 秒后重试`)
    if (!wanted || retry) return
    retry = setTimeout(() => { retry = null; launch() }, backoff)
    if (retry.unref) retry.unref()
    backoff = Math.min(backoff * 2, 60000)
  }

  function start() {
    wanted = true
    backoff = 2000
    launch()
    return { ...status }
  }

  function stop() {
    wanted = false
    if (retry) { clearTimeout(retry); retry = null }
    if (child) {
      const c = child
      child = null
      try { c.kill() } catch {}
    }
    set({ state: 'off', url: '', error: '' })
  }

  return {
    start,
    stop,
    get status() { return { ...status } },
    get wanted() { return wanted },
  }
}
