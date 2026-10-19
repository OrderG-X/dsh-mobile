/**
 * 网关自己出的两个小东西：没配对时看到的配对页，和插进 DSH 首页的 boot.js。
 * 都不引外部资源（手机可能连不上外网的 CDN），中英文按手机语言挑。
 */

export const PAIR_PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>DSH</title>
<style>
:root{color-scheme:light dark;--bg:#f5f6f8;--card:#fff;--ink:#111;--sub:#6b7280;--blue:#4D6BFE}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--ink:#e6edf3;--sub:#8b949e}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;
 background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",Roboto,sans-serif;text-align:center}
.card{width:100%;max-width:360px;background:var(--card);border-radius:20px;padding:32px 24px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
.logo{width:56px;height:56px;margin:0 auto 16px;border-radius:16px;background:var(--blue);display:grid;place-items:center}
h1{font-size:19px;margin:0 0 6px}
p{margin:0;color:var(--sub);font-size:14px}
.spin{width:22px;height:22px;margin:18px auto 0;border:3px solid color-mix(in srgb,var(--blue) 25%,transparent);border-top-color:var(--blue);border-radius:50%;animation:s 0.8s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
</style></head>
<body><div class="card">
<div class="logo"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg></div>
<h1 id="t"></h1><p id="d"></p><div class="spin" id="spin" hidden></div>
</div>
<script>
(function () {
  var zh = /^zh/i.test(navigator.language || '')
  var T = {
    scan: zh ? ['用电脑上的 DSH 扫码', '在电脑上打开 DSH →「插件」→「手机端」，用手机扫那里的二维码。'] : ['Scan from DSH on your computer', 'Open DSH on your computer → Plugins → Mobile, then scan the QR code there.'],
    wait: zh ? ['正在连接电脑…', ''] : ['Connecting to your computer…', ''],
    expired: zh ? ['二维码失效了', '二维码只能用一次、10 分钟内有效。回电脑上点「换一个」，重新扫。'] : ['This QR code has expired', 'Each code works once, within 10 minutes. Get a new one in DSH on your computer and scan again.'],
    rate: zh ? ['试得太多了', '请过几分钟再扫。'] : ['Too many attempts', 'Wait a few minutes, then scan again.'],
    network: zh ? ['连不上电脑', '确认电脑没睡眠、DSH 开着；用局域网二维码时手机要连同一个 Wi-Fi。'] : ['Cannot reach your computer', 'Make sure the computer is awake and DSH is open. For the Wi-Fi code, the phone must be on the same network.'],
  }
  function show(k, busy) {
    document.getElementById('t').textContent = T[k][0]
    document.getElementById('d').textContent = T[k][1]
    document.getElementById('spin').hidden = !busy
    document.title = T[k][0]
  }
  function run() {
    var m = /[#&]pair=([A-Za-z0-9_-]{8,64})/.exec(location.hash)
    if (!m) return show('scan')
    // 配对码别留在地址栏和历史记录里
    try { history.replaceState(null, '', location.pathname + location.search) } catch (e) {}
    show('wait', true)
    fetch('/__dshm/pair', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: m[1] }) })
      .then(function (r) { return r.json().catch(function () { return {} }).then(function (j) { return { ok: r.ok, j: j } }) })
      .then(function (x) { if (x.ok) location.replace('/'); else show(x.j && x.j.error === 'rate' ? 'rate' : 'expired') })
      .catch(function () { show('network') })
  }
  run()
  // 已经停在这个页面上又扫了一次（只有 # 后面变了，页面不会重新加载）
  window.addEventListener('hashchange', run)
})()
</script>
</body></html>`

/**
 * 插在 DSH 首页 <head> 最前面（普通脚本，比页面自己的 module 脚本先跑）。
 *   - 局域网是明文 HTTP，不算「安全上下文」，crypto.randomUUID 没有 → 补上（官方界面要用）
 *   - 标一下 data-dsh-mobile，样式可以按需针对手机
 */
export const BOOT_JS = `(function () {
  try {
    var c = window.crypto
    if (c && typeof c.randomUUID !== 'function' && typeof c.getRandomValues === 'function') {
      c.randomUUID = function () {
        var b = c.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80
        var h = []; for (var i = 0; i < 16; i++) h.push((b[i] >> 4).toString(16), (b[i] & 15).toString(16))
        return h.slice(0, 8).join('') + '-' + h.slice(8, 12).join('') + '-' + h.slice(12, 16).join('') + '-' + h.slice(16, 20).join('') + '-' + h.slice(20, 32).join('')
      }
    }
  } catch (e) {}
  try { document.documentElement.setAttribute('data-dsh-mobile', '') } catch (e) {}
})()
`

export const BOOT_TAG = '<script src="/__dshm/boot.js"></script>'

/** 把 boot.js 插到 <head> 紧后面；没有 <head> 就放最前面 */
export function injectBoot(html) {
  if (html.includes(BOOT_TAG)) return html
  const m = /<head[^>]*>/i.exec(html)
  return m ? html.slice(0, m.index + m[0].length) + BOOT_TAG + html.slice(m.index + m[0].length) : BOOT_TAG + html
}
