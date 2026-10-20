// 网关 + 配对的脚本测试：起一个假的 DSH（有启动口令 → Cookie、Host/Origin 围栏、事件流、WebSocket），
// 让网关对着它转发。node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { createGateway, COOKIE, upstreamHeaders, downstreamHeaders, phoneCookies, sameOrigin, wsTracker, shouldGzip } from '../lib/gateway.js'
import zlib from 'node:zlib'
import { BOOT_TAG, injectBoot } from '../lib/pages.js'

const TOKEN = 'launch-token-xyz'

/** 假 DSH：跟真的一样，没登录 Cookie 一律 401，Host 不是 127.0.0.1 或 Origin 不同源一律 403 */
function fakeDsh() {
  let secret = 'v1'
  const seen = []
  const server = http.createServer((req, res) => {
    const port = server.address().port
    const u = new URL(req.url, 'http://x')
    seen.push({ url: req.url, headers: req.headers })
    if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403); return res.end('host') }
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) { res.writeHead(403); return res.end('origin') }
    if (u.pathname === '/' && u.searchParams.get('token') === TOKEN) {
      res.writeHead(303, { location: './', 'set-cookie': `dsh-auth-abc=${secret}; Path=/; HttpOnly; SameSite=Strict` })
      return res.end()
    }
    if (!String(req.headers.cookie || '').includes(`dsh-auth-abc=${secret}`)) { res.writeHead(401); return res.end('unauthorized') }
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end('<!doctype html><html><head><meta charset="utf-8"><title>DSH</title></head><body><div id="root"></div></body></html>')
    }
    if (u.pathname === '/assets/index-AbCd1234.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      return res.end('console.log(1);'.repeat(2000))
    }
    if (u.pathname === '/api/echo') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ headers: req.headers }))
    }
    if (u.pathname === '/api/post') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('got:' + Buffer.concat(chunks).toString()) })
      return
    }
    if (u.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: hello\n\n')
      return // 之后一直不说话
    }
    if (u.pathname === '/redir') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/after`, 'set-cookie': ['dsh-auth-other=1; Path=/', 'pref=dark; Path=/'] })
      return res.end()
    }
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket) => {
    const port = server.address().port
    if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin || !String(req.headers.cookie || '').includes(`dsh-auth-abc=${secret}`)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
    if (req.url === '/api/quiet') {
      socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69])) // 一帧 "hi"，之后不说话
      return
    }
    socket.on('data', (d) => socket.write('echo:' + d))
  })
  return {
    server,
    seen,
    rotate() { secret = 'v2' },
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
  }
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `192.168.1.5:${port}`, ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }))
    })
    r.on('error', reject)
    if (body) r.write(body)
    r.end()
  })
}

async function setup(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-test-'))
  const dsh = fakeDsh()
  const upPort = await dsh.listen()
  const store = createStore({ dir })
  const logs = []
  const gw = createGateway({
    store,
    upstream: { port: () => upPort, authUrl: (base) => `${base}/?token=${TOKEN}` },
    log: (m) => logs.push(m),
    ...opts,
  })
  const port = await gw.start(0)
  t.after(async () => { await gw.stop(); dsh.server.closeAllConnections(); dsh.server.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const pair = async () => {
    const code = store.currentCode().value
    const r = await request(port, { method: 'POST', path: '/__dshm/pair', headers: { 'content-type': 'application/json', origin: `http://192.168.1.5:${port}`, 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' }, body: JSON.stringify({ code }) })
    assert.equal(r.status, 200, r.text)
    const c = [].concat(r.headers['set-cookie'])[0].split(';')[0]
    return c
  }
  return { dir, dsh, upPort, store, gw, port, pair, logs }
}

test('没配对：网页给配对页，接口 401', async (t) => {
  const { port } = await setup(t)
  const page = await request(port, { headers: { accept: 'text/html', 'sec-fetch-dest': 'document' } })
  assert.equal(page.status, 200)
  assert.match(page.text, /__dshm\/pair/)
  const api = await request(port, { path: '/api/echo', headers: { accept: 'application/json' } })
  assert.equal(api.status, 401)
})

test('配对码：错的 403、对的换 Cookie 且只能用一次', async (t) => {
  const { port, store } = await setup(t)
  const code = store.currentCode().value
  const hdr = { 'content-type': 'application/json', origin: `http://192.168.1.5:${port}` }
  const bad = await request(port, { method: 'POST', path: '/__dshm/pair', headers: hdr, body: JSON.stringify({ code: 'nope-nope-nope' }) })
  assert.equal(bad.status, 403)
  const ok = await request(port, { method: 'POST', path: '/__dshm/pair', headers: hdr, body: JSON.stringify({ code }) })
  assert.equal(ok.status, 200)
  const sc = [].concat(ok.headers['set-cookie'])[0]
  assert.match(sc, new RegExp(`^${COOKIE}=`))
  assert.match(sc, /HttpOnly/)
  assert.match(sc, /SameSite=Strict/)
  assert.doesNotMatch(sc, /Secure/) // 局域网是明文 HTTP
  const again = await request(port, { method: 'POST', path: '/__dshm/pair', headers: hdr, body: JSON.stringify({ code }) })
  assert.equal(again.status, 403)
  assert.equal(store.list().length, 1)
})

