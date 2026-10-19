/**
 * dsh-mobile：手机扫码，在手机浏览器里看电脑上 DSH 的任务、接着发消息、批准操作。
 *
 * 手机看到的就是 DSH 官方网页界面，连的是电脑上同一个 DSH 进程、同一批会话，实时同步。
 *   - 同一个 Wi-Fi：手机直连网关（局域网 HTTP）
 *   - 出门在外：Cloudflare 免费隧道（HTTPS），设置页里打开
 *   - 门禁：一次性二维码配对，每台手机一张设备凭证，设置页里随时移除
 *
 * 设置页（client.js）的数据走 DSH webServer 上的一条路由：
 *   GET  /dsh-mobile/panel           → 状态（开关、二维码、隧道、设备列表）
 *   POST /dsh-mobile/panel {action}  → enable / tunnel / download / newCode / remove / removeAll
 * 这条路由要 DSH 自己的登录（connection.requestRejection），配对码不会被别的网页读走。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createStore, CODE_TTL_MS } from './store.js'
import { createGateway } from './gateway.js'
import { createTunnel, findCloudflared, downloadCloudflared, assetFor } from './tunnel.js'
import { lanAddress } from './net.js'
import { qrMatrix, qrPath } from './qr.js'

export const name = 'dsh-mobile'
export const inject = ['webServer']

export const PANEL_ROUTE = '/dsh-mobile/panel'
export const DEFAULT_PORT = 18765

const PKG_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version } catch { return '' }
})()

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i

function qr(text) {
  try {
    const m = qrMatrix(text)
    return { size: m.length + 8, path: qrPath(m) }
  } catch {
    return null
  }
}

function makeLog(dir) {
  const file = path.join(dir, 'mobile.log')
  return (msg) => {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { if (fs.statSync(file).size > 256 * 1024) fs.renameSync(file, file + '.1') } catch {}
      fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 })
    } catch {}
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
 * 手机端的全部状态 + 操作，跟 DSH 无关的部分都在这里（测试直接用它）。
 * @param opts.upstream  { port(), authUrl(base) }，见 gateway.js
 */
export function createMobile({ store, upstream, log = () => {}, address = () => lanAddress(), binDir }) {
  let download = null // { got, total, error }
  const gateway = createGateway({ store, upstream, log })
  const tunnel = createTunnel({
    pidFile: path.join(store.dir, 'cloudflared.pid'),
    bin: () => findCloudflared(binDir),
    target: () => (gateway.port ? `http://127.0.0.1:${gateway.port}` : ''),
    log,
    onChange: (st) => {
      // 快速隧道每次地址都不一样：旧地址上配的手机再也连不上了，顺手清掉
      if (st.url) {
        const host = new URL(st.url).host.toLowerCase()
        const n = store.pruneHosts((h) => h.endsWith('.trycloudflare.com') && h !== host)
        if (n) log(`外网地址换了，清掉 ${n} 台旧地址上配对的设备`)
      }
    },
  })

  async function startGateway() {
    const want = store.state.port || DEFAULT_PORT
    const port = await gateway.start(want)
    if (port !== store.state.port) store.setState({ port })
    log(`网关已开：0.0.0.0:${port}`)
    if (store.state.tunnel) tunnel.start()
  }

  async function stopAll() {
    tunnel.stop()
    await gateway.stop()
    store.flush()
  }

  async function boot() {
    if (store.state.enabled) {
      try { await startGateway() } catch (e) { log(`网关没开起来：${e.message}`) }
    }
  }

  function state() {
    const s = store.state
    const ip = address()
    const code = s.enabled && gateway.running ? store.currentCode() : null
    const lanBase = ip && gateway.port ? `http://${ip}:${gateway.port}` : ''
    const t = tunnel.status
    const lanUrl = lanBase && code ? `${lanBase}/#pair=${code.value}` : ''
    const tunUrl = t.url && code ? `${t.url}/#pair=${code.value}` : ''
    return {
      plugin: PKG_VERSION,
      platform: process.platform,
      enabled: !!s.enabled,
      running: gateway.running,
      port: gateway.port || s.port || 0,
      codeExpires: code ? code.expires : 0,
      codeTtl: CODE_TTL_MS,
      lan: { ip, base: lanBase, url: lanUrl, qr: lanUrl ? qr(lanUrl) : null },
      tunnel: {
        on: !!s.tunnel,
        state: s.tunnel ? (t.state === 'off' ? 'starting' : t.state) : 'off',
        base: t.url,
        url: tunUrl,
        qr: tunUrl ? qr(tunUrl) : null,
        error: t.error,
        installed: !!findCloudflared(binDir),
        supported: !!assetFor(),
        download,
      },
      devices: store.list(),
    }
  }

  async function act(body) {
    switch (body && body.action) {
      case 'enable':
        if (body.on) {
          store.setState({ enabled: true })
          store.resetCode()
          await startGateway()
        } else {
          store.setState({ enabled: false })
          store.resetCode()
          await stopAll()
          log('手机访问已关闭')
        }
        break
      case 'tunnel':
        store.setState({ tunnel: !!body.on })
        if (body.on && gateway.running) tunnel.start()
        else tunnel.stop()
        break
      case 'download':
        if (!download || download.error) {
          download = { got: 0, total: 0, error: '' }
          downloadCloudflared(binDir, { onProgress: (p) => { download = { ...download, ...p } } })
            .then((file) => {
              log(`cloudflared 已下载：${file}`)
              download = null
              if (store.state.tunnel && gateway.running) tunnel.start()
            })
            .catch((e) => {
              log(`cloudflared 下载失败：${e.message}`)
              download = { ...download, error: e.message }
            })
        }
        break
      case 'newCode':
        store.resetCode()
        break
      case 'remove':
        if (typeof body.id === 'string' && store.remove(body.id)) {
          gateway.kick(body.id)
          log(`移除设备 ${body.id}`)
        }
        break
      case 'removeAll':
        for (const d of store.list()) gateway.kick(d.id)
        store.removeAll()
        log('移除全部设备')
        break
      default:
        throw new Error(`unknown action: ${body && body.action}`)
    }
    return state()
  }

  return { boot, stopAll, state, act, gateway, tunnel }
}

