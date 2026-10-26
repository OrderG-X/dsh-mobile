/**
 * 推送到手机：任务跑完、等你批准 / 回答时，电脑往用户自己的推送服务发一条通知（手机不用开着网页）。
 *
 * 用户只填一个「推送地址」，按样子认是哪家：
 *   Bark          https://api.day.app/<key>（iPhone）
 *   Server酱       SCT… / sctp… 开头的 SendKey，或 sctapi.ftqq.com 的网址（推到微信）
 *   ntfy          https://ntfy.sh/<主题>（安卓、iPhone；自建的网址里带 ntfy 也认）
 *   飞书 / 企业微信 / 钉钉群机器人的 Webhook 网址（钉钉要把关键词设成 DSH）
 *   Telegram      https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>
 *   其他网址        POST JSON { title, body, url, group }（自建的 Bark 就认这个）
 *
 * 通知里只有会话标题、状态和手机端地址，不带对话内容。
 * 事件：agent/status（running → idle 算跑完）、agent/error、approval/request、user-questions/request。
 * 后两个是「谁来回答」的接力：插在最前面，发完通知马上交给下一位（DSH 自己的批准卡片），不替用户做决定。
 */

export const KINDS = ['bark', 'serverchan', 'ntfy', 'feishu', 'wecom', 'dingtalk', 'telegram', 'webhook']

/** 跑完多久以上才推（来回几句的短对话不打扰） */
export const DONE_MIN_MS = 30 * 1000
/** 同一个会话同一类通知，至少隔这么久 */
const SAME_GAP_MS = 20 * 1000
/** 一小时最多推这么多条，防止出了岔子刷屏 */
const HOURLY_CAP = 40
const TIMEOUT_MS = 10 * 1000

/** 推送地址 → 哪家服务。空串给 null；认不出的网址按通用 Webhook；不是网址也不是 SendKey 给 invalid */
export function detectService(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  if (/^(SCT\w{6,}|sctp\d+t\w{6,})$/i.test(s)) return { kind: 'serverchan', key: s }
  let u
  try { u = new URL(s) } catch { return { kind: 'invalid' } }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { kind: 'invalid' }
  const host = u.hostname.toLowerCase()
  const path = u.pathname
  if (host === 'api.day.app') return path.length > 1 ? { kind: 'bark', url: u } : { kind: 'invalid' }
  if (host === 'sctapi.ftqq.com' || host.endsWith('.push.ft07.com')) {
    const m = /([A-Za-z0-9]+)\.send$/.exec(path)
    return m ? { kind: 'serverchan', key: m[1] } : { kind: 'invalid' }
  }
  if (host === 'ntfy.sh' || /(^|\.)ntfy\./.test(host)) {
    const topic = path.replace(/^\/+|\/+$/g, '')
    return topic && !topic.includes('/') ? { kind: 'ntfy', url: u, topic } : { kind: 'invalid' }
  }
  if ((host.endsWith('feishu.cn') || host.endsWith('larksuite.com')) && path.includes('/bot/v2/hook/')) return { kind: 'feishu', url: u }
  if (host === 'qyapi.weixin.qq.com' && path.includes('/webhook/send')) return { kind: 'wecom', url: u }
  if (host === 'oapi.dingtalk.com' && path.includes('/robot/send')) return { kind: 'dingtalk', url: u }
  if (host === 'api.telegram.org') {
    const chat = u.searchParams.get('chat_id')
    return /^\/bot[^/]+\/sendMessage$/.test(path) && chat ? { kind: 'telegram', url: u, chat } : { kind: 'invalid' }
  }
  return { kind: 'webhook', url: u }
}

const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) })
const plain = ({ title, body, url }) => [title, body, url].filter(Boolean).join('\n')

