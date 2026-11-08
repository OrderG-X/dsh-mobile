/**
 * 「添加到主屏幕」用的图标。
 *   - 默认：蓝底、白色手机、屏幕上几条对话气泡。现画现编 PNG，不带图片文件、不引依赖。
 *     iPhone 只认 PNG 的 apple-touch-icon；安卓的 manifest 要 192 / 512。画在中间，安卓裁成圆的也不会切到。
 *   - 自定义：数据目录（~/.dsh/dsh-mobile/）里放一张 icon.png 就用它（#2）。只认这一个固定文件名，
 *     校验 PNG 文件头、不超过 2 MB；不合格或删掉了就回到默认图标。插件升级不会动数据目录，换的图标不会丢。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export const ICON_SIZES = [180, 192, 512]
export const CUSTOM_ICON = 'icon.png'
export const MAX_CUSTOM_ICON = 2 * 1024 * 1024
/** 默认图标的版本：图标地址带 ?v=，改了默认图标就改这个，手机不再拿缓存里的旧图 */
export const DEFAULT_ICON_VERSION = '2'

const SS = 4 // 每个像素 4×4 采样抗锯齿
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** 点到圆角矩形边的有向距离（里面是负的）：中心 (cx, cy)、半宽高 (hw, hh)、圆角 r */
function roundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r)
  const qy = Math.abs(y - cy) - (hh - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
/** 点到线段的距离 */
function segment(x, y, ax, ay, bx, by) {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)))
}
const mix = (a, b, t) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t)

const BG_A = [0x62, 0x80, 0xff] // 左上
const BG_B = [0x3b, 0x55, 0xe6] // 右下
const SHADOW = [0x1d, 0x2b, 0x8f]
const WHITE = [0xff, 0xff, 0xff]
const SCREEN = [0xee, 0xf1, 0xff]
const BUBBLE = [0xc9, 0xd3, 0xff]
const BLUE = [0x4d, 0x6b, 0xfe]
const BAR = [0xd3, 0xda, 0xf7]

/** 这一点的颜色（坐标 0..1）：从底往上一层层盖 */
function paint(x, y) {
  let c = mix(BG_A, BG_B, Math.min(1, Math.max(0, (x + y) / 2)))
  const shadow = roundRect(x, y, 0.5, 0.525, 0.2, 0.31, 0.075) // 机身往下错一点的软阴影
  if (shadow < 0.05) c = mix(c, SHADOW, 0.28 * Math.min(1, 1 - shadow / 0.05))
  if (roundRect(x, y, 0.5, 0.5, 0.2, 0.31, 0.075) > 0) return c // 机身外面
  if (segment(x, y, 0.47, 0.778, 0.53, 0.778) <= 0.008) return BAR // 底下那一横
  if (roundRect(x, y, 0.5, 0.485, 0.165, 0.255, 0.045) > 0) return WHITE // 边框
  // 屏幕上的对话：对方一条、自己一条（蓝）、对方正在输入（三个点）
  if (roundRect(x, y, 0.44, 0.375, 0.08, 0.042, 0.042) <= 0) return BUBBLE
  if (roundRect(x, y, 0.56, 0.487, 0.085, 0.042, 0.042) <= 0) return BLUE
  if (roundRect(x, y, 0.42, 0.6, 0.06, 0.042, 0.042) <= 0) {
    for (const dx of [0.39, 0.42, 0.45]) if (Math.hypot(x - dx, y - 0.6) <= 0.011) return BLUE
    return BUBBLE
  }
  return SCREEN
}

const cache = new Map()

/** size×size 的默认图标 PNG */
export function iconPng(size) {
  if (cache.has(size)) return cache.get(size)
  const row = size * 4 + 1
  const raw = Buffer.alloc(row * size)
  for (let py = 0; py < size; py++) {
    raw[py * row] = 0 // 不做行过滤
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0]
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = paint((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size)
          sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2]
        }
      }
      const o = py * row + 1 + px * 4
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(sum[i] / (SS * SS))
      raw[o + 3] = 255 // 不透明：iPhone 主屏会把透明的地方填成黑的
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // RGBA
  const png = Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
  cache.set(size, png)
  return png
}

/**
 * 主屏图标：有自定义的 icon.png 就用它，没有就用默认的。
 * 每次取都看一眼文件（stat 很便宜），换了图不用重启 DSH；内容按修改时间和大小缓存。
 * @param dir   数据目录（store.dir）
 * @param log   自定义图标不合格时说一声（同一个文件只说一次）
 */
export function createIcons(dir, { log = () => {} } = {}) {
  const file = path.join(dir, CUSTOM_ICON)
  let cached = null // { key, buf, version }
  let warned = ''
  function custom() {
    let st
    try { st = fs.statSync(file) } catch { cached = null; return null }
    const key = `${st.mtimeMs}:${st.size}`
    if (cached && cached.key === key) return cached
    const reject = (why) => {
      cached = null
      if (warned !== key) { warned = key; log(`自定义主屏图标没用上（${why}），用默认图标：${file}`) }
      return null
    }
    if (!st.isFile()) return reject('不是文件')
    if (st.size > MAX_CUSTOM_ICON) return reject('超过 2 MB')
    let buf
    try { buf = fs.readFileSync(file) } catch (e) { return reject(`读不了：${e.code || e.message}`) }
    if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG)) return reject('不是 PNG')
    cached = { key, buf, version: `c${Math.round(st.mtimeMs).toString(36)}${st.size.toString(36)}` }
    return cached
  }
  return {
    file,
    /** { png, custom }：自定义的不管要哪个尺寸都给同一张，浏览器自己缩 */
    get(size) {
      const c = custom()
      return c ? { png: c.buf, custom: true } : { png: iconPng(size), custom: false }
    },
    /** 图标地址上的 ?v=：换了图（或默认图标改版）就变，手机不会再拿缓存里的旧图 */
    version() {
      const c = custom()
      return c ? c.version : DEFAULT_ICON_VERSION
    },
  }
}