test('配对接口：跨站和非 JSON 拒，试太多次 429', async (t) => {
  const { port, store } = await setup(t)
  const code = store.currentCode().value
  const cross = await request(port, { method: 'POST', path: '/__dshm/pair', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ code }) })
  assert.equal(cross.status, 403)
  const form = await request(port, { method: 'POST', path: '/__dshm/pair', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `code=${code}` })
  assert.equal(form.status, 415)
  for (let i = 0; i < 20; i++) await request(port, { method: 'POST', path: '/__dshm/pair', headers: { 'content-type': 'application/json' }, body: '{"code":"wrong-code-123"}' })
  const limited = await request(port, { method: 'POST', path: '/__dshm/pair', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
  assert.equal(limited.status, 429)
})

test('配对后：首页插 boot.js，转发时 Host/Origin/Cookie 都换成 DSH 要的', async (t) => {
  const { port, pair, dsh, upPort } = await setup(t)
  const c = await pair()
  const page = await request(port, { headers: { accept: 'text/html', 'sec-fetch-dest': 'document', cookie: `${c}; theme=dark` } })
  assert.equal(page.status, 200)
  assert.ok(page.text.includes(BOOT_TAG))
  assert.ok(page.text.indexOf(BOOT_TAG) < page.text.indexOf('<title>'))
  const echo = await request(port, { path: '/api/echo', headers: { cookie: `${c}; theme=dark; dsh-auth-fake=1`, origin: `http://192.168.1.5:${port}`, referer: `http://192.168.1.5:${port}/x` } })
  assert.equal(echo.status, 200)
  const h = JSON.parse(echo.text).headers
  assert.equal(h.host, `127.0.0.1:${upPort}`)
  assert.equal(h.origin, undefined)
  assert.equal(h.referer, undefined)
  assert.match(h.cookie, /theme=dark/)
  assert.match(h.cookie, /dsh-auth-abc=v1/)
  assert.doesNotMatch(h.cookie, new RegExp(`${COOKIE}=`))
  assert.doesNotMatch(h.cookie, /dsh-auth-fake/)
  assert.equal(h['accept-encoding'], 'identity')
  // 启动口令只用了一次
  assert.equal(dsh.seen.filter((s) => s.url.includes('token=')).length, 1)
  const boot = await request(port, { path: '/__dshm/boot.js', headers: { cookie: c } })
  assert.equal(boot.status, 200)
  assert.match(boot.text, /randomUUID/)
})

test('配对后：跨站请求拒；POST 正文照转', async (t) => {
  const { port, pair } = await setup(t)
  const c = await pair()
  const cross = await request(port, { path: '/api/echo', headers: { cookie: c, origin: 'https://evil.example' } })
  assert.equal(cross.status, 403)
  const site = await request(port, { path: '/api/echo', headers: { cookie: c, 'sec-fetch-site': 'cross-site' } })
  assert.equal(site.status, 403)
  const post = await request(port, { method: 'POST', path: '/api/post', headers: { cookie: c, 'content-type': 'text/plain', origin: `http://192.168.1.5:${port}` }, body: 'hi there' })
  assert.equal(post.text, 'got:hi there')
})

test('重定向改成相对地址，DSH 的登录 Cookie 不给手机，别的 Cookie 照给', async (t) => {
  const { port, pair } = await setup(t)
  const c = await pair()
  const r = await request(port, { path: '/redir', headers: { cookie: c } })
  assert.equal(r.status, 302)
  assert.equal(r.headers.location, '/after')
  assert.deepEqual(r.headers['set-cookie'], ['pref=dark; Path=/'])
})

test('DSH 换了登录密钥：网关自动重换 Cookie', async (t) => {
  const { port, pair, dsh } = await setup(t)
  const c = await pair()
  assert.equal((await request(port, { path: '/api/echo', headers: { cookie: c } })).status, 200)
  dsh.rotate()
  const r = await request(port, { path: '/api/echo', headers: { cookie: c } })
  assert.equal(r.status, 200)
  assert.match(JSON.parse(r.text).headers.cookie, /dsh-auth-abc=v2/)
})

