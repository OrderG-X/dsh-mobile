/**
 * 手机端的持久数据：开关状态 + 已配对的设备，外加内存里的一次性配对码。
 *
 *   $DSH_HOME/dsh-mobile/state.json     { enabled, tunnel, lanOnly, port }
 *   $DSH_HOME/dsh-mobile/devices.json   [{ id, name, hash, host, created, lastSeen, lastIp, via }]（0600）
 *
 * 设备凭证 = Cookie `<id>.<secret>`：盘上只存 secret 的 sha256，拿到文件也冒充不了手机。
 * 配对码 128 位随机、10 分钟有效、用一次就作废；同一时间只有一个「当前」配对码，被用掉或过期才换新的。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CODE_TTL_MS = 10 * 60 * 1000
const MAX_DEVICES = 20
const SEEN_SAVE_MS = 60 * 1000

export function dataDir(env = process.env) {
  const home = env.DSH_HOME || path.join(env.HOME || os.homedir(), '.dsh')
  return path.join(home, 'dsh-mobile')
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, mode) } catch {}
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')

function same(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/** 从 User-Agent 猜个好认的名字：「iPhone · Safari」「Android · Chrome」 */
export function deviceName(ua = '') {
  const s = String(ua)
  const os =
    /iPhone/.test(s) ? 'iPhone'
      : /iPad/.test(s) ? 'iPad'
        : /Android/.test(s) ? (/Mobile/.test(s) ? 'Android' : 'Android 平板')
          : /Macintosh/.test(s) ? 'Mac'
            : /Windows/.test(s) ? 'Windows'
              : /Linux/.test(s) ? 'Linux' : '设备'
  const app =
    /MicroMessenger/.test(s) ? '微信'
      : /EdgA?\//.test(s) ? 'Edge'
        : /CriOS|Chrome\//.test(s) ? 'Chrome'
          : /FxiOS|Firefox\//.test(s) ? 'Firefox'
            : /Safari\//.test(s) ? 'Safari' : ''
  return app ? `${os} · ${app}` : os
}

/**
 * @param opts.dir   数据目录（测试用临时目录）
 * @param opts.now   时钟（测试可换）
 */
export function createStore({ dir = dataDir(), now = Date.now } = {}) {
  const stateFile = path.join(dir, 'state.json')
  const devicesFile = path.join(dir, 'devices.json')
  let state = { enabled: false, tunnel: false, lanOnly: false, port: 0, ...readJson(stateFile, {}) }
  const saved = readJson(devicesFile, [])
  let devices = Array.isArray(saved) ? saved.filter((d) => d && typeof d.id === 'string' && typeof d.hash === 'string') : []
  let code = null // { value, expires }
  let seenDirty = false
  let seenTimer = null

  function saveState() { writeJson(stateFile, state) }
  function saveDevices() { writeJson(devicesFile, devices) }

  function setState(patch) {
    state = { ...state, ...patch }
    saveState()
    return state
  }

  /** 当前配对码；没有、过期了或用掉了就换一个新的 */
  function currentCode() {
    if (!code || code.expires <= now()) code = { value: crypto.randomBytes(16).toString('base64url'), expires: now() + CODE_TTL_MS }
    return { ...code }
  }

  /** 作废当前配对码（「换一个」按钮、关掉手机访问时） */
  function resetCode() { code = null }

  /**
   * 用配对码换一台设备。码不对 / 过期 → null。成功后码立刻作废。
   * @returns { device, cookie }
   */
  function pair(value, { ua = '', ip = '', via = 'lan', host = '' } = {}) {
    if (!code || code.expires <= now() || typeof value !== 'string' || !same(value, code.value)) return null
    code = null
    const id = crypto.randomBytes(6).toString('base64url')
    const secret = crypto.randomBytes(32).toString('base64url')
    const device = { id, name: deviceName(ua), hash: sha(secret), host: String(host).toLowerCase(), created: now(), lastSeen: now(), lastIp: ip, via }
    devices.push(device)
    // 设备太多就挤掉最久没用的
    if (devices.length > MAX_DEVICES) devices = devices.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_DEVICES)
    saveDevices()
    return { device: publicDevice(device), cookie: `${id}.${secret}` }
  }

  /** Cookie 值 → 设备（不对给 null）；顺手记一下最近一次出现 */
  function check(cookie, { ip = '', via } = {}) {
    if (typeof cookie !== 'string') return null
    const dot = cookie.indexOf('.')
    if (dot <= 0) return null
    const id = cookie.slice(0, dot)
    const d = devices.find((x) => x.id === id)
    if (!d || !same(sha(cookie.slice(dot + 1)), d.hash)) return null
    const t = now()
    if (t - d.lastSeen > 5000 || d.lastIp !== ip || (via && d.via !== via)) {
      d.lastSeen = t
      d.lastIp = ip
      if (via) d.via = via
      markSeen()
    }
    return publicDevice(d)
  }

  // lastSeen 变得很频繁：攒一会儿再写盘
  function markSeen() {
    seenDirty = true
    if (seenTimer) return
    seenTimer = setTimeout(() => {
      seenTimer = null
      if (seenDirty) { seenDirty = false; try { saveDevices() } catch {} }
    }, SEEN_SAVE_MS)
    if (seenTimer.unref) seenTimer.unref()
  }

  function flush() {
    if (seenTimer) { clearTimeout(seenTimer); seenTimer = null }
    if (seenDirty) { seenDirty = false; try { saveDevices() } catch {} }
  }

  function remove(id) {
    const before = devices.length
    devices = devices.filter((d) => d.id !== id)
    if (devices.length !== before) saveDevices()
    return devices.length !== before
  }

  /** 删掉配对在某些地址上的设备（外网地址换了，旧地址上配的手机再也用不上） */
  function pruneHosts(pred) {
    const before = devices.length
    devices = devices.filter((d) => !(d.host && pred(d.host)))
    if (devices.length !== before) saveDevices()
    return before - devices.length
  }

  function removeAll() {
    const n = devices.length
    devices = []
    saveDevices()
    return n
  }

  function list() {
    return devices.slice().sort((a, b) => b.lastSeen - a.lastSeen).map(publicDevice)
  }

  return {
    get state() { return { ...state } },
    setState,
    currentCode,
    resetCode,
    pair,
    check,
    remove,
    removeAll,
    pruneHosts,
    list,
    flush,
    dir,
  }
}

function publicDevice(d) {
  return { id: d.id, name: d.name, host: d.host || '', created: d.created, lastSeen: d.lastSeen, lastIp: d.lastIp, via: d.via }
}
