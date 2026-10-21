/**
 * dsh-mobile 的网页端：DSH「插件」页里「手机端」这张卡的设置页。
 *
 *   开关：允许手机访问
 *   二维码：只有一个。外网通道（Cloudflare 隧道）好了就是 Wi-Fi 和流量都能扫的码，
 *           准备中或选了「只在同一 Wi-Fi」就先给局域网的码；扫一次就作废，10 分钟过期
 *   已配对的手机：名字、怎么连的、最近一次出现，随时移除
 *
 * 会话顶栏还有一个手机按钮：点开就是同一个二维码 + 连接状态 + 复制链接；有手机连着时亮绿点。
 *
 * 数据走插件挂在 DSH webServer 上的路由（lib/index.js 的 panelHandler），每 2.5 秒刷一次。
 * 跟 dsh-chrome-bridge 一样走官方客户端插件机制：注册到 plugins.bundle.config / plugins.row.config；
 * 顶栏按钮注册到 conversation.session.header.utilities。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const opt = (id) => { try { return require(id) } catch (_) { return null } }
    const React = opt('react')
    if (!React) {
      exports.apply = () => {}
      exports.inject = ['slots', 'locale']
      return module.exports
    }
    const UI = opt('@deepseek-ai/dsh-client-ui-primitives') || {}
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React
    const ReactDOM = opt('react-dom')

    const PKG = 'dsh-mobile'
    const ROW = 'mobile'
    const NS = 'dsh-mobile'
    const ROUTE = '/dsh-mobile/panel'
    const REPO = 'https://github.com/OrderG-X/dsh-mobile'

    const zh = {
      checking: '正在检查…',
      enable: '允许手机访问',
      enableHint: '打开后用手机相机扫下面的二维码，就能在手机浏览器里看这台电脑上的任务、接着发消息、批准操作。在家连 Wi-Fi、出门用流量都行。',
      summaryOff: '未开启：打开后手机扫码就能用',
      summaryOn: '已开启 · %n 台手机',
      summaryOnNone: '已开启，还没有手机配对',
      scan: '用手机相机扫码',
      scanHint: '二维码只能用一次，10 分钟内有效（还剩 %m 分钟）。',
      anywhere: 'Wi-Fi 和流量都能用',
      lanOnlyTag: '只能同一 Wi-Fi',
      preparing: '外网准备中',
      lanHint: '手机要和这台电脑连同一个 Wi-Fi。',
      prepDownload: '正在准备外网：下载 Cloudflare 的 cloudflared（%p）。好了二维码会自动换成流量也能扫的；现在这个码只能同一 Wi-Fi 用。',
      prepStart: '正在连接 Cloudflare…好了二维码会自动换成流量也能扫的；现在这个码只能同一 Wi-Fi 用。',
      prepFailed: 'cloudflared 没下载成功：%e。现在这个码只能同一 Wi-Fi 用。',
      tunnelError: '外网没连上：%e，会自动重试。现在这个码只能同一 Wi-Fi 用。',
      unsupported: '这台电脑的系统没有现成的 cloudflared，只能同一 Wi-Fi 用。',
      noLan: '没检测到局域网；外网准备好就会出现二维码。',
      starting: '正在打开…',
      newCode: '换一个',
      retry: '重试',
      outside: '外网也能用',
      outsideHint: '走 Cloudflare 免费隧道，不用注册。第一次会自动下载它的官方程序 cloudflared（约 20 MB）。DSH 重启后地址不变，手机不用重扫；电脑重启后地址会换，要重新扫一次。',
      headTip: '手机访问',
      copy: '复制链接',
      copied: '已复制。10 分钟内在手机上打开，只能用一次。',
      phoneOnline: '手机已连接：%s',
      phoneWaiting: '等待手机扫码',
      phonePaired: '已配对 %n 台手机，手机上打开页面就会连上',
      online: '在线',
      manage: '管理手机：插件 → 手机端',
      devices: '已配对的手机',
      noDevices: '还没有手机配对。',
      viaLan: 'Wi-Fi',
      viaTunnel: '外网',
      viaLocal: '本机',
      justNow: '刚刚在用',
      minutesAgo: '%n 分钟前',
      hoursAgo: '%n 小时前',
      daysAgo: '%n 天前',
      remove: '移除',
      removeAll: '全部移除',
      removed: '已移除，那台手机马上断开',
      safety: '扫过码的手机能让 DSH 在这台电脑上干活（和你坐在电脑前一样）。只给自己的手机扫；手机丢了就在这里移除。',
      plugin: '插件 v%v',
      guide: '使用说明',
      failed: '操作没成功：%e',
      unreachable: '读不到插件状态，重启 DSH 后再试',
      desktopOnly: '手机访问只能在电脑上的 DSH 里管理。',
    }
    const en = {
      checking: 'Checking…',
      enable: 'Allow phone access',
      enableHint: 'Turn it on, scan the code below with your phone camera, and use this computer\'s DSH from the phone browser: watch tasks, reply, approve. Works on Wi-Fi at home and on mobile data outside.',
      summaryOff: 'Off: turn it on and scan with your phone',
      summaryOn: 'On · %n phone(s)',
      summaryOnNone: 'On, no phone paired yet',
      scan: 'Scan with your phone camera',
      scanHint: 'Each code works once, within 10 minutes (%m min left).',
      anywhere: 'Wi-Fi or mobile data',
      lanOnlyTag: 'Same Wi-Fi only',
      preparing: 'Setting up outside access',
      lanHint: 'The phone must be on the same Wi-Fi as this computer.',
      prepDownload: 'Setting up outside access: downloading Cloudflare\'s cloudflared (%p). The code switches to one that works on mobile data when ready; this one only works on the same Wi-Fi.',
      prepStart: 'Connecting to Cloudflare… The code switches to one that works on mobile data when ready; this one only works on the same Wi-Fi.',
      prepFailed: 'Could not download cloudflared: %e. This code only works on the same Wi-Fi.',
      tunnelError: 'Outside access not connected: %e. Retrying automatically. This code only works on the same Wi-Fi.',
      unsupported: 'There is no cloudflared build for this system, so only the same Wi-Fi works.',
      noLan: 'No local network found; the code appears once outside access is ready.',
      starting: 'Starting…',
      newCode: 'New code',
      retry: 'Retry',
      outside: 'Also work outside',
      outsideHint: 'Uses a free Cloudflare tunnel, no account. The first time, Cloudflare\'s official cloudflared (about 20 MB) is downloaded automatically. The address stays the same when DSH restarts; it changes when the computer restarts, so scan again then.',
      headTip: 'Phone access',
      copy: 'Copy link',
      copied: 'Copied. Open it on your phone within 10 minutes; it works once.',
      phoneOnline: 'Phone connected: %s',
      phoneWaiting: 'Waiting for a phone to scan',
      phonePaired: '%n phone(s) paired; they connect when the page is opened',
      online: 'Online',
      manage: 'Manage phones: Plugins → Mobile',
      devices: 'Paired phones',
      noDevices: 'No phone paired yet.',
      viaLan: 'Wi-Fi',
      viaTunnel: 'Anywhere',
      viaLocal: 'Local',
      justNow: 'Active now',
      minutesAgo: '%n min ago',
      hoursAgo: '%n h ago',
      daysAgo: '%n d ago',
      remove: 'Remove',
      removeAll: 'Remove all',
      removed: 'Removed; that phone is disconnected now',
      safety: 'A paired phone can make DSH work on this computer, just like sitting at it. Only scan with your own phone; remove it here if it gets lost.',
      plugin: 'Plugin v%v',
      guide: 'Guide',
      failed: 'That did not work: %e',
      unreachable: 'Could not read the plugin status; restart DSH and try again',
      desktopOnly: 'Phone access can only be managed in DSH on the computer.',
    }

    const fmt = (s, vars) => String(s).replace(/%([a-z])/g, (m, k) => (vars && k in vars ? String(vars[k]) : m))
    // 手机上打开的页面（网关插的 boot.js 打的标记）：设置接口网关不给手机用，这里也就不去读
    const onPhone = () => typeof document !== 'undefined' && !!document.documentElement && document.documentElement.hasAttribute('data-dsh-mobile')

    const CSS = `
.dmb{display:grid;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dmb-card{border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l));background:var(--dsw-alias-settings-card-fill,transparent);border-radius:12px;overflow:hidden}
.dmb-row{display:flex;align-items:flex-start;gap:12px;padding:12px 14px}
.dmb-row+.dmb-row{border-top:1px solid var(--dsw-alias-border-l)}
.dmb-main{flex:1;min-width:0;display:grid;gap:2px}
.dmb-title{font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dmb-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.dmb-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}
.dmb-chip{font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dmb-chip[data-tone=ok]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34c759) 16%,transparent);color:var(--dsw-alias-state-success-primary,#34c759)}
.dmb-chip[data-tone=wait]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#ff9f0a) 16%,transparent);color:var(--dsw-alias-state-warn-primary,#ff9f0a)}
.dmb-qrwrap{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.dmb-qr{width:176px;height:176px;flex:none;border-radius:12px;background:#fff;padding:6px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l)}
.dmb-qr svg{display:block;width:100%;height:100%}
.dmb-qrside{flex:1;min-width:180px;display:grid;gap:6px}
.dmb-url{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all;user-select:all}
.dmb-dev{display:flex;align-items:center;gap:10px;padding:8px 14px}
.dmb-dev+.dmb-dev{border-top:1px solid var(--dsw-alias-border-l)}
.dmb-tag{font-size:11px;font-weight:500;padding:0 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l);color:var(--dsw-alias-label-secondary)}
.dmb-note{font-size:12px;padding:8px 12px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#ff9f0a) 12%,transparent);color:var(--dsw-alias-label-primary)}
.dmb-note[data-tone=ok]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#34c759) 12%,transparent)}
.dmb-note[data-tone=err]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ff453a) 12%,transparent)}
.dmb-foot{display:flex;gap:10px;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dmb-foot a{color:var(--dsw-alias-link);text-decoration:none}
.dmb-foot a:hover{text-decoration:underline}
.dmb-btn{font:inherit;font-size:12px;padding:4px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}
.dmb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dmb-btn:disabled{opacity:.45;cursor:default}
.dmb-switch{flex:none;margin-top:2px}
.dmb-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.dmb-dot[data-s=on]{background:var(--dsw-alias-state-success-primary,#34c759)}
.dmb-dot[data-s=wait]{background:var(--dsw-alias-state-warn-primary,#ff9f0a)}
.dmb-live{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dmb-btns{display:flex;gap:8px;flex-wrap:wrap}
.dmb-head{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;position:relative;padding:0}
.dmb-head:hover,.dmb-head[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}
.dmb-head svg{width:16px;height:16px}
.dmb-head[data-s]::after{content:"";position:absolute;right:5px;top:5px;width:6px;height:6px;border-radius:50%;box-shadow:0 0 0 1.5px var(--dsw-alias-bg-base,transparent)}
.dmb-head[data-s=on]::after{background:var(--dsw-alias-state-success-primary,#34c759)}
.dmb-head[data-s=wait]::after{background:var(--dsw-alias-state-warn-primary,#ff9f0a)}
.dmb-pop{position:fixed;z-index:1100;width:300px;max-width:calc(100vw - 16px);overflow:auto;box-sizing:border-box;padding:14px;border:0;border-radius:var(--dsw-radius-panel,14px);background:var(--dsw-alias-bg-layer-2,#2c2c2e);--dsw-elevation-stroke-color:var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.3));display:grid;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dmb-pop .dmb-qrwrap{flex-direction:column;align-items:stretch;gap:10px}
.dmb-pop .dmb-qr{width:200px;height:200px;align-self:center}
.dmb-pop .dmb-qrside{min-width:0}
.dmb-pophead{display:flex;align-items:center;gap:10px}
.dmb-pophead .dmb-title{flex:1}`
    function ensureCss() {
      if (typeof document === 'undefined' || document.querySelector('style[data-plugin-css="dsh-mobile"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = PKG
      tag.dataset.pluginCss = 'dsh-mobile'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function Toggle({ checked, disabled, label, onChange }) {
      if (UI.Switch) return h('span', { className: 'dmb-switch' }, h(UI.Switch, { checked, disabled, label, onChange }))
      return h('input', { className: 'dmb-switch', type: 'checkbox', role: 'switch', 'aria-label': label, checked, disabled, onChange: (e) => onChange(e.target.checked) })
    }
    function Btn({ onClick, disabled, children, primary }) {
      if (UI.Button) return h(UI.Button, { variant: primary ? 'primary' : 'outline', size: 'sm', disabled, onClick }, children)
      return h('button', { type: 'button', className: 'dmb-btn', disabled, onClick }, children)
    }
    function Qr({ qr, label }) {
      return h('div', { className: 'dmb-qr', role: 'img', 'aria-label': label },
        h('svg', { viewBox: `0 0 ${qr.size} ${qr.size}`, shapeRendering: 'crispEdges' },
          h('rect', { width: qr.size, height: qr.size, fill: '#fff' }),
          h('path', { d: qr.path, fill: '#000' })))
    }

    async function fetchState(action) {
      const res = await fetch(ROUTE, action
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action), credentials: 'same-origin' }
        : { credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    function useMobileState(interval = 2500) {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const alive = useRef(true)
      const load = useCallback(async () => {
        try {
          const s = await fetchState()
          if (alive.current) { setState(s); setError('') }
        } catch (e) {
          if (alive.current) setError(String((e && e.message) || e))
        }
      }, [])
      useEffect(() => {
        alive.current = true
        load()
        const timer = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') load()
        }, interval)
        return () => { alive.current = false; clearInterval(timer) }
      }, [load, interval])
      const act = useCallback(async (action) => {
        const s = await fetchState(action)
        if (alive.current) setState(s)
        return s
      }, [])
      return { state, error, act }
    }

    function ago(t, ts) {
      const m = Math.floor((Date.now() - ts) / 60000)
      if (m < 2) return t('justNow')
      if (m < 60) return fmt(t('minutesAgo'), { n: m })
      if (m < 48 * 60) return fmt(t('hoursAgo'), { n: Math.floor(m / 60) })
      return fmt(t('daysAgo'), { n: Math.floor(m / 1440) })
    }

    /** 现在该给哪个码、配什么标签和说明：设置页和顶栏弹窗共用 */
    function scanInfo(t, state) {
      const tun = state.tunnel || {}
      const lan = state.lan || {}
      const ready = !!(tun.on && tun.state === 'on' && tun.qr)
      const d = tun.download
      let tag = null
      let status = ''
      let retry = false
      if (ready) tag = { tone: 'ok', text: t('anywhere') }
      else if (!tun.on) { tag = { text: t('lanOnlyTag') }; status = t('lanHint') }
      else if (!tun.supported) { tag = { text: t('lanOnlyTag') }; status = t('unsupported') }
      else {
        tag = { tone: 'wait', text: t('preparing') }
        if (d && d.error) { status = fmt(t('prepFailed'), { e: d.error }); retry = true }
        else if (d) status = fmt(t('prepDownload'), { p: d.total ? `${Math.round((d.got / d.total) * 100)}%` : `${(d.got / 1048576).toFixed(1)} MB` })
        else if (tun.state === 'error') status = fmt(t('tunnelError'), { e: tun.error || '?' })
        else status = t('prepStart')
      }
      return { tag, status, retry, qr: ready ? tun.qr : lan.qr, base: ready ? tun.base : lan.base, url: ready ? tun.url : lan.url }
    }

    const onlineOf = (state) => (state && state.devices ? state.devices.filter((d) => d.online) : [])

    function copyText(text) {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).catch(() => legacyCopy(text))
      }
      return Promise.resolve(legacyCopy(text))
    }
    function legacyCopy(text) {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } finally { ta.remove() }
    }

    /** 点按钮 → 发一个操作，期间按钮变灰，失败了给一句提示 */
    function useRunner(act, t) {
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)
      const run = async (action, ok) => {
        setBusy(true)
        try {
          const s = await act(action)
          if (s.actionError) setNote({ tone: 'err', text: fmt(t('failed'), { e: s.actionError }) })
          else setNote(ok ? { tone: 'ok', text: ok } : null)
        } catch (e) {
          setNote({ tone: 'err', text: fmt(t('failed'), { e: String((e && e.message) || e) }) })
        } finally {
          setBusy(false)
        }
      }
      return { busy, note, run }
    }

    /** 连接状态一行：手机已连接 / 已配对等打开 / 等待扫码 */
    function LiveLine({ t, state }) {
      const on = onlineOf(state)
      const paired = (state.devices || []).length
      const text = on.length ? fmt(t('phoneOnline'), { s: on.map((d) => d.name).join('、') })
        : paired ? fmt(t('phonePaired'), { n: paired }) : t('phoneWaiting')
      return h('div', { className: 'dmb-live' }, h('span', { className: 'dmb-dot', 'data-s': on.length ? 'on' : 'wait' }), text)
    }

    /** 二维码 + 状态 + 复制链接 / 换一个 */
    function ScanBlock({ t, state, busy, run, compact }) {
      const [copied, setCopied] = useState(false)
      useEffect(() => {
        if (!copied) return undefined
        const x = setTimeout(() => setCopied(false), 5000)
        return () => clearTimeout(x)
      }, [copied])
      if (!state.running) return h('p', { className: 'dmb-hint' }, t('starting'))
      const info = scanInfo(t, state)
      if (!info.qr) return h('p', { className: 'dmb-hint' }, t('noLan'))
      const left = Math.max(1, Math.ceil(((state.codeExpires || 0) - Date.now()) / 60000))
      return h('div', { className: 'dmb-qrwrap' },
        h(Qr, { qr: info.qr, label: t('scan') }),
        h('div', { className: 'dmb-qrside' },
          h('div', { className: 'dmb-title' }, t('scan'), info.tag ? h('span', { className: 'dmb-chip', 'data-tone': info.tag.tone }, info.tag.text) : null),
          h(LiveLine, { t, state }),
          h('p', { className: 'dmb-hint' }, copied ? t('copied') : fmt(t('scanHint'), { m: left })),
          info.status ? h('p', { className: 'dmb-hint' }, info.status) : null,
          compact ? null : h('div', { className: 'dmb-url' }, info.base),
          h('div', { className: 'dmb-btns' },
            h(Btn, { disabled: busy || !info.url, onClick: () => copyText(info.url).then(() => setCopied(true)) }, t('copy')),
            h(Btn, { disabled: busy, onClick: () => run({ action: 'newCode' }) }, t('newCode')),
            info.retry ? h(Btn, { disabled: busy, onClick: () => run({ action: 'download' }) }, t('retry')) : null)))
    }

    function Summary({ t }) {
      const { state } = useMobileState(10000)
      if (!state) return t('checking')
      if (!state.enabled) return t('summaryOff')
      const n = state.devices ? state.devices.length : 0
      return n ? fmt(t('summaryOn'), { n }) : t('summaryOnNone')
    }

    function Page({ t }) {
      const { state, error, act } = useMobileState()
      const { busy, note, run } = useRunner(act, t)

      if (!state) {
        return h('div', { className: 'dmb' }, h('div', { className: 'dmb-note', 'data-tone': error ? 'err' : undefined }, error ? t('unreachable') : t('checking')))
      }

      const head = h('div', { className: 'dmb-card' },
        h('div', { className: 'dmb-row' },
          h('div', { className: 'dmb-main' },
            h('div', { className: 'dmb-title' }, t('enable')),
            h('p', { className: 'dmb-hint' }, t('enableHint'))),
          h(Toggle, { label: t('enable'), checked: !!state.enabled, disabled: busy, onChange: (on) => run({ action: 'enable', on }) })))

      let body = null
      if (state.enabled) {
        const tun = state.tunnel || {}
        const scanRow = h('div', { className: 'dmb-row' }, h(ScanBlock, { t, state, busy, run }))

        const outsideRow = h('div', { className: 'dmb-row' },
          h('div', { className: 'dmb-main' },
            h('div', { className: 'dmb-title' }, t('outside')),
            h('p', { className: 'dmb-hint' }, t('outsideHint'))),
          h(Toggle, { label: t('outside'), checked: !!tun.on, disabled: busy, onChange: (on) => run({ action: 'tunnel', on }) }))

        body = h('div', { className: 'dmb-card' }, scanRow, outsideRow)
      }

      const devs = state.devices || []
      const devices = h('div', { className: 'dmb-card' },
        h('div', { className: 'dmb-row' },
          h('div', { className: 'dmb-main' }, h('div', { className: 'dmb-title' }, t('devices'))),
          devs.length > 1 ? h(Btn, { disabled: busy, onClick: () => run({ action: 'removeAll' }, t('removed')) }, t('removeAll')) : null),
        devs.length
          ? devs.map((d) => h('div', { key: d.id, className: 'dmb-dev' },
            h('span', { className: 'dmb-dot', 'data-s': d.online ? 'on' : 'off' }),
            h('div', { className: 'dmb-main' },
              h('div', { className: 'dmb-title' }, d.name,
                h('span', { className: 'dmb-tag' }, d.via === 'tunnel' ? t('viaTunnel') : d.via === 'local' ? t('viaLocal') : t('viaLan'))),
              h('div', { className: 'dmb-sub' }, (d.online ? t('online') : ago(t, d.lastSeen)) + (d.lastIp ? ` · ${d.lastIp}` : ''))),
            h(Btn, { disabled: busy, onClick: () => run({ action: 'remove', id: d.id }, t('removed')) }, t('remove'))))
          : h('div', { className: 'dmb-dev' }, h('p', { className: 'dmb-hint' }, t('noDevices'))))

      const notes = [
        { tone: 'warn', text: t('safety') },
        note,
      ].filter(Boolean)

      return h('div', { className: 'dmb' },
        head,
        body,
        devices,
        ...notes.map((n, i) => h('div', { key: `n${i}`, className: 'dmb-note', 'data-tone': n.tone }, n.text)),
        h('div', { className: 'dmb-foot' },
          state.plugin ? h('span', null, fmt(t('plugin'), { v: state.plugin })) : null,
          h('a', { href: REPO, target: '_blank', rel: 'noopener noreferrer' }, t('guide'))))
    }

    // ── 会话顶栏的手机按钮 ─────────────────────────────────────────────────

    function PhoneIcon() {
      return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 6.5, y: 2.75, width: 11, height: 18.5, rx: 2.5 }),
        h('path', { d: 'M10.5 18h3' }))
    }

    function Popover({ t, anchor, state, error, act, onClose }) {
      const ref = useRef(null)
      const [pos, setPos] = useState(null)
      const { busy, note, run } = useRunner(act, t)
      useEffect(() => {
        const place = () => {
          const r = anchor.current && anchor.current.getBoundingClientRect()
          if (!r) return
          const w = Math.min(300, window.innerWidth - 16)
          const top = r.bottom + 6
          setPos({ top, left: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)), maxHeight: window.innerHeight - top - 8 })
        }
        const down = (e) => {
          if (ref.current && ref.current.contains(e.target)) return
          if (anchor.current && anchor.current.contains(e.target)) return
          onClose()
        }
        const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
        place()
        window.addEventListener('resize', place)
        document.addEventListener('pointerdown', down, true)
        document.addEventListener('keydown', key, true)
        return () => {
          window.removeEventListener('resize', place)
          document.removeEventListener('pointerdown', down, true)
          document.removeEventListener('keydown', key, true)
        }
      }, [])
      let body
      if (!state) body = h('div', { className: 'dmb-note', 'data-tone': error ? 'err' : undefined }, error ? t('unreachable') : t('checking'))
      else {
        body = [
          h('div', { key: 'h', className: 'dmb-pophead' },
            h('div', { className: 'dmb-title' }, t('enable')),
            h(Toggle, { label: t('enable'), checked: !!state.enabled, disabled: busy, onChange: (on) => run({ action: 'enable', on }) })),
          state.enabled ? h(ScanBlock, { key: 's', t, state, busy, run, compact: true }) : h('p', { key: 's', className: 'dmb-hint' }, t('enableHint')),
          note ? h('div', { key: 'n', className: 'dmb-note', 'data-tone': note.tone }, note.text) : null,
          h('p', { key: 'm', className: 'dmb-hint' }, t('manage')),
        ]
      }
      const el = h('div', {
        ref,
        className: 'dmb-pop',
        role: 'dialog',
        'aria-label': t('headTip'),
        style: pos || { visibility: 'hidden', top: 0, left: 0 },
      }, body)
      return ReactDOM && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined' ? ReactDOM.createPortal(el, document.body) : el
    }

    function HeaderButton(props) {
      ensureCss()
      const t = props.t
      const [open, setOpen] = useState(false)
      const btn = useRef(null)
      const { state, error, act } = useMobileState(open ? 2500 : 8000)
      const on = onlineOf(state).length > 0
      return h(React.Fragment, null,
        h('button', {
          ref: btn,
          type: 'button',
          className: 'dmb-head',
          'data-s': on ? 'on' : undefined,
          title: on ? fmt(t('phoneOnline'), { s: onlineOf(state).map((d) => d.name).join('、') }) : t('headTip'),
          'aria-label': t('headTip'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          onClick: () => setOpen((v) => !v),
        }, h(PhoneIcon)),
        open ? h(Popover, { t, anchor: btn, state, error, act, onClose: () => setOpen(false) }) : null)
    }

    function makeCard(boundT) {
      return function MobileCard(props) {
        ensureCss()
        const t = typeof props.t === 'function' ? props.t : boundT
        if (onPhone()) return props.view === 'summary' ? t('desktopOnly') : h('div', { className: 'dmb' }, h('div', { className: 'dmb-note' }, t('desktopOnly')))
        return props.view === 'summary' ? h(Summary, { t }) : h(Page, { t })
      }
    }

    function apply(ctx) {
      const t = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (k) => zh[k] || k
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mobile: dictionaries')
      }
      const Card = makeCard(t)
      const mount = (name, key) => {
        const reg = () => ctx.slots.register({ name, key, locale: NS }, Card)
        ctx.effect(() => (typeof ctx.slots.inject === 'function' ? ctx.slots.inject(name, reg) : reg()), `dsh-mobile: ${name}`)
      }
      mount('plugins.bundle.config', PKG)
      mount('plugins.row.config', `${PKG}#${ROW}`)

      const HEAD = 'conversation.session.header.utilities'
      if (onPhone()) return // 手机上不放顶栏按钮
      const regHead = () => ctx.slots.register({ name: HEAD, id: PKG, order: -9, locale: NS, inject: (sessionId) => ({ sid: sessionId, t }) }, HeaderButton)
      ctx.effect(() => (typeof ctx.slots.inject === 'function' ? ctx.slots.inject(HEAD, regHead) : regHead()), 'dsh-mobile: header button')
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
