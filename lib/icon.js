/**
 * 「添加到主屏幕」用的图标：蓝底白色手机（和配对页的图标一样），现画现编 PNG，不带图片文件、不引依赖。
 * iPhone 只认 PNG 的 apple-touch-icon；安卓的 manifest 要 192 / 512。画在中间 60% 里，安卓裁成圆的也不会切到。
 */

import zlib from 'node:zlib'

const BLUE = [0x4d, 0x6b, 0xfe]
const SS = 4 // 每个像素 4×4 采样抗锯齿

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
/** 这一点是不是白色（坐标 0..1） */
function white(x, y) {
  const stroke = 0.042
  const d = roundRect(x, y, 0.5, 0.5, 0.18, 0.29, 0.07)
  if (Math.abs(d) <= stroke / 2) return true // 机身轮廓
  return segment(x, y, 0.455, 0.7, 0.545, 0.7) <= stroke / 2 // 底下那一横
}

const cache = new Map()

/** size×size 的 PNG */
export function iconPng(size) {
  if (cache.has(size)) return cache.get(size)
  const row = size * 4 + 1
  const raw = Buffer.alloc(row * size)
  for (let py = 0; py < size; py++) {
    raw[py * row] = 0 // 不做行过滤
    for (let px = 0; px < size; px++) {
      let hit = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (white((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size)) hit++
        }
      }
      const a = hit / (SS * SS)
      const o = py * row + 1 + px * 4
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(BLUE[i] + (255 - BLUE[i]) * a)
      raw[o + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
  cache.set(size, png)
  return png
}

export const ICON_SIZES = [180, 192, 512]
