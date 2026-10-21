// 隧道管理：用假的 cloudflared 进程测「拿到地址 → 掉了重启 → 关掉」，不连网
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTunnel, assetFor, killStale, downloadCloudflared, cloudflaredCmdMatches } from '../lib/tunnel.js'

// 假的 cloudflared：进程 + 它的本机状态接口（/quicktunnel、/ready）+ 进程表
function fakeWorld() {
  const kids = []
  const metrics = new Map() // port → { hostname, ready }
  const alive = new Set()
  const killed = []
  let nextPid = 5000
  let nextPort = 30000
  const spawnImpl = (bin, args, opts) => {
    const c = new EventEmitter()
    c.pid = nextPid++
    c.args = args
    c.opts = opts
    c.unref = () => {}
    c.kill = () => { alive.delete(c.pid); setImmediate(() => c.emit('exit', 0)) }
    alive.add(c.pid)
    kids.push(c)
    return c
  }
  const fetchImpl = async (url) => {
    const u = new URL(url)
    const m = metrics.get(Number(u.port))
    if (!m) throw new Error('ECONNREFUSED')
    const body = u.pathname === '/quicktunnel' ? { hostname: m.hostname } : { status: m.ready ? 200 : 503, readyConnections: m.ready ? 4 : 0 }
    return { json: async () => body }
  }
  const metricsPort = (c) => Number(c.args[c.args.indexOf('--metrics') + 1].split(':')[1])
  const opts = (dir, extra = {}) => ({
    bin: () => '/x/cloudflared',
    target: () => 'http://127.0.0.1:18765',
    stateFile: path.join(dir, 'tunnel.json'),
    logFile: path.join(dir, 'cloudflared.log'),
    spawnImpl,
    fetchImpl,
    pickPort: async () => nextPort++,
    alive: (pid) => alive.has(pid),
    verify: () => true,
    kill: (pid) => { killed.push(pid); alive.delete(pid) },
    pollMs: 5,
    ...extra,
  })
  return { kids, metrics, alive, killed, opts, metricsPort }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout')
    await tick(5)
  }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-tun-'))
const readRec = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'tunnel.json'), 'utf8'))

test('起隧道：单独跑、输出写文件；状态接口报了地址且连上线才算开好；进程掉了自动重启；关掉就杀', async () => {
  const dir = tmp()
  const w = fakeWorld()
  const changes = []
  const t = createTunnel(w.opts(dir, { onChange: (s) => changes.push(s) }))
  t.start()
  assert.equal(t.status.state, 'starting')
  await until(() => w.kids.length === 1)
  const c = w.kids[0]
  assert.deepEqual(c.args.slice(0, 4), ['tunnel', '--no-autoupdate', '--protocol', 'http2'])
  assert.equal(c.args.at(-1), 'http://127.0.0.1:18765')
  assert.equal(c.opts.detached, true)
  assert.equal(typeof c.opts.stdio[1], 'number', '输出接文件，不接管道')

  w.metrics.set(w.metricsPort(c), { hostname: 'some-words-here.trycloudflare.com', ready: false })
  await tick(30)
  assert.equal(t.status.state, 'starting', '还没连上线不算开好')
  w.metrics.get(w.metricsPort(c)).ready = true
  await until(() => t.status.state === 'on')
  assert.equal(t.status.url, 'https://some-words-here.trycloudflare.com')
  assert.deepEqual(readRec(dir), { pid: c.pid, metrics: w.metricsPort(c), target: 'http://127.0.0.1:18765', url: 'https://some-words-here.trycloudflare.com' })

  w.alive.delete(c.pid)
  c.emit('exit', 1)
  assert.equal(t.status.state, 'error')
  await new Promise((r) => setTimeout(r, 2100))
  assert.equal(w.kids.length, 2)
  t.stop()
  await tick()
  assert.equal(t.status.state, 'off')
  assert.equal(fs.existsSync(path.join(dir, 'tunnel.json')), false)
  assert.ok(changes.some((s) => s.state === 'on'))
  fs.rmSync(dir, { recursive: true, force: true })
})

async function runningTunnel(w, dir, host = 'kept-words.trycloudflare.com') {
  const t = createTunnel(w.opts(dir))
  t.start()
  await until(() => w.kids.length > 0)
  const c = w.kids.at(-1)
  w.metrics.set(w.metricsPort(c), { hostname: host, ready: true })
  await until(() => t.status.state === 'on')
  return { t, c }
}

