// 隧道管理：用假的 cloudflared 进程测「拿到地址 → 掉了重启 → 关掉」，不连网
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTunnel, assetFor, killStale } from '../lib/tunnel.js'

function fakeSpawn() {
  const kids = []
  const spawnImpl = (bin, args) => {
    const c = new EventEmitter()
    c.stdout = new EventEmitter()
    c.stderr = new EventEmitter()
    c.pid = 999999
    c.args = args
    c.kill = () => setImmediate(() => c.emit('exit', 0))
    kids.push(c)
    return c
  }
  return { kids, spawnImpl }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

test('拿到 trycloudflare 地址就算开了；进程掉了自动重启；关掉就杀', async () => {
  const { kids, spawnImpl } = fakeSpawn()
  const changes = []
  const t = createTunnel({ bin: () => '/x/cloudflared', target: () => 'http://127.0.0.1:18765', spawnImpl, onChange: (s) => changes.push(s) })
  t.start()
  assert.equal(t.status.state, 'starting')
  assert.deepEqual(kids[0].args.slice(0, 4), ['tunnel', '--no-autoupdate', '--protocol', 'http2'])
  assert.equal(kids[0].args.at(-1), 'http://127.0.0.1:18765')
  kids[0].stderr.emit('data', Buffer.from('INF |  https://some-words-here.trycloudflare.com  |\n'))
  assert.equal(t.status.state, 'on')
  assert.equal(t.status.url, 'https://some-words-here.trycloudflare.com')
  kids[0].emit('exit', 1)
  assert.equal(t.status.state, 'error')
  await new Promise((r) => setTimeout(r, 2100))
  assert.equal(kids.length, 2)
  t.stop()
  await tick()
  assert.equal(t.status.state, 'off')
  assert.ok(changes.some((s) => s.state === 'on'))
})

test('没有 cloudflared：状态是 missing，不启动', () => {
  const { kids, spawnImpl } = fakeSpawn()
  const t = createTunnel({ bin: () => null, target: () => 'http://127.0.0.1:1', spawnImpl })
  t.start()
  assert.equal(t.status.state, 'missing')
  assert.equal(kids.length, 0)
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
