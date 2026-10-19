/** 本机在局域网里的地址（跟设计工作台 lib/phone.js 同一套挑法）。 */

import os from 'node:os'

/** 本机在局域网里的 IPv4：优先私有网段（192.168 / 10 / 172.16–31），Wi-Fi / 有线网卡在前；没有给 '' */
export function lanAddress(ifaces = os.networkInterfaces()) {
  const cands = []
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const a of list || []) {
      const v4 = a.family === 'IPv4' || a.family === 4
      if (!v4 || a.internal || /^169\.254\./.test(a.address)) continue
      const priv = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)
      const virtual = /^(utun|bridge|vmnet|vbox|docker|veth|tailscale|zt|llw|awdl|anpi|ap\d)/i.test(name)
      cands.push({ ip: a.address, score: (priv ? 0 : 10) + (virtual ? 5 : 0) + (/^(en|eth|wlan|wl|Wi-?Fi|以太网)/i.test(name) ? 0 : 1) })
    }
  }
  cands.sort((a, b) => a.score - b.score)
  return cands.length ? cands[0].ip : ''
}
