/**
 * dsh-mobile 的网页端：DSH「插件」页里「手机端」这张卡的设置页。
 *
 *   开关：允许手机访问
 *   二维码：同一 Wi-Fi / 外网（Cloudflare 隧道）两种，扫一次就作废，10 分钟过期
 *   已配对的手机：名字、怎么连的、最近一次出现，随时移除
 *
 * 数据走插件挂在 DSH webServer 上的路由（lib/index.js 的 panelHandler），每 2.5 秒刷一次。
 * 跟 dsh-chrome-bridge 一样走官方客户端插件机制：注册到 plugins.bundle.config / plugins.row.config。
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

    const PKG = 'dsh-mobile'
    const ROW = 'mobile'
    const NS = 'dsh-mobile'
    const ROUTE = '/dsh-mobile/panel'
    const REPO = 'https://github.com/OrderG-X/dsh-mobile'

    const zh = {
      checking: '正在检查…',
      enable: '允许手机访问',
      enableHint: '打开后，用手机扫下面的二维码，就能在手机浏览器里看这台电脑上的任务、接着发消息、批准操作。',
      summaryOff: '未开启：打开后手机扫码就能用',
      summaryOn: '已开启 · %n 台手机',
      summaryOnNone: '已开启，还没有手机配对',
      lan: '同一 Wi-Fi',
      tunnel: '外网',
      scan: '用手机相机扫码',
      scanHint: '二维码只能用一次，10 分钟内有效（还剩 %m 分钟）。',
      lanHint: '手机要和这台电脑连同一个 Wi-Fi。',
      noLan: '没检测到局域网。连上 Wi-Fi 后再看；或者用「外网」。',
      starting: '正在打开…',
      newCode: '换一个',
      tunnelNeed: '外网要用 Cloudflare 的免费隧道（不用注册账号）。先下载它的官方程序 cloudflared，约 20 MB，来自 Cloudflare 的 GitHub。',
      download: '下载 cloudflared',
      downloading: '正在下载 %p',
      downloadFailed: '下载失败：%e',
      unsupported: '这台电脑的系统没有现成的 cloudflared。',
      tunnelOn: '开启外网访问',
      tunnelHint: '在外面用流量也能连。地址每次重启 DSH 都会变，变了要重新扫码。',
      tunnelStarting: '正在连接 Cloudflare…',
      tunnelError: '外网没连上：%e。会自动重试。',
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
    }
    const en = {
      checking: 'Checking…',
      enable: 'Allow phone access',
      enableHint: 'Turn it on, scan the code below with your phone, and use this computer\'s DSH from the phone browser: watch tasks, reply, approve.',
      summaryOff: 'Off: turn it on and scan with your phone',
      summaryOn: 'On · %n phone(s)',
      summaryOnNone: 'On, no phone paired yet',
      lan: 'Same Wi-Fi',
      tunnel: 'Anywhere',
      scan: 'Scan with your phone camera',
      scanHint: 'Each code works once, within 10 minutes (%m min left).',
      lanHint: 'The phone must be on the same Wi-Fi as this computer.',
      noLan: 'No local network found. Connect to Wi-Fi, or use Anywhere.',
      starting: 'Starting…',
      newCode: 'New code',
      tunnelNeed: 'Anywhere access uses a free Cloudflare tunnel (no account needed). Download Cloudflare\'s official cloudflared first, about 20 MB, from Cloudflare\'s GitHub.',
      download: 'Download cloudflared',
      downloading: 'Downloading %p',
      downloadFailed: 'Download failed: %e',
      unsupported: 'There is no cloudflared build for this system.',
      tunnelOn: 'Allow access from anywhere',
      tunnelHint: 'Works over mobile data. The address changes every time DSH restarts; scan again when it does.',
      tunnelStarting: 'Connecting to Cloudflare…',
      tunnelError: 'Tunnel not connected: %e. Retrying automatically.',
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
    }

    const fmt = (s, vars) => String(s).replace(/%([a-z])/g, (m, k) => (vars && k in vars ? String(vars[k]) : m))

    const CSS = `
.dmb{display:grid;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dmb-card{border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l));background:var(--dsw-alias-settings-card-fill,transparent);border-radius:12px;overflow:hidden}
.dmb-row{display:flex;align-items:flex-start;gap:12px;padding:12px 14px}
.dmb-row+.dmb-row{border-top:1px solid var(--dsw-alias-border-l)}
.dmb-main{flex:1;min-width:0;display:grid;gap:2px}
.dmb-title{font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dmb-sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.dmb-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}
.dmb-tabs{display:inline-flex;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover);width:max-content}
.dmb-tab{font:inherit;font-size:12px;padding:3px 12px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dmb-tab[aria-selected=true]{background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-primary,#fff));color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.12)}
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
.dmb-dot[data-s=on]{background:var(--dsw-alias-state-success-primary,#34c759)}`
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

    function Summary({ t }) {
      const { state } = useMobileState(10000)
      if (!state) return t('checking')
      if (!state.enabled) return t('summaryOff')
      const n = state.devices ? state.devices.length : 0
      return n ? fmt(t('summaryOn'), { n }) : t('summaryOnNone')
    }

    function Page({ t }) {
      const { state, error, act } = useMobileState()
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)
      const [tab, setTab] = useState('lan')

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

      if (!state) {
        return h('div', { className: 'dmb' }, h('div', { className: 'dmb-note', 'data-tone': error ? 'err' : undefined }, error ? t('unreachable') : t('checking')))
      }

      const left = Math.max(1, Math.ceil(((state.codeExpires || 0) - Date.now()) / 60000))
      const head = h('div', { className: 'dmb-card' },
        h('div', { className: 'dmb-row' },
          h('div', { className: 'dmb-main' },
            h('div', { className: 'dmb-title' }, t('enable')),
            h('p', { className: 'dmb-hint' }, t('enableHint'))),
          h(Toggle, { label: t('enable'), checked: !!state.enabled, disabled: busy, onChange: (on) => run({ action: 'enable', on }) })))

      let body = null
      if (state.enabled) {
        const tun = state.tunnel || {}
        const qrBlock = (qr, base, extra) => h('div', { className: 'dmb-qrwrap' },
          h(Qr, { qr, label: t('scan') }),
          h('div', { className: 'dmb-qrside' },
            h('div', { className: 'dmb-title' }, t('scan')),
            h('p', { className: 'dmb-hint' }, fmt(t('scanHint'), { m: left })),
            extra ? h('p', { className: 'dmb-hint' }, extra) : null,
            h('div', { className: 'dmb-url' }, base),
            h('div', null, h(Btn, { disabled: busy, onClick: () => run({ action: 'newCode' }) }, t('newCode')))))

        let content
        if (tab === 'lan') {
          content = !state.running ? h('p', { className: 'dmb-hint' }, t('starting'))
            : state.lan && state.lan.qr ? qrBlock(state.lan.qr, state.lan.base, t('lanHint'))
              : h('p', { className: 'dmb-hint' }, t('noLan'))
        } else if (!tun.installed) {
          const d = tun.download
          content = h('div', { className: 'dmb-main' },
            h('p', { className: 'dmb-hint' }, tun.supported ? t('tunnelNeed') : t('unsupported')),
            d && d.error ? h('p', { className: 'dmb-hint' }, fmt(t('downloadFailed'), { e: d.error })) : null,
            tun.supported ? h('div', null, h(Btn, { primary: true, disabled: busy || (d && !d.error), onClick: () => run({ action: 'download' }) },
              d && !d.error ? fmt(t('downloading'), { p: d.total ? `${Math.round((d.got / d.total) * 100)}%` : `${(d.got / 1048576).toFixed(1)} MB` }) : t('download'))) : null)
        } else {
          content = h('div', { className: 'dmb-main', style: { gap: '10px' } },
            h('div', { className: 'dmb-row', style: { padding: 0 } },
              h('div', { className: 'dmb-main' },
                h('div', { className: 'dmb-title' }, t('tunnelOn')),
                h('p', { className: 'dmb-hint' }, t('tunnelHint'))),
              h(Toggle, { label: t('tunnelOn'), checked: !!tun.on, disabled: busy, onChange: (on) => run({ action: 'tunnel', on }) })),
            tun.on && tun.state === 'on' && tun.qr ? qrBlock(tun.qr, tun.base)
              : tun.on && tun.state === 'error' ? h('p', { className: 'dmb-hint' }, fmt(t('tunnelError'), { e: tun.error || '?' }))
                : tun.on ? h('p', { className: 'dmb-hint' }, t('tunnelStarting')) : null)
        }

        body = h('div', { className: 'dmb-card' },
          h('div', { className: 'dmb-row', style: { display: 'grid', gap: '12px' } },
            h('div', { className: 'dmb-tabs', role: 'tablist' },
              ['lan', 'tunnel'].map((k) => h('button', { key: k, type: 'button', role: 'tab', className: 'dmb-tab', 'aria-selected': tab === k, onClick: () => setTab(k) }, t(k)))),
            content))
      }

      const devs = state.devices || []
      const devices = h('div', { className: 'dmb-card' },
        h('div', { className: 'dmb-row' },
          h('div', { className: 'dmb-main' }, h('div', { className: 'dmb-title' }, t('devices'))),
          devs.length > 1 ? h(Btn, { disabled: busy, onClick: () => run({ action: 'removeAll' }, t('removed')) }, t('removeAll')) : null),
        devs.length
          ? devs.map((d) => h('div', { key: d.id, className: 'dmb-dev' },
            h('span', { className: 'dmb-dot', 'data-s': Date.now() - d.lastSeen < 120000 ? 'on' : 'off' }),
            h('div', { className: 'dmb-main' },
              h('div', { className: 'dmb-title' }, d.name,
                h('span', { className: 'dmb-tag' }, d.via === 'tunnel' ? t('viaTunnel') : d.via === 'local' ? t('viaLocal') : t('viaLan'))),
              h('div', { className: 'dmb-sub' }, ago(t, d.lastSeen) + (d.lastIp ? ` · ${d.lastIp}` : ''))),
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

    function makeCard(boundT) {
      return function MobileCard(props) {
        ensureCss()
        const t = typeof props.t === 'function' ? props.t : boundT
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
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