test('事件流：空闲时补注释行保活', async (t) => {
  const { port, pair } = await setup(t, { pingMs: 150 })
  const c = await pair()
  const got = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `192.168.1.5:${port}`, cookie: c, accept: 'text/event-stream' } }, (res) => {
      let buf = ''
      res.on('data', (d) => { buf += d })
      setTimeout(() => { r.destroy(); resolve({ type: res.headers['content-type'], buf }) }, 500)
    })
    r.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)))
    r.end()
  })
  assert.match(got.type, /event-stream/)
  assert.ok(got.buf.startsWith('data: hello\n\n'))
  assert.match(got.buf, /: dshm\n\n/)
})

function wsConnect(port, cookie, origin, p = '/api/ws') {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`GET ${p} HTTP/1.1\r\nhost: 192.168.1.5:${port}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: x\r\nsec-websocket-version: 13\r\n${origin ? `origin: ${origin}\r\n` : ''}${cookie ? `cookie: ${cookie}\r\n` : ''}\r\n`)
    })
    let buf = ''
    s.on('data', (d) => {
      buf += d
      if (buf.includes('\r\n\r\n')) resolve({ s, head: buf })
    })
    s.on('error', reject)
    s.on('close', () => resolve({ s, head: buf }))
  })
}

test('WebSocket：配对的能升级，没配对的 401；连着就算在线；移除设备立刻断开', async (t) => {
  const { port, pair, store, gw } = await setup(t)
  const no = await wsConnect(port, '', `http://192.168.1.5:${port}`)
  assert.match(no.head, /401/)
  no.s.destroy()
  const c = await pair()
  const id = store.list()[0].id
  assert.equal(gw.online(id), false)
  const yes = await wsConnect(port, c, `http://192.168.1.5:${port}`)
  assert.match(yes.head, /101/)
  assert.equal(gw.online(id), true)
  const echo = await new Promise((resolve) => { yes.s.once('data', (d) => resolve(String(d))); yes.s.write('ping') })
  assert.equal(echo, 'echo:ping')
  const closed = new Promise((resolve) => yes.s.once('close', resolve))
  store.remove(id)
  gw.kick(id)
  await closed
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(gw.online(id), false)
  assert.equal((await request(port, { path: '/api/echo', headers: { cookie: c } })).status, 401)
})

test('设备文件里只存哈希；外网地址换了清掉旧地址的设备', async (t) => {
  const { dir, pair, store } = await setup(t)
  const c = await pair()
  const raw = fs.readFileSync(path.join(dir, 'devices.json'), 'utf8')
  assert.ok(!raw.includes(c.split('.')[1]))
  assert.equal((fs.statSync(path.join(dir, 'devices.json')).mode & 0o777), 0o600)
  const p2 = store.pair(store.currentCode().value, { ua: 'Android Mobile Chrome/1', host: 'old-words.trycloudflare.com', via: 'tunnel' })
  assert.ok(p2)
  assert.equal(store.list().length, 2)
  assert.equal(store.pruneHosts((h) => h.endsWith('.trycloudflare.com') && h !== 'new-words.trycloudflare.com'), 1)
  assert.equal(store.list().length, 1)
})

