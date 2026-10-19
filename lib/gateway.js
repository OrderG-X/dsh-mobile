/**
 * 手机网关：一个独立端口，把手机浏览器的请求原样转给本机的 DSH 网页端。
 *
 *   手机 ──HTTP(局域网) / HTTPS(隧道)──▶ 网关 0.0.0.0:<port> ──▶ DSH 127.0.0.1:<webServer.port>
 *
 * 门禁全在网关：
 *   - 没配对的只能看到配对页（POST /__dshm/pair 用一次性配对码换设备 Cookie），别的一律 401
 *   - 配对过的：带 Origin 的请求必须同源、跨站的拒，然后才转发
 * 转发时：
 *   - Host 改成 127.0.0.1:<port>，去掉 Origin / Referer（DSH 有 Host/Origin 围栏）
 *   - 手机的 Cookie 里剔掉网关自己的和 dsh-auth-*，换上网关替手机拿的那张 DSH 登录 Cookie
 *     （用 connection.authenticatedUrl 的启动口令换一次；失效了自动重换）
 *   - DSH 回的 dsh-auth-* Set-Cookie 不给手机，Location 里的 127.0.0.1 改成相对地址
 *   - 首页 HTML 插 boot.js；事件流（text/event-stream）空闲时补注释行保活，隧道、NAT 不会把它当死连接掐掉
 *   - 隧道来的请求：文本类响应网关先 gzip（瓶颈是电脑那头的上行）；带哈希的 /assets/ 文件加长缓存
 *   - WebSocket 升级照样转
 */

import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'
import { PAIR_PAGE, BOOT_JS, injectBoot } from './pages.js'

export const COOKIE = 'dshm'
const COOKIE_MAX_AGE = 400 * 24 * 3600
const MAX_HTML = 4 * 1024 * 1024
const SSE_PING_MS = 20 * 1000
const WS_PING_MS = 25 * 1000
const PING_FRAME = Buffer.from([0x89, 0x00]) // 服务端发的 ping：FIN + opcode 9，不掩码，空载荷
const FAIL_WINDOW_MS = 10 * 60 * 1000
const FAIL_LIMIT = 20
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'http2-settings'])
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/
const COMPRESSIBLE = /^(text\/(?!event-stream)|application\/(json|javascript|manifest\+json)|image\/svg)/i
const HASHED_ASSET = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|svg|png|jpg|webp)$/

export function cookieOf(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return ''
}

/** 手机发来的 Cookie 去掉网关自己的和 DSH 登录的（后者由网关补） */
export function phoneCookies(header) {
  return String(header || '').split(';').map((s) => s.trim())
    .filter((s) => s && !s.startsWith(`${COOKIE}=`) && !s.startsWith('dsh-auth-'))
    .join('; ')
}

/** 请求是隧道来的吗：本机连进来 + 带 Cloudflare 的头 */
export function viaOf(req) {
  const local = LOOPBACK.test(String(req.socket.remoteAddress || ''))
  if (local && (req.headers['cf-connecting-ip'] || req.headers['cf-ray'])) return 'tunnel'
  return local ? 'local' : 'lan'
}

export function clientIp(req) {
  const raw = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  if (LOOPBACK.test(raw) && typeof req.headers['cf-connecting-ip'] === 'string') return req.headers['cf-connecting-ip']
  return raw
}

function isHttps(req) {
  const p = String(req.headers['x-forwarded-proto'] || '')
  return p === 'https' || /"scheme":"https"/.test(String(req.headers['cf-visitor'] || ''))
}

/** 带 Origin 的必须是网关自己（同一个 Host）；Sec-Fetch-Site 说跨站的拒 */
export function sameOrigin(req) {
  if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase()
  } catch {
    return false
  }
}

/** 发给 DSH 的请求头 */
export function upstreamHeaders(req, port, dshCookie, { upgrade = false } = {}) {
  const out = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k) && !(upgrade && (k === 'connection' || k === 'upgrade'))) continue
    if (k === 'host' || k === 'origin' || k === 'referer' || k === 'cookie' || k.startsWith('sec-fetch-')) continue
    if (k === 'accept-encoding' && !upgrade) continue
    out[k] = v
  }
  out.host = `127.0.0.1:${port}`
  if (!upgrade) out['accept-encoding'] = 'identity' // 要能往 HTML / 事件流里插东西；隧道那头 Cloudflare 自己会压缩
  const cookie = [phoneCookies(req.headers.cookie), dshCookie].filter(Boolean).join('; ')
  if (cookie) out.cookie = cookie
  return out
}