/** 一条通知 → 发给那家服务的请求 { url, init }（纯函数，测试直接看它） */
export function buildRequest(service, msg) {
  const { title, body, url } = msg
  switch (service.kind) {
    case 'bark': {
      const u = service.url
      return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, init: json({ title, body, group: 'DSH', ...(url ? { url } : {}) }) }
    }
    case 'serverchan': {
      const m = /^sctp(\d+)t/i.exec(service.key)
      const endpoint = m ? `https://${m[1]}.push.ft07.com/send/${service.key}.send` : `https://sctapi.ftqq.com/${service.key}.send`
      const desp = url ? `${body}\n\n[打开 DSH](${url})` : body
      return { url: endpoint, init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ title, desp }).toString() } }
    }
    case 'ntfy':
      return { url: `${service.url.origin}/`, init: json({ topic: service.topic, title, message: body, tags: ['computer'], ...(url ? { click: url } : {}) }) }
    case 'feishu':
      return { url: service.url.href, init: json({ msg_type: 'text', content: { text: plain(msg) } }) }
    case 'wecom':
    case 'dingtalk':
      return { url: service.url.href, init: json({ msgtype: 'text', text: { content: plain(msg) } }) }
    case 'telegram':
      return { url: `${service.url.origin}${service.url.pathname}`, init: json({ chat_id: service.chat, text: plain(msg), disable_web_page_preview: true }) }
    case 'webhook':
      return { url: service.url.href, init: json({ title, body, group: 'DSH', ...(url ? { url } : {}) }) }
    default:
      throw new Error('推送地址不对')
  }
}

/** 各家「HTTP 200 但其实没发出去」的写法：errcode / code / ok:false */
function failureOf(j) {
  if (!j || typeof j !== 'object') return ''
  if (j.ok === false) return j.description || 'ok=false'
  if (typeof j.errcode === 'number' && j.errcode !== 0) return j.errmsg || `errcode ${j.errcode}`
  if (typeof j.code === 'number' && j.code !== 0 && j.code !== 200) return j.message || j.msg || `code ${j.code}`
  if (typeof j.StatusCode === 'number' && j.StatusCode !== 0) return j.StatusMessage || `StatusCode ${j.StatusCode}`
  return ''
}

export async function send(service, msg, fetchImpl = globalThis.fetch) {
  const { url, init } = buildRequest(service, msg)
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await res.text().catch(() => '')
  let j = null
  try { j = JSON.parse(text) } catch {}
  const why = failureOf(j)
  if (!res.ok || why) throw new Error(why || `HTTP ${res.status}${text ? `：${text.slice(0, 120)}` : ''}`)
}

const zhLocale = () => {
  try { return /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale) } catch { return true }
}

