// 设置页背后的逻辑：打开手机访问就把外网备好（没 cloudflared 自动下），一个二维码 Wi-Fi 和流量都能扫
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { createMobile, keepTunnelOnDispose } from '../lib/index.js'

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

async function setup({ installed = false, supported = true, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-mobile-')) } = {}) {
  const store = createStore({ dir })
  if (!store.state.port) store.setState({ port: await freePort() })
  const calls = { start: 0, stop: 0, detach: 0, download: 0 }
  const tun = { state: 'off', url: '', error: '' }
  let finish = null
  const deps = {
    createTunnel: () => ({
      start() { calls.start++; tun.state = 'on'; tun.url = 'https://some-words.trycloudflare.com' },
      stop() { calls.stop++; tun.state = 'off'; tun.url = '' },
      detach() { calls.detach++; tun.state = 'off'; return true },
      get status() { return { ...tun } },
      get wanted() { return tun.state !== 'off' },
    }),
    findCloudflared: () => (installed ? '/x/cloudflared' : null),
    assetFor: () => (supported ? { name: 'cloudflared-test', tgz: false } : null),
    downloadCloudflared: (binDir, { onProgress }) => {
      calls.download++
      onProgress({ got: 5, total: 10 })
      return new Promise((resolve, reject) => {
        finish = (err) => {
          if (err) return reject(err)
          installed = true
          resolve('/x/cloudflared')
        }
      })
    },
  }
  const mobile = createMobile({
    store,
    binDir: path.join(dir, 'bin'),
    address: () => '192.168.1.5',
    upstream: { port: () => 1, authUrl: () => undefined },
    deps,
  })
  const done = async () => {
    await mobile.stopAll()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { dir, store, mobile, calls, finish: (e) => finish(e), done }
}

test('没有 cloudflared：打开手机访问就自动下载，下完自动起隧道，二维码换成外网的', async () => {
  const { mobile, calls, finish, done } = await setup()
  let s = await mobile.act({ action: 'enable', on: true })
  assert.equal(s.enabled, true)
  assert.equal(s.tunnel.on, true)
  assert.equal(s.tunnel.state, 'downloading')
  assert.deepEqual(s.tunnel.download, { got: 5, total: 10, error: '' })
  assert.equal(calls.download, 1)
  assert.equal(calls.start, 0)
  assert.ok(s.lan.qr, '准备期间先给局域网的码')
  assert.equal(s.tunnel.qr, null)

  finish()
  await tick()
  s = mobile.state()
  assert.equal(calls.start, 1)
  assert.equal(s.tunnel.state, 'on')
  assert.ok(s.tunnel.qr)
  assert.match(s.tunnel.url, /^https:\/\/some-words\.trycloudflare\.com\/#pair=/)
  await done()
})

test('已有 cloudflared：打开就起隧道；关掉「外网也能用」会记住，重开手机访问也只走局域网', async () => {
  const { store, mobile, calls, done } = await setup({ installed: true })
  let s = await mobile.act({ action: 'enable', on: true })
  assert.equal(calls.start, 1)
  assert.equal(calls.download, 0)
  assert.equal(s.tunnel.state, 'on')

  s = await mobile.act({ action: 'tunnel', on: false })
  assert.equal(s.tunnel.on, false)
  assert.equal(s.tunnel.state, 'off')
  assert.equal(store.state.lanOnly, true)

  await mobile.act({ action: 'enable', on: false })
  s = await mobile.act({ action: 'enable', on: true })
  assert.equal(s.tunnel.on, false)
  assert.equal(calls.start, 1, '只局域网时不起隧道')

  s = await mobile.act({ action: 'tunnel', on: true })
  assert.equal(store.state.lanOnly, false)
  assert.equal(calls.start, 2)
  assert.equal(s.tunnel.state, 'on')
  await done()
})

test('下载失败：显示错误、不自己反复下；点重试再下一次', async () => {
  const { mobile, calls, finish, done } = await setup()
  await mobile.act({ action: 'enable', on: true })
  finish(new Error('HTTP 503'))
  await tick()
  let s = mobile.state()
  assert.equal(s.tunnel.state, 'error')
  assert.equal(s.tunnel.error, 'HTTP 503')
  assert.equal(calls.download, 1)

  await mobile.act({ action: 'newCode' })
  assert.equal(calls.download, 1)

  s = await mobile.act({ action: 'download' })
  assert.equal(calls.download, 2)
  assert.equal(s.tunnel.state, 'downloading')
  finish()
  await tick()
  assert.equal(calls.start, 1)
  await done()
})

test('系统没有现成的 cloudflared：不下载，只给局域网的码', async () => {
  const { mobile, calls, done } = await setup({ supported: false })
  const s = await mobile.act({ action: 'enable', on: true })
  assert.equal(calls.download, 0)
  assert.equal(s.tunnel.supported, false)
  assert.ok(s.lan.qr)
  await done()
})

test('DSH 退出：手机访问开着就把隧道留着（下次接着用）；关着就收掉', async () => {
  const a = await setup({ installed: true })
  await a.mobile.act({ action: 'enable', on: true })
  await a.mobile.shutdown()
  assert.equal(a.calls.detach, 1)
  assert.equal(a.calls.stop, 0)

  // 下次启动：照样开、照样起隧道（真的隧道会认回上次那个）
  const b = await setup({ installed: true, dir: a.dir })
  await b.mobile.boot()
  assert.equal(b.calls.start, 1)
  assert.equal(b.calls.stop, 0)
  await b.mobile.act({ action: 'tunnel', on: false })
  await b.mobile.shutdown()
  assert.equal(b.calls.detach, 0, '只走局域网就不留')

  // 关掉手机访问后再启动：把可能留着的收掉
  await b.mobile.act({ action: 'enable', on: false })
  const c = await setup({ installed: true, dir: a.dir })
  await c.mobile.boot()
  assert.equal(c.calls.start, 0)
  assert.ok(c.calls.stop >= 1)
  await c.done()
})

test('设备列表带在线状态', async () => {
  const { store, mobile, done } = await setup({ installed: true })
  await mobile.act({ action: 'enable', on: true })
  const code = store.currentCode()
  store.pair(code.value, { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })
  const s = mobile.state()
  assert.equal(s.devices.length, 1)
  assert.equal(s.devices[0].online, false)
  await done()
})

test('移除设备 / 全部移除：当前配对码一起作废', async () => {
  const { store, mobile, done } = await setup({ installed: true })
  await mobile.act({ action: 'enable', on: true })
  const code = store.currentCode().value
  const { device } = store.pair(code, {})
  const seen = store.currentCode().value // 手机可能看到过的码
  await mobile.act({ action: 'remove', id: device.id })
  assert.equal(store.pair(seen, {}), null)
  const seen2 = store.currentCode().value
  await mobile.act({ action: 'removeAll' })
  assert.equal(store.pair(seen2, {}), null)
  assert.equal(store.list().length, 0)
  await done()
})

const listening = (port) => new Promise((r) => { const c = net.connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); r(true) }); c.once('error', () => r(false)) })