test('DSH 退出时留着隧道，下次启动认回来：不重起、地址不变；关掉手机访问才杀', async () => {
  const dir = tmp()
  const w = fakeWorld()
  const { t, c } = await runningTunnel(w, dir)
  assert.equal(t.detach(), true)
  assert.deepEqual(w.killed, [])
  assert.ok(w.alive.has(c.pid))

  const t2 = createTunnel(w.opts(dir))
  t2.start()
  await until(() => t2.status.state === 'on')
  assert.equal(w.kids.length, 1, '没有重新起 cloudflared')
  assert.equal(t2.status.url, 'https://kept-words.trycloudflare.com')

  t2.stop()
  assert.deepEqual(w.killed, [c.pid])
  assert.equal(fs.existsSync(path.join(dir, 'tunnel.json')), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('认不回来就杀掉旧的重起：网关端口换了 / 状态接口报的地址对不上', async () => {
  for (const breakIt of [
    (w, c, extra) => { extra.target = () => 'http://127.0.0.1:19999' },
    (w, c) => { w.metrics.get(w.metricsPort(c)).hostname = 'other.trycloudflare.com' },
    (w, c) => { w.metrics.delete(w.metricsPort(c)) },
  ]) {
    const dir = tmp()
    const w = fakeWorld()
    const { t, c } = await runningTunnel(w, dir)
    t.detach()
    const extra = {}
    breakIt(w, c, extra)
    const t2 = createTunnel(w.opts(dir, extra))
    t2.start()
    await until(() => w.kids.length === 2)
    assert.deepEqual(w.killed, [c.pid])
    t2.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('认回来的进程后来没了：发现后重起', async () => {
  const dir = tmp()
  const w = fakeWorld()
  const { t, c } = await runningTunnel(w, dir)
  t.detach()
  const t2 = createTunnel(w.opts(dir, { watchMs: 10 }))
  t2.start()
  await until(() => t2.status.state === 'on')
  w.alive.delete(c.pid)
  await until(() => t2.status.state === 'error')
  await until(() => w.kids.length === 2, 3000) // 按退避 2 秒后重起
  t2.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('开好之后很久一条线都没连上：重起', async () => {
  const dir = tmp()
  const w = fakeWorld()
  const t = createTunnel(w.opts(dir, { watchMs: 5, staleChecks: 3 }))
  t.start()
  await until(() => w.kids.length === 1)
  const c = w.kids[0]
  w.metrics.set(w.metricsPort(c), { hostname: 'a.trycloudflare.com', ready: true })
  await until(() => t.status.state === 'on')
  w.metrics.get(w.metricsPort(c)).ready = false
  await until(() => t.status.state === 'error')
  assert.ok(!w.alive.has(c.pid), '旧进程被杀')
  t.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('迟迟开不好：报日志里的原因，杀掉', async () => {
  const dir = tmp()
  const w = fakeWorld()
  const t = createTunnel(w.opts(dir, { readyMs: 40 }))
  t.start()
  await until(() => w.kids.length === 1)
  fs.writeFileSync(path.join(dir, 'cloudflared.log'), 'INF hi\nERR failed to request quick tunnel: 429 Too Many Requests\n')
  await until(() => t.status.state === 'error')
  assert.equal(t.status.error, 'failed to request quick tunnel: 429 Too Many Requests')
  assert.ok(!w.alive.has(w.kids[0].pid))
  t.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('不打算用外网时 stop()：上次留下的也收掉', async () => {
  const dir = tmp()
  const w = fakeWorld()
  const { t, c } = await runningTunnel(w, dir)
  t.detach()
  createTunnel(w.opts(dir)).stop()
  assert.deepEqual(w.killed, [c.pid])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('没有 cloudflared：状态是 missing，不启动', () => {
  const w = fakeWorld()
  const t = createTunnel({ ...w.opts(tmp()), bin: () => null })
  t.start()
  assert.equal(t.status.state, 'missing')
  assert.equal(w.kids.length, 0)
  t.stop()
})

test('下载文件名', () => {
  assert.deepEqual(assetFor('darwin', 'arm64'), { name: 'cloudflared-darwin-arm64.tgz', tgz: true })
  assert.deepEqual(assetFor('darwin', 'x64'), { name: 'cloudflared-darwin-amd64.tgz', tgz: true })
  assert.deepEqual(assetFor('win32', 'x64'), { name: 'cloudflared-windows-amd64.exe', tgz: false })
  assert.deepEqual(assetFor('linux', 'arm64'), { name: 'cloudflared-linux-arm64', tgz: false })
  assert.equal(assetFor('aix', 'ppc64'), null)
})

test('残留进程：pid 文件指向的不是 cloudflared 就不杀', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-tun-'))
  const f = path.join(dir, 'cloudflared.pid')
  fs.writeFileSync(f, String(process.pid))
  assert.equal(killStale(f), false)
  assert.equal(fs.existsSync(f), false)
  assert.equal(killStale(f), false) // 没有 pid 文件
  fs.rmSync(dir, { recursive: true, force: true })
})

test('cloudflared 的空配置放在数据目录（0600）；写不进去就不起', async () => {
  const dir = tmp()
  const w = fakeWorld()
  const t = createTunnel(w.opts(dir))
  t.start()
  await until(() => w.kids.length === 1)
  const c = w.kids[0]
  const cfg = c.args[c.args.indexOf('--config') + 1]
  assert.equal(cfg, path.join(dir, 'cloudflared.yml'))
  assert.equal(fs.readFileSync(cfg, 'utf8'), '{}\n')
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600)
  t.stop()

  const bad = createTunnel(w.opts(dir, { configFile: dir })) // 是个目录，写不进去
  bad.start()
  await until(() => bad.status.state === 'error')
  assert.match(bad.status.error, /config/)
  assert.equal(w.kids.length, 1, '没起 cloudflared')
  bad.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('杀之前核对命令行：--metrics 端口和 --url 都对得上才杀；接管来的也一样', async () => {
  const dir = tmp()
  const w = fakeWorld()
  const { t, c } = await runningTunnel(w, dir)
  t.detach()
  const asked = []
  let ok = true
  const t2 = createTunnel(w.opts(dir, { verify: (pid, exp) => { asked.push({ pid, ...exp }); return ok } }))
  t2.start()
  await until(() => t2.status.state === 'on')
  assert.equal(w.kids.length, 1, '认回来了')
  assert.ok(asked.length > 0)
  for (const a of asked) assert.deepEqual(a, { pid: c.pid, metrics: w.metricsPort(c), target: 'http://127.0.0.1:18765' })
  ok = false // 比如 pid 已经被别的程序复用了
  t2.stop()
  assert.deepEqual(w.killed, [], '对不上就不杀')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('命令行核对', () => {
  const cmd = '/opt/homebrew/bin/cloudflared tunnel --no-autoupdate --protocol http2 --config /Users/a b/.dsh/dsh-mobile/cloudflared.yml --metrics 127.0.0.1:30001 --url http://127.0.0.1:18765'
  const target = 'http://127.0.0.1:18765'
  assert.equal(cloudflaredCmdMatches(cmd, { metrics: 30001, target }), true)
  assert.equal(cloudflaredCmdMatches(cmd, { metrics: 3000, target }), false)
  assert.equal(cloudflaredCmdMatches(cmd, { metrics: 30001, target: 'http://127.0.0.1:1876' }), false)
  assert.equal(cloudflaredCmdMatches(cmd, { metrics: 30001, target: 'http://127.0.0.1:18766' }), false)
  assert.equal(cloudflaredCmdMatches(cmd), true)
  assert.equal(cloudflaredCmdMatches('/usr/bin/vim --url x'), false)
  assert.equal(cloudflaredCmdMatches('/x/cloudflared tunnel login'), false)
})

test('下载 cloudflared 时写盘出错 / 正文中途断了：报错（不卡住、不冒未处理异常），不留半截文件', async () => {
  if (!assetFor()) return
  const part = (dir) => path.join(dir, `.${assetFor().name}.${process.pid}.part`)
  const fetchOf = (gen) => async () => ({ ok: true, status: 200, headers: { get: () => null }, body: gen() })
  const within = (p) => Promise.race([p.then(() => 'resolved', (e) => `rejected:${e.code || e.message}`), new Promise((r) => setTimeout(() => r('hung'), 2000))])
  const uncaught = []
  const onUncaught = (e) => uncaught.push(e)
  process.on('uncaughtException', onUncaught)
  try {
    // 1) .part 的位置是个目录：一打开就失败（空正文 / 大正文触发背压两种）
    for (const chunks of [[], [Buffer.alloc(1 << 20), Buffer.alloc(1 << 20), Buffer.alloc(1 << 20)]]) {
      const dir = tmp()
      fs.mkdirSync(part(dir))
      const r = await within(downloadCloudflared(dir, { fetchImpl: fetchOf(async function* () { for (const c of chunks) { yield c; await tick(5) } }) }))
      assert.equal(r, 'rejected:EISDIR')
      fs.rmSync(dir, { recursive: true, force: true })
    }
    // 2) 正文第一块都没到就断了：不留半截文件（写入流还在打开时就出错）
    for (const sync of [true, false]) {
      const d = tmp()
      const r = await within(downloadCloudflared(d, { fetchImpl: fetchOf(async function* () { if (!sync) await Promise.resolve(); throw new Error('socket hang up') }) }))
      assert.equal(r, 'rejected:socket hang up')
      await tick(50)
      assert.deepEqual(fs.readdirSync(d), [])
      fs.rmSync(d, { recursive: true, force: true })
    }
    // 3) 正文下到一半断了
    const dir = tmp()
    const got = []
    const r = await within(downloadCloudflared(dir, {
      onProgress: (p) => got.push(p.got),
      fetchImpl: fetchOf(async function* () { yield Buffer.alloc(1000); await tick(5); throw new Error('socket hang up') }),
    }))
    assert.equal(r, 'rejected:socket hang up')
    assert.deepEqual(got, [1000])
    assert.equal(fs.existsSync(part(dir)), false)
    fs.rmSync(dir, { recursive: true, force: true })
    await tick(50)
    assert.deepEqual(uncaught, [])
  } finally {
    process.off('uncaughtException', onUncaught)
  }
})
