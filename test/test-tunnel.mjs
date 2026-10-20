// 隧道管理：用假的 cloudflared 进程测「拿到地址 → 掉了重启 → 关掉」，不连网
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTunnel, assetFor, killStale } from '../lib/tunnel.js'

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