/** 隧道那一路（家里宽带的上行）是瓶颈：文本类响应网关先压一下 */
export function shouldGzip(req, headers, via) {
  return via === 'tunnel' && req.method !== 'HEAD' && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))
    && !headers['content-encoding'] && COMPRESSIBLE.test(String(headers['content-type'] || ''))
}

/** DSH 回给手机的响应头 */
export function downstreamHeaders(headers, port, path = '') {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (HOP.has(k)) continue
    out[k] = v
  }
  if (out['set-cookie']) {
    const kept = [].concat(out['set-cookie']).filter((c) => !String(c).trim().startsWith('dsh-auth-'))
    if (kept.length) out['set-cookie'] = kept
    else delete out['set-cookie']
  }
  // 文件名带哈希的静态资源永远不会变：让手机缓存起来，别每次都从电脑上重拉
  if (!out['cache-control'] && HASHED_ASSET.test(path.split('?')[0])) out['cache-control'] = 'public, max-age=31536000, immutable'
  if (typeof out.location === 'string') {
    for (const base of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
      if (out.location.startsWith(base)) out.location = out.location.slice(base.length) || '/'
    }
  }
  return out
}

/**
 * 盯着「DSH → 手机」这一路的 WebSocket 字节流，判断现在是不是正好在两帧之间。
 * 先跳过 101 握手响应头；之后按帧头算出每帧多长。看不懂（不是 101、帧长离谱）就永远答 false，
 * 网关退回纯转发，绝不往半帧里插东西。
 */
export function wsTracker() {
  let phase = 'head' // head → frames | dead
  let headBuf = ''
  let hdr = [] // 正在攒的帧头字节
  let need = 0 // 当前帧还剩多少载荷字节
  function frameHeaderLen(b) {
    if (b.length < 2) return 0
    const len7 = b[1] & 0x7f
    const masked = (b[1] & 0x80) !== 0
    return 2 + (len7 === 126 ? 2 : len7 === 127 ? 8 : 0) + (masked ? 4 : 0)
  }
  function payloadLen(b) {
    const len7 = b[1] & 0x7f
    if (len7 < 126) return len7
    if (len7 === 126) return (b[2] << 8) | b[3]
    let n = 0
    for (let i = 2; i < 10; i++) n = n * 256 + b[i]
    return n
  }
  function feed(chunk) {
    let i = 0
    if (phase === 'dead') return
    if (phase === 'head') {
      headBuf += chunk.toString('latin1')
      const end = headBuf.indexOf('\r\n\r\n')
      if (end < 0) { if (headBuf.length > 16384) phase = 'dead'; return }
      if (!/^HTTP\/1\.1 101 /.test(headBuf)) { phase = 'dead'; return }
      i = chunk.length - (headBuf.length - (end + 4))
      headBuf = ''
      phase = 'frames'
    }
    while (i < chunk.length) {
      if (need > 0) {
        const take = Math.min(need, chunk.length - i)
        need -= take
        i += take
        continue
      }
      hdr.push(chunk[i++])
      const want = frameHeaderLen(hdr)
      if (want && hdr.length === want) {
        const n = payloadLen(hdr)
        if (n > 512 * 1024 * 1024) { phase = 'dead'; return }
        need = n
        hdr = []
      }
    }
  }
  return {
    feed,
    atBoundary: () => phase === 'frames' && need === 0 && hdr.length === 0,
  }
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(new Error('bad json')) }
    })
    req.on('error', reject)
  })
}

/**
 * 用启动口令换一张 DSH 登录 Cookie：GET /?token=… → 303 + Set-Cookie。
 * @returns 'dsh-auth-…=…'
 */
