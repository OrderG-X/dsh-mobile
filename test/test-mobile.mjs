// 设置页背后的逻辑：打开手机访问就把外网备好（没 cloudflared 自动下），一个二维码 Wi-Fi 和流量都能扫
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { createMobile } from '../lib/index.js'

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
