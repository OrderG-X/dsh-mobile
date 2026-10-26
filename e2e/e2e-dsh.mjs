/**
 * 真机端到端：装进一个全新的 DSH，把「手机访问」整条路走一遍
 *   ① 打包插件，装进全新的 DSH（dsh plugin add），起网页版；设置页接口能用
 *   ② 打开手机访问：网关起来；没配对只给配对页；配对码换设备 Cookie；配好后看到的是 DSH 的网页（插了 boot.js）
 *   ③ 外网：自动下载 cloudflared、起 Cloudflare 快速隧道；从公网地址打开、配对、看到 DSH 的网页
 *   ④ DSH 重启：隧道认回来、地址不变，配过的手机不用重扫
 *   ⑤ 关掉手机访问：cloudflared 一起收掉
 *
 *   node e2e/e2e-dsh.mjs [--dsh latest|next|<版本>]
 * DSH_HOME 总是临时的；本地跑（没有 CI 环境变量）时 HOME 也换成临时的。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import dns from 'node:dns'
import { spawn, spawnSync, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const DSH_SPEC = argv.includes('--dsh') ? argv[argv.indexOf('--dsh') + 1] : 'latest'
const REGISTRY = 'https://registry.npmjs.org/'
const WIN = process.platform === 'win32'
const OS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] || process.platform
const LOCAL = !process.env.CI
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-e2e-')))
if (LOCAL) {
  process.env.HOME = process.env.USERPROFILE = path.join(tmp, 'home')
  fs.mkdirSync(process.env.HOME, { recursive: true })
}
const DSH_HOME = path.join(tmp, 'dsh-home')
const DATA = path.join(DSH_HOME, 'dsh-mobile')
const env = { ...process.env, DSH_HOME, npm_config_registry: REGISTRY }
const PATH_KEY = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH'
env[PATH_KEY] = `${path.join(tmp, 'cli', 'node_modules', '.bin')}${path.delimiter}${env[PATH_KEY]}`
const npm = WIN ? 'npm.cmd' : 'npm'
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { env, encoding: 'utf8', maxBuffer: 64 << 20, shell: WIN && cmd === npm, ...opts })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

// ── 结果 ──
const results = []
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond, extra: cond ? '' : String(extra) })
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${extra}`}`)
  return !!cond
}
const failed = () => results.filter((r) => !r.ok)

/** 不用 fetch：要自己定 Origin、拿原样的 Set-Cookie */
// 新隧道的域名刚建出来时，跑测试的机器的 DNS 可能把「查不到」缓存好几分钟（CI 的 macOS 上见过）：
// trycloudflare 的域名直接问公共 DNS，问不到再走系统
const pubDns = new dns.Resolver()
pubDns.setServers(['1.1.1.1', '8.8.8.8'])
function lookup(host, opts, cb) {
  if (!/\.trycloudflare\.com$/i.test(host)) return dns.lookup(host, opts, cb)
  pubDns.resolve4(host, (err, ips) => {
    if (err || !ips.length) return dns.lookup(host, opts, cb)
    if (opts.all) cb(null, ips.map((address) => ({ address, family: 4 })))
    else cb(null, ips[0], 4)
  })
}