test('配对码 10 分钟过期', async () => {
  let t = 1000
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-test-'))
  const store = createStore({ dir, now: () => t })
  const code = store.currentCode().value
  t += 10 * 60 * 1000 + 1
  assert.equal(store.pair(code, {}), null)
  assert.notEqual(store.currentCode().value, code)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('纯函数', () => {
  assert.equal(phoneCookies('dshm=a.b; x=1; dsh-auth-q=2; y=3'), 'x=1; y=3')
  assert.equal(sameOrigin({ headers: { host: 'a.trycloudflare.com', origin: 'https://a.trycloudflare.com' } }), true)
  assert.equal(sameOrigin({ headers: { host: '192.168.1.5:18765', origin: 'http://192.168.1.5:18765' } }), true)
  assert.equal(sameOrigin({ headers: { host: '192.168.1.5:18765', origin: 'null' } }), false)
  assert.equal(sameOrigin({ headers: { host: 'x' } }), true)
  const up = upstreamHeaders({ headers: { host: 'h', connection: 'keep-alive', 'transfer-encoding': 'chunked', 'sec-fetch-mode': 'cors', 'x-a': '1' } }, 9, 'dsh-auth-z=1')
  assert.deepEqual(up, { 'x-a': '1', host: '127.0.0.1:9', 'accept-encoding': 'identity', cookie: 'dsh-auth-z=1' })
  const ws = upstreamHeaders({ headers: { host: 'h', connection: 'Upgrade', upgrade: 'websocket', origin: 'http://h' } }, 9, '', { upgrade: true })
  assert.deepEqual(ws, { connection: 'Upgrade', upgrade: 'websocket', host: '127.0.0.1:9' })
  const down = downstreamHeaders({ connection: 'close', location: 'http://localhost:9/a', 'set-cookie': ['dsh-auth-1=x'] }, 9)
  assert.deepEqual(down, { location: '/a' })
  assert.equal(injectBoot('<html><head lang="x"><title>t</title>'), `<html><head lang="x">${BOOT_TAG}<title>t</title>`)
  assert.equal(injectBoot('<p>x</p>'), `${BOOT_TAG}<p>x</p>`)
})

test('WebSocket 空闲：网关在帧边界往手机发 ping', async (t) => {
  const { port, pair } = await setup(t, { wsPingMs: 120 })
  const c = await pair()
  const s = net.connect(port, '127.0.0.1')
  const chunks = []
  s.on('data', (d) => chunks.push(d))
  s.write(`GET /api/quiet HTTP/1.1\r\nhost: 192.168.1.5:${port}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: x\r\nsec-websocket-version: 13\r\norigin: http://192.168.1.5:${port}\r\ncookie: ${c}\r\n\r\n`)
  await new Promise((r) => setTimeout(r, 400))
  s.destroy()
  const all = Buffer.concat(chunks)
  const body = all.subarray(all.indexOf('\r\n\r\n') + 4)
  assert.deepEqual([...body.subarray(0, 4)], [0x81, 0x02, 0x68, 0x69])
  assert.deepEqual([...body.subarray(4, 6)], [0x89, 0x00])
})

test('帧边界：长帧、分块、扩展长度都认得；不是 101 就不插', () => {
  const tr = wsTracker()
  tr.feed(Buffer.from('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\n\r\n'))
  assert.equal(tr.atBoundary(), true)
  const big = Buffer.concat([Buffer.from([0x82, 126, 0x01, 0x00]), Buffer.alloc(256, 7)])
  tr.feed(big.subarray(0, 3))
  assert.equal(tr.atBoundary(), false)
  tr.feed(big.subarray(3, 100))
  assert.equal(tr.atBoundary(), false)
  tr.feed(Buffer.concat([big.subarray(100), Buffer.from([0x81, 0x00])]))
  assert.equal(tr.atBoundary(), true)
  const no = wsTracker()
  no.feed(Buffer.from('HTTP/1.1 401 Unauthorized\r\n\r\n'))
  assert.equal(no.atBoundary(), false)
  const split = wsTracker()
  split.feed(Buffer.from('HTTP/1.1 101 OK\r\n\r'))
  split.feed(Buffer.from([0x0a, 0x81, 0x01]))
  assert.equal(split.atBoundary(), false)
  split.feed(Buffer.from([0x41]))
  assert.equal(split.atBoundary(), true)
})

test('隧道来的请求：文本 gzip、哈希资源长缓存；局域网不压', async (t) => {
  const { port, pair } = await setup(t)
  const c = await pair()
  const viaTunnel = { cookie: c, 'accept-encoding': 'gzip, br', 'cf-ray': 'x', 'cf-connecting-ip': '1.2.3.4' }
  const raw = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/assets/index-AbCd1234.js', headers: { host: 'a.trycloudflare.com', ...viaTunnel } }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
  assert.equal(raw.headers['content-encoding'], 'gzip')
  assert.match(raw.headers['cache-control'], /immutable/)
  assert.equal(zlib.gunzipSync(raw.body).toString(), 'console.log(1);'.repeat(2000))
  assert.ok(raw.body.length < 2000)
  const lan = await request(port, { path: '/assets/index-AbCd1234.js', headers: { cookie: c, 'accept-encoding': 'gzip' } })
  assert.equal(lan.headers['content-encoding'], undefined)
  assert.match(lan.headers['cache-control'], /immutable/)
  const page = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers: { host: 'a.trycloudflare.com', accept: 'text/html', 'sec-fetch-dest': 'document', ...viaTunnel } }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
  assert.equal(page.headers['content-encoding'], 'gzip')
  assert.ok(zlib.gunzipSync(page.body).toString().includes(BOOT_TAG))
  assert.equal(shouldGzip({ method: 'GET', headers: { 'accept-encoding': 'gzip' } }, { 'content-type': 'text/event-stream' }, 'tunnel'), false)
  assert.equal(shouldGzip({ method: 'GET', headers: { 'accept-encoding': 'gzip' } }, { 'content-type': 'application/json' }, 'lan'), false)
  assert.equal(shouldGzip({ method: 'GET', headers: { 'accept-encoding': 'gzip' } }, { 'content-type': 'application/json' }, 'tunnel'), true)
  assert.equal(shouldGzip({ method: 'GET', headers: { 'accept-encoding': 'gzip' } }, { 'content-type': 'image/png' }, 'tunnel'), false)
})