export function mintDshCookie(port, authUrl) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(authUrl) } catch { return reject(new Error('bad authenticated url')) }
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: u.pathname + u.search, headers: { host: `127.0.0.1:${port}`, accept: 'text/html' } }, (res) => {
      res.resume()
      const c = [].concat(res.headers['set-cookie'] || []).map((s) => String(s).split(';')[0].trim()).find((s) => s.startsWith('dsh-auth-'))
      if (c) resolve(c)
      else reject(new Error(`DSH did not issue a session cookie (HTTP ${res.statusCode})`))
    })
    r.setTimeout(8000, () => r.destroy(new Error('timeout')))
    r.on('error', reject)
    r.end()
  })
}

/**
 * @param opts.store     createStore()
 * @param opts.upstream  { port(): number|undefined, authUrl(base): string|undefined }
 *                       authUrl 没有（DSH 没开鉴权的部署）就不带登录 Cookie
 * @param opts.log       (msg) => void
 * @param opts.pingMs    事件流空闲多久补一行保活
 * @param opts.wsPingMs  WebSocket 空闲多久往手机发一个 ping
 */
export function createGateway({ store, upstream, log = () => {}, now = Date.now, pingMs = SSE_PING_MS, wsPingMs = WS_PING_MS }) {
  let server = null
  let port = 0
  let dshCookie = null // Promise<string|''>
  const sockets = new Set()
  const byDevice = new Map() // device id → Set<socket>
  const fails = new Map() // ip → { n, reset }

  function getDshCookie() {
    if (!dshCookie) {
      const p = upstream.port()
      const url = p ? upstream.authUrl(`http://127.0.0.1:${p}`) : undefined
      dshCookie = url ? mintDshCookie(p, url).catch((e) => { log(`换 DSH 登录 Cookie 失败：${e.message}`); dshCookie = null; return '' }) : Promise.resolve('')
    }
    return dshCookie
  }

  function track(dev, socket) {
    let set = byDevice.get(dev.id)
    if (!set) byDevice.set(dev.id, (set = new Set()))
    if (set.has(socket)) return
    set.add(socket)
    socket.once('close', () => set.delete(socket))
  }

  /** 移除设备后，它开着的连接立刻断掉 */
  function kick(id) {
    const set = byDevice.get(id)
    if (!set) return 0
    byDevice.delete(id)
    for (const s of set) s.destroy()
    return set.size
  }

  function limited(ip) {
    const f = fails.get(ip)
    return !!f && f.reset > now() && f.n >= FAIL_LIMIT
  }

  function failed(ip) {
    const f = fails.get(ip)
    if (!f || f.reset <= now()) fails.set(ip, { n: 1, reset: now() + FAIL_WINDOW_MS })
    else f.n++
    if (fails.size > 1000) for (const [k, v] of fails) if (v.reset <= now()) fails.delete(k)
  }

  function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }

  function wantsPage(req) {
    const dest = String(req.headers['sec-fetch-dest'] || '')
    return req.method === 'GET' && (dest === 'document' || (!dest && /text\/html/.test(String(req.headers.accept || ''))))
  }

  async function pairRoute(req, res, ip, via) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method' })
    if (!sameOrigin(req)) return send(res, 403, { error: 'origin' })
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'type' })
    if (limited(ip)) return send(res, 429, { error: 'rate' })
    let body
    try { body = await readJson(req) } catch { return send(res, 400, { error: 'body' }) }
    const host = String(req.headers.host || '').toLowerCase()
    const r = store.pair(body && body.code, { ua: String(req.headers['user-agent'] || ''), ip, via, host })
    if (!r) {
      failed(ip)
      log(`配对失败：${ip}（${via}）`)
      return send(res, 403, { error: 'expired' })
    }
    log(`新设备配对：${r.device.name}（${ip}，${via}）`)
    const cookie = `${COOKIE}=${r.cookie}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Strict${isHttps(req) ? '; Secure' : ''}`
    return send(res, 200, { ok: true, device: r.device }, undefined, { 'set-cookie': cookie })
  }

  async function handle(req, res) {
    let url
    try { url = new URL(req.url || '/', 'http://x') } catch { return send(res, 400, { error: 'url' }) }
    const ip = clientIp(req)
    const via = viaOf(req)
    if (url.pathname === '/__dshm/pair') return pairRoute(req, res, ip, via)

    const dev = store.check(cookieOf(req.headers.cookie, COOKIE), { ip, via })
    if (!dev) {
      if (wantsPage(req)) return send(res, 200, PAIR_PAGE, 'text/html; charset=utf-8', { 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' })
      return send(res, 401, { error: 'not paired' })
    }
    if (!sameOrigin(req)) return send(res, 403, { error: 'cross-origin' })
    track(dev, req.socket)

    if (url.pathname === '/__dshm/boot.js') return send(res, 200, BOOT_JS, 'text/javascript; charset=utf-8')
    if (url.pathname === '/__dshm/me') return send(res, 200, { device: dev })
    if (url.pathname === '/__dshm/logout' && req.method === 'POST') {
      store.remove(dev.id)
      send(res, 200, { ok: true }, undefined, { 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict` })
      return setTimeout(() => kick(dev.id), 50)
    }
    return proxy(req, res, false, via)
  }

  async function proxy(req, res, retried, via) {
    const p = upstream.port()
    if (!p) return send(res, 503, { error: 'DSH is starting' })
    const cookie = await getDshCookie()
    const bodyless = req.method === 'GET' || req.method === 'HEAD'
    const r = http.request({ host: '127.0.0.1', port: p, method: req.method, path: req.url, headers: upstreamHeaders(req, p, cookie) }, (up) => {
      if (up.statusCode === 401 && cookie) {
        dshCookie = null // 登录 Cookie 失效（比如 DSH 换了密钥）：下次重换
        if (bodyless && !retried) { up.resume(); return proxy(req, res, true, via) }
      }
      respond(req, res, up, p, via)
    })
    r.on('error', (e) => {
      log(`转发失败 ${req.method} ${req.url}: ${e.message}`)
      if (res.headersSent) res.destroy()
      else send(res, 502, { error: 'DSH unreachable' })
    })
    res.on('close', () => { if (!res.writableFinished) r.destroy() })
    if (bodyless) r.end()
    else req.pipe(r)
  }

  function respond(req, res, up, p, via) {
    const h = downstreamHeaders(up.headers, p, req.url || '')
    const type = String(up.headers['content-type'] || '')
    const code = up.statusCode || 502
    const gzip = shouldGzip(req, up.headers, via)
    if (gzip) {
      delete h['content-length']
      h['content-encoding'] = 'gzip'
      h.vary = h.vary ? `${h.vary}, Accept-Encoding` : 'Accept-Encoding'
    }

    // 首页：插 boot.js
    if (/^text\/html/i.test(type) && !up.headers['content-encoding'] && req.method === 'GET' && wantsPage(req)) {
      const chunks = []
      let size = 0
      up.on('data', (c) => { size += c.length; if (size <= MAX_HTML) chunks.push(c) })
      up.on('end', () => {
        if (res.headersSent || res.destroyed) return
        delete h['content-length']
        const text = Buffer.concat(chunks).toString('utf8')
        const html = Buffer.from(size > MAX_HTML ? text : injectBoot(text))
        const out = gzip ? zlib.gzipSync(html) : html
        h['content-length'] = out.length
        res.writeHead(code, h)
        res.end(out)
      })
      up.on('error', () => res.destroy())
      return
    }

    // 事件流：空闲时补注释行保活（只在一条事件结束之后插，不会把事件劈开）
    if (/^text\/event-stream/i.test(type) && !up.headers['content-encoding']) {
      res.writeHead(code, { ...h, 'x-accel-buffering': 'no' })
      if (res.socket) res.socket.setNoDelay(true)
      let tail = '\n\n'
      let last = now()
      up.on('data', (c) => {
        const s = c.toString('latin1')
        tail = (tail + s).slice(-2)
        last = now()
        res.write(c)
      })
      const beat = setInterval(() => {
        if (now() - last >= pingMs - 500 && tail === '\n\n') { res.write(': dshm\n\n'); last = now() }
      }, pingMs)
      const stop = () => clearInterval(beat)
      up.on('end', () => { stop(); res.end() })
      up.on('error', () => { stop(); res.destroy() })
      res.on('close', () => { stop(); up.destroy() })
      return
    }

    res.writeHead(code, h)
    up.on('error', () => res.destroy())
    if (!gzip) return up.pipe(res)
    // 每块都同步刷出去：流式的接口响应不会被压缩攒住
    const z = zlib.createGzip({ level: 6, flush: zlib.constants.Z_SYNC_FLUSH })
    z.on('error', () => res.destroy())
    up.pipe(z).pipe(res)
  }

  async function upgrade(req, socket, head) {
    socket.on('error', () => socket.destroy())
    const dev = store.check(cookieOf(req.headers.cookie, COOKIE), { ip: clientIp(req), via: viaOf(req) })
    if (!dev || !sameOrigin(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      return
    }
    const p = upstream.port()
    if (!p) return socket.destroy()
    track(dev, socket)
    const cookie = await getDshCookie()
    const conn = net.connect(p, '127.0.0.1')
    const handshake = setTimeout(() => conn.destroy(), 10000)
    conn.once('connect', () => {
      clearTimeout(handshake)
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
      for (const [k, v] of Object.entries(upstreamHeaders(req, p, cookie, { upgrade: true }))) {
        for (const one of Array.isArray(v) ? v : [v]) raw += `${k}: ${one}\r\n`
      }
      conn.write(raw + '\r\n')
      if (head && head.length) conn.write(head)
      for (const s of [conn, socket]) { s.setKeepAlive(true, 30000); s.setNoDelay(true) }
      const tracker = wsTracker()
      let last = now()
      conn.on('data', (c) => {
        tracker.feed(c)
        last = now()
        if (!socket.write(c)) { conn.pause(); socket.once('drain', () => conn.resume()) }
      })
      conn.on('end', () => socket.end())
      socket.pipe(conn)
      // DSH 的下行 WebSocket 自己不发心跳：空闲时网关往手机方向插一个 ping（只在帧边界插），
      // 手机浏览器自动回 pong，整条链路就一直有流量，隧道和运营商不会当成死连接掐掉
      beat = setInterval(() => {
        if (now() - last >= wsPingMs - 500 && tracker.atBoundary()) {
          socket.write(PING_FRAME)
          last = now()
        }
      }, wsPingMs)
    })
    let beat = null
    const done = () => { clearTimeout(handshake); clearInterval(beat); conn.destroy(); socket.destroy() }
    conn.on('error', done)
    conn.on('close', done)
    socket.on('close', done)
  }

  /** 开始监听；端口被占就换一个随机的 */
  async function start(want = 0) {
    if (server) return port
    const s = http.createServer({ requestTimeout: 30 * 60 * 1000, headersTimeout: 60 * 1000 }, (req, res) => {
      handle(req, res).catch((e) => {
        log(`网关出错：${e && e.stack || e}`)
        if (!res.headersSent) send(res, 500, { error: 'gateway' })
        else res.destroy()
      })
    })
    s.on('upgrade', (req, socket, head) => { upgrade(req, socket, head).catch(() => socket.destroy()) })
    s.on('connection', (c) => { sockets.add(c); c.on('close', () => sockets.delete(c)) })
    s.on('clientError', (_e, c) => c.destroy())
    const listen = (p) => new Promise((resolve, reject) => {
      const onErr = (e) => { s.off('listening', onOk); reject(e) }
      const onOk = () => { s.off('error', onErr); resolve() }
      s.once('error', onErr)
      s.once('listening', onOk)
      s.listen(p, '0.0.0.0')
    })
    try {
      await listen(want)
    } catch (e) {
      if (!want || e.code !== 'EADDRINUSE') throw e
      log(`端口 ${want} 被占用，换一个`)
      await listen(0)
    }
    server = s
    port = s.address().port
    return port
  }

  async function stop() {
    if (!server) return
    const s = server
    server = null
    port = 0
    for (const c of sockets) c.destroy()
    sockets.clear()
    byDevice.clear()
    await new Promise((resolve) => s.close(() => resolve()))
  }

  return {
    start,
    stop,
    kick,
    get port() { return port },
    get running() { return !!server },
    /** 测试用：清掉缓存的 DSH 登录 Cookie */
    resetUpstreamCookie() { dshCookie = null },
  }
}