/** 设置页路由的门：有 connection 就要 DSH 登录；没有（不鉴权的部署）就只收本机、同源 */
function rejection(req, connection, origin) {
  if (connection && typeof connection.requestRejection === 'function') return connection.requestRejection(req)
  if (!LOOPBACK.has(req.socket.remoteAddress)) return 403
  if (!LOOPBACK_HOST.test(req.headers.host || '')) return 403
  const from = req.headers.origin
  if (!from) return undefined
  try { return from === origin() ? undefined : 403 } catch { return 403 }
}

export function panelHandler({ mobile, connection, origin, log = () => {} }) {
  return async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const no = rejection(req, connection(), origin)
    if (no) return send(no, { error: no === 401 ? 'unauthorized' : 'forbidden' })
    if (req.method === 'GET') return send(200, mobile.state())
    if (req.method !== 'POST') return send(405, { error: 'method not allowed' })
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(415, { error: 'expect application/json' })
    let body
    try { body = await readJson(req) } catch (e) { return send(400, { error: e.message }) }
    try {
      return send(200, await mobile.act(body))
    } catch (e) {
      log(`设置页操作失败：${e.message}`)
      return send(200, { ...mobile.state(), actionError: String((e && e.message) || e) })
    }
  }
}

export function apply(ctx) {
  const store = createStore()
  const log = makeLog(store.dir)
  const connection = () => {
    try { return ctx.get('connection') } catch { return undefined }
  }
  const mobile = createMobile({
    store,
    log,
    binDir: path.join(store.dir, 'bin'),
    upstream: {
      port: () => ctx.webServer.port,
      authUrl: (base) => {
        const c = connection()
        return c && typeof c.authenticatedUrl === 'function' ? c.authenticatedUrl(base) : undefined
      },
    },
  })

  ctx.effect(() => {
    mobile.boot()
    return () => mobile.stopAll()
  }, 'dsh-mobile: gateway')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PANEL_ROUTE,
    handler: panelHandler({ mobile, connection, origin: () => ctx.webServer.getOrigin(), log }),
  }), 'dsh-mobile: settings panel route')
}