test('刚打开就又关掉：网关不留监听、隧道不会被重新拉起', async () => {
  for (const gap of [() => null, () => new Promise((r) => setImmediate(r))]) {
    const { store, mobile, calls, done } = await setup({ installed: true })
    const on = mobile.act({ action: 'enable', on: true })
    await gap()
    const off = mobile.act({ action: 'enable', on: false })
    await Promise.all([on, off])
    const s = mobile.state()
    assert.equal(s.enabled, false)
    assert.equal(s.running, false)
    assert.equal(await listening(store.state.port), false)
    assert.equal(mobile.tunnel.status.state, 'off', '关掉之后隧道没被重新拉起')
    assert.ok(calls.stop >= calls.start)
    await done()
  }
})

test('停用 / 卸载插件：隧道跟着关；DSH 退出才留着', async () => {
  const { mobile, calls, done } = await setup({ installed: true })
  await mobile.act({ action: 'enable', on: true })
  await mobile.shutdown({ keep: false })
  assert.equal(calls.detach, 0)
  assert.ok(calls.stop >= 1)
  await done()

  const UNLOADING = 5
  const ACTIVE = 2
  const ctx = (rootState, uid, entry) => ({ root: { fiber: { state: rootState } }, fiber: { uid, entry } })
  assert.equal(keepTunnelOnDispose(ctx(UNLOADING, null)), true, 'DSH 退出：整棵树在拆')
  assert.equal(keepTunnelOnDispose(ctx(ACTIVE, null)), false, '只拆了这个插件、又不是 loader 起的')
  assert.equal(keepTunnelOnDispose(ctx(ACTIVE, 7)), true, '插件只是重启')
  assert.equal(keepTunnelOnDispose({}), true, '看不出来就照旧留着')

  // 照 cordis-plugin-loader 的样子搭条目：entry.options 在所在分组的 data 里；entry.disabled 连上层一起算
  const loaderFiber = { entry: undefined }
  const entryOf = (options, data, parentEntry) => {
    const e = { options, parent: { data, ctx: { fiber: parentEntry ? { entry: parentEntry } : loaderFiber } } }
    Object.defineProperty(e, 'disabled', { get: () => !!options.disabled || !!(parentEntry && parentEntry.disabled) })
    return e
  }
  const rootData = [{ id: 'mobile', name: 'dsh-mobile' }]
  const entry = entryOf(rootData[0], rootData)
  assert.equal(keepTunnelOnDispose(ctx(ACTIVE, null, entry)), true, '条目还在、没停用：HMR 换代码')
  rootData[0].disabled = true
  assert.equal(keepTunnelOnDispose(ctx(ACTIVE, null, entry)), false, '停用')
  assert.equal(keepTunnelOnDispose(ctx(ACTIVE, null, entryOf({ id: 'mobile' }, []))), false, '卸载：配置里没这条了')
  const groupData = [{ id: 'g', group: true }]
  const group = entryOf(groupData[0], groupData)
  const inner = [{ id: 'mobile' }]
  assert.equal(keepTunnelOnDispose(ctx(ACTIVE, null, entryOf(inner[0], inner, group))), true, '分组里的条目还在')
  groupData.length = 0
  assert.equal(keepTunnelOnDispose(ctx(ACTIVE, null, entryOf(inner[0], inner, group))), false, '整个分组被删了')
})

test('插件刚启动就被停用：启动流程收尾时不会再把隧道拉起来', async () => {
  const { store, mobile, calls, done } = await setup({ installed: true })
  store.setState({ enabled: true, tunnel: true })
  const booting = mobile.boot() // DSH 的 effect 里不 await
  await mobile.shutdown({ keep: false })
  await booting
  await tick(20)
  assert.equal(mobile.tunnel.status.state, 'off', '隧道没被重新拉起')
  assert.equal(calls.start, 0)
  assert.equal(mobile.gateway.running, false)
  await done()
})