function duration(ms, zh) {
  const s = Math.round(ms / 1000)
  if (s < 60) return zh ? `${s} 秒` : `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return zh ? `${m} 分 ${s % 60} 秒` : `${m}m ${s % 60}s`
  return zh ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** 通知的文字（标题都以 DSH 开头：钉钉机器人的关键词就设 DSH） */
export function message(kind, info = {}, zh = zhLocale()) {
  const name = info.title ? (zh ? `「${info.title}」` : `"${info.title}"`) : (zh ? '一个任务' : 'A task')
  switch (kind) {
    case 'done': return { title: zh ? 'DSH：任务完成' : 'DSH: task done', body: zh ? `${name}跑完了，用时 ${duration(info.ms || 0, zh)}` : `${name} finished in ${duration(info.ms || 0, zh)}` }
    case 'error': return { title: zh ? 'DSH：任务出错停下了' : 'DSH: task stopped with an error', body: zh ? `${name}出错停下了` : `${name} stopped with an error` }
    case 'approval': return { title: zh ? 'DSH：等你批准' : 'DSH: approval needed', body: zh ? `${name}要用 ${info.tool || '一个工具'}，等你点批准` : `${name} wants to use ${info.tool || 'a tool'}` }
    case 'question': return { title: zh ? 'DSH：等你回答' : 'DSH: question for you', body: zh ? `${name}有问题等你回答` : `${name} is waiting for your answer` }
    default: return { title: 'DSH', body: zh ? '推送设置好了：任务跑完、等你批准时会发到这里' : 'Push is set up: you will get a message here when a task finishes or needs approval' }
  }
}

/**
 * @param opts.config  () => { url, done, approval, lang }（存在 state.json 的 push 里；lang 是设置页的界面语言）
 * @param opts.link    () => 手机端地址（点通知打开）；没开手机访问是空串
 */
export function createPusher({ config, link = () => '', log = () => {}, fetchImpl, now = Date.now, zh } = {}) {
  const lastSent = new Map() // `${kind}:${session}` → 时间
  let hour = { start: 0, n: 0 }
  let last = null // { at, kind, ok, error }

  async function deliver(kind, info, { force = false } = {}) {
    const c = config() || {}
    const service = detectService(c.url)
    if (!service || service.kind === 'invalid') {
      if (force) throw new Error(service ? '推送地址认不出来' : '还没填推送地址')
      return false
    }
    if (!force) {
      const key = `${kind}:${info.session || ''}`
      const t = now()
      if (t - (lastSent.get(key) || 0) < SAME_GAP_MS) return false
      if (t - hour.start > 3600 * 1000) hour = { start: t, n: 0 }
      if (hour.n >= HOURLY_CAP) return false
      lastSent.set(key, t)
      hour.n++
    }
    const msg = { ...message(kind, info, zh ?? (c.lang ? c.lang === 'zh' : zhLocale())), url: link() || '' }
    try {
      await send(service, msg, fetchImpl)
      last = { at: now(), kind, ok: true }
      return true
    } catch (e) {
      const error = String((e && e.message) || e)
      last = { at: now(), kind, ok: false, error }
      log(`推送没发出去（${service.kind}）：${error}`)
      if (force) throw new Error(error)
      return false
    }
  }

  return {
    /** 事件来了：按开关决定发不发（不等结果、不抛错） */
    event(kind, info) {
      const c = config() || {}
      const on = kind === 'done' || kind === 'error' ? c.done !== false : c.approval !== false
      if (!on) return
      deliver(kind, info).catch(() => {})
    },
    /** 「发一条试试」：失败抛错，设置页把原因给用户看 */
    test: () => deliver('test', {}, { force: true }),
    get last() { return last },
  }
}

const isSubagent = (agent) => {
  const h = agent && agent.session && agent.session.header
  return !!(h && (h.origin === 'subagent' || h.delegationDepth > 0))
}
const isCancel = (e) => !!e && (e.name === 'AbortError' || /abort|cancel/i.test(String(e.name || '')))

/**
 * 接上 DSH 的事件。subagent（子任务）跑完不推，只推用户开的会话。
 * @param opts.info  agent → { session, title }
 */
export function watchAgents(ctx, pusher, { info, minMs = DONE_MIN_MS, now = Date.now }) {
  const runs = new WeakMap() // agent → { at, error }
  const about = (agent) => { try { return info(agent) || {} } catch { return {} } }
  ctx.on('agent/status', ({ agent, status }) => {
    if (!agent || isSubagent(agent)) return
    if (status === 'running') {
      if (!runs.has(agent)) runs.set(agent, { at: now(), error: false })
      return
    }
    const run = runs.get(agent)
    runs.delete(agent)
    if (!run) return
    const ms = now() - run.at
    if (run.error) pusher.event('error', { ...about(agent), ms })
    else if (ms >= minMs) pusher.event('done', { ...about(agent), ms })
  })
  ctx.on('agent/error', ({ agent, error }) => {
    const run = agent && runs.get(agent)
    if (run && !isCancel(error)) run.error = true
  })
  ctx.on('agent/disposed', ({ agent }) => { if (agent) runs.delete(agent) })
  // 接力的最前面：发个通知，马上交给下一位
  ctx.on('approval/request', (req, next) => {
    try { pusher.event('approval', { ...about(req && req.agent), tool: req && req.toolName }) } catch {}
    return next()
  }, true)
  ctx.on('user-questions/request', (req, next) => {
    try { pusher.event('question', about(req && req.agent)) } catch {}
    return next()
  }, true)
}