function req(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    const r = (u.protocol === 'https:' ? https : http).request(u, {
      method,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers },
      timeout: 30000,
      lookup,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        let buf = Buffer.concat(chunks)
        try { if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf) } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8') })
      })
      res.on('error', reject)
    })
    r.on('timeout', () => r.destroy(new Error('timeout')))
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
}
const cookieFrom = (res, name) => [].concat(res.headers['set-cookie'] || []).map((s) => String(s).split(';')[0].trim()).find((s) => s.startsWith(`${name}=`)) || ''
const codeOf = (url) => (/#pair=([^&]+)/.exec(url || '') || [])[1] || ''
const HTML = { accept: 'text/html', 'sec-fetch-dest': 'document' }

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
const tunnelPid = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'tunnel.json'), 'utf8')).pid } catch { return null } }
const tail = (file, n = 30) => { try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n') } catch { return `（没有 ${path.basename(file)}）` } }

// ── DSH 网页版 ──
let cliDir = ''
let dshVersion = DSH_SPEC
let web = null
let webLog = ''
let origin = ''
let auth = {}
let cfPid = null

async function startWeb() {
  webLog = ''
  const url = await new Promise((resolve) => {
    web = spawn(process.execPath, [path.join(cliDir, 'lib', 'bin.js'), 'web', '--no-open', '--port', '0', '--host', '127.0.0.1'], { env, cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] })
    const on = (d) => { webLog = (webLog + d).slice(-50000); const m = /dsh web: (http:\/\/\S+)/.exec(webLog); if (m) resolve(m[1]) }
    web.stdout.on('data', on)
    web.stderr.on('data', on)
    web.on('exit', () => resolve(null))
    setTimeout(() => resolve(null), 180_000)
  })
  if (!url) return false
  const u = new URL(url)
  origin = u.origin
  const first = await req(url)
  const cookie = [].concat(first.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ')
  const token = u.searchParams.get('token')
  auth = { ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }
  return true
}

/** 只停 DSH 本身（不连带子进程）：cloudflared 是单独跑的，DSH 退出后应该还在 */
async function stopWeb() {
  if (!web || web.exitCode !== null) return
  const done = new Promise((r) => web.once('exit', r))
  web.kill('SIGTERM') // Windows 上等于直接结束进程：走的是「DSH 被强关」那条路，下次启动一样要认回隧道
  await Promise.race([done, sleep(15000)])
  if (web.exitCode === null) { try { web.kill('SIGKILL') } catch {} }
  await sleep(1000)
}

async function panel(body) {
  const r = await req(`${origin}/dsh-mobile/panel`, { method: body ? 'POST' : 'GET', headers: auth, body })
  if (r.status !== 200) throw new Error(`设置页接口 HTTP ${r.status} ${r.text.slice(0, 200)}`)
  return JSON.parse(r.text)
}

async function waitPanel(ms = 60000) {
  const until = Date.now() + ms
  let last = ''
  while (Date.now() < until) {
    try { return await panel() } catch (e) { last = e.message }
    await sleep(1000)
  }
  throw new Error(`设置页接口一直没好：${last}`)
}

async function waitTunnel(ms) {
  const until = Date.now() + ms
  let st = null
  while (Date.now() < until) {
    st = await panel()
    if (st.tunnel.state === 'on' && st.tunnel.base) return st
    await sleep(2000)
  }
  throw new Error(`隧道没起来：${JSON.stringify(st && st.tunnel)}`)
}

/** 新起的快速隧道，公网 DNS 要过一会儿才生效：重试到能打开为止 */
async function openPublic(url, headers, ms = 120000) {
  const until = Date.now() + ms
  let last = ''
  while (Date.now() < until) {
    try {
      const r = await req(url, { headers })
      if (r.status < 500 && r.status !== 404) return r
      last = `HTTP ${r.status}`
    } catch (e) { last = e.message }
    await sleep(3000)
  }
  throw new Error(`公网地址打不开：${last}`)
}

/** 手机配对：拿配对码换设备 Cookie */
async function pair(base, code) {
  const r = await req(`${base}/__dshm/pair`, { method: 'POST', headers: { origin: base }, body: { code } })
  return { status: r.status, cookie: cookieFrom(r, 'dshm'), body: r.text }
}

try {
  // ① 打包、装 DSH、装插件、起网页版
  fs.mkdirSync(path.join(tmp, 'cli'), { recursive: true })
  const pack = run(npm, ['pack', '--pack-destination', tmp, '--silent'], { cwd: ROOT })
  const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'))
  if (!check('打包插件', pack.code === 0 && tgz, pack.out.slice(-500))) throw new Error('打包失败')

  fs.writeFileSync(path.join(tmp, 'cli', 'package.json'), '{"private":true}')
  const inst = run(npm, ['i', `@deepseek-ai/dsh@${DSH_SPEC}`, 'pnpm@11', `--registry=${REGISTRY}`, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: path.join(tmp, 'cli') })
  if (!check(`装 DSH ${DSH_SPEC}`, inst.code === 0, inst.out.slice(-1500))) throw new Error('DSH 没装上')
  cliDir = path.join(tmp, 'cli', 'node_modules', '@deepseek-ai', 'dsh')
  dshVersion = JSON.parse(fs.readFileSync(path.join(cliDir, 'package.json'), 'utf8')).version
  console.log(`  DSH ${dshVersion}`)

  const add = run(process.execPath, [path.join(cliDir, 'lib', 'bin.js'), 'plugin', '--profile', 'web', 'add', path.join(tmp, tgz)], { cwd: tmp })
  if (!check('DSH 装上插件', add.code === 0, add.out.slice(-1500))) throw new Error('插件没装上')
  if (!check('DSH 网页版起来了', await startWeb(), webLog.slice(-2000))) throw new Error('网页版没起来')

  let st = await waitPanel()
  check('设置页接口能用、版本对', st.pkg === PKG.name && st.plugin === PKG.version, `${st.pkg}@${st.plugin}`)
  check('默认没开手机访问', st.enabled === false && st.running === false, JSON.stringify({ enabled: st.enabled, running: st.running }))
  const noAuth = await req(`${origin}/dsh-mobile/panel`)
  check('设置页接口不登录不给看（配对码在里面）', noAuth.status === 401 || noAuth.status === 403, `HTTP ${noAuth.status}`)

  // ② 打开手机访问，走局域网那条
  st = await panel({ action: 'enable', on: true })
  if (!check('打开手机访问：网关起来了', st.enabled && st.running && st.port > 0, JSON.stringify({ enabled: st.enabled, running: st.running, port: st.port }))) throw new Error('网关没起来')
  check('局域网二维码有了', st.lan.url && st.lan.qr, JSON.stringify(st.lan).slice(0, 200))
  const lan = `http://127.0.0.1:${st.port}`
  const page = await req(`${lan}/`, { headers: HTML })
  check('没配对：打开是配对页', page.status === 200 && /__dshm\/pair/.test(page.text), `HTTP ${page.status} ${page.text.slice(0, 120)}`)
  const api = await req(`${lan}/api/`)
  check('没配对：别的请求一律 401', api.status === 401, `HTTP ${api.status}`)
  const bad = await pair(lan, 'wrong-code')
  check('配对码不对 → 拒绝', bad.status === 403 && !bad.cookie, `HTTP ${bad.status}`)

  const lanCode = codeOf(st.lan.url)
  const good = await pair(lan, lanCode)
  check('配对码换到设备 Cookie', good.status === 200 && good.cookie, `HTTP ${good.status} ${good.body.slice(0, 200)}`)
  const again = await pair(lan, lanCode)
  check('配对码只能用一次', again.status === 403, `HTTP ${again.status}`)
  const home = await req(`${lan}/`, { headers: { ...HTML, cookie: good.cookie } })
  check('配好后看到的是 DSH 的网页（插了 boot.js）', home.status === 200 && home.text.includes('/__dshm/boot.js'), `HTTP ${home.status} ${home.text.slice(0, 200)}`)
  const me = await req(`${lan}/__dshm/me`, { headers: { cookie: good.cookie } })
  check('设备凭证有效', me.status === 200 && JSON.parse(me.text).device, `HTTP ${me.status}`)
  const inner = await req(`${lan}/dsh-mobile/panel`, { headers: { cookie: good.cookie } })
  check('手机碰不到插件自己的接口（里面有配对码）', inner.status === 403, `HTTP ${inner.status}`)

  // ③ 外网：下载 cloudflared、起快速隧道、从公网打开
  st = await waitTunnel(300000)
  const base = st.tunnel.base
  cfPid = tunnelPid()
  console.log(`  隧道 ${base}（pid ${cfPid}）`)
  check('外网隧道起来了（自动下载 cloudflared）', /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(base) && st.tunnel.installed, JSON.stringify(st.tunnel).slice(0, 300))
  check('外网二维码有了', st.tunnel.url && st.tunnel.qr, st.tunnel.url)
  const pub = await openPublic(`${base}/`, HTML)
  check('公网地址打开是配对页', pub.status === 200 && /__dshm\/pair/.test(pub.text), `HTTP ${pub.status} ${pub.text.slice(0, 120)}`)
  st = await panel({ action: 'newCode' })
  const phone = await pair(base, codeOf(st.tunnel.url))
  check('从公网配对成功', phone.status === 200 && phone.cookie, `HTTP ${phone.status} ${phone.body.slice(0, 200)}`)
  const pubHome = await req(`${base}/`, { headers: { ...HTML, cookie: phone.cookie, 'accept-encoding': 'gzip' } })
  check('从公网看到 DSH 的网页', pubHome.status === 200 && pubHome.text.includes('/__dshm/boot.js'), `HTTP ${pubHome.status} ${pubHome.text.slice(0, 200)}`)
  check('外网的网页压缩过（电脑上行是瓶颈）', pubHome.headers['content-encoding'] === 'gzip', pubHome.headers['content-encoding'] || '没压缩')
  st = await panel()
  check('设置页列出两台设备（一台局域网、一台外网）', st.devices.length === 2 && st.devices.some((d) => d.via === 'tunnel'), JSON.stringify(st.devices.map((d) => d.via)))

  // ④ DSH 重启：隧道认回来，地址不变，手机不用重扫
  await stopWeb()
  check('DSH 退出后 cloudflared 还在跑', pidAlive(cfPid), `pid ${cfPid}`)
  if (!check('DSH 重新起来了', await startWeb(), webLog.slice(-2000))) throw new Error('网页版没再起来')
  st = await waitPanel()
  st = await waitTunnel(120000)
  check('重启后外网地址不变', st.tunnel.base === base, `${st.tunnel.base} ≠ ${base}`)
  check('接着用的是同一个 cloudflared', tunnelPid() === cfPid, `${tunnelPid()} ≠ ${cfPid}`)
  const back = await openPublic(`${base}/__dshm/me`, { cookie: phone.cookie }, 60000)
  check('配过的手机不用重扫', back.status === 200, `HTTP ${back.status}`)

  // ⑤ 关掉手机访问：cloudflared 一起收掉
  st = await panel({ action: 'enable', on: false })
  check('关掉后网关停了', !st.running, JSON.stringify({ running: st.running }))
  let gone = false
  for (let i = 0; i < 20 && !(gone = !pidAlive(cfPid)); i++) await sleep(500)
  check('关掉后 cloudflared 也退出了', gone, `pid ${cfPid}`)
} catch (e) {
  check('没有异常', false, (e && e.stack) || e)
} finally {
  if (failed().length) {
    console.log(`\n── 插件日志 ──\n${tail(path.join(DATA, 'mobile.log'), 40)}`)
    console.log(`\n── cloudflared 日志 ──\n${tail(path.join(DATA, 'cloudflared.log'), 20)}`)
    console.log(`\n── DSH 网页版日志 ──\n${webLog.split('\n').slice(-30).join('\n')}`)
  }
  if (web && web.exitCode === null) {
    if (WIN) await new Promise((r) => execFile('taskkill', ['/pid', String(web.pid), '/T', '/F'], () => r()))
    else web.kill('SIGTERM')
  }
  for (const pid of new Set([cfPid, tunnelPid()])) if (pidAlive(pid)) { try { process.kill(pid) } catch {} }
  await sleep(1500)
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) } catch {}
  const title = `手机端真机测试 · ${OS} · DSH ${dshVersion}`
  const md = [`## ${title}`, '', ...results.map((r) => `- ${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `：${r.extra.split('\n')[0]}`}`), '']
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md.join('\n')}\n`)
  console.log(failed().length ? `\n❌ ${failed().length} 项没过` : '\n✅ 全部通过')
  process.exit(failed().length ? 1 : 0)
}
