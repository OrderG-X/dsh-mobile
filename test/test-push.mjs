// 推送到手机：认推送地址、各家的请求格式、开关和防刷屏、接 DSH 的事件（批准接力不吞掉）、设置页操作
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { detectService, buildRequest, send, message, createPusher, watchAgents, DONE_MIN_MS } from '../lib/push.js'
import { createStore } from '../lib/store.js'
import { createMobile } from '../lib/index.js'

const msg = { title: 'DSH：任务完成', body: '「修 bug」跑完了', url: 'https://a-b.trycloudflare.com' }
const bodyOf = (req) => JSON.parse(req.init.body)

test('认推送地址', () => {
  assert.equal(detectService(''), null)
  assert.equal(detectService('  '), null)
  assert.equal(detectService('https://api.day.app/abcDEF123').kind, 'bark')
  assert.equal(detectService('https://api.day.app/').kind, 'invalid')
  assert.deepEqual(detectService('SCT123456TAbcdefg'), { kind: 'serverchan', key: 'SCT123456TAbcdefg' })
  assert.equal(detectService('sctp1234tABCDEFGH').kind, 'serverchan')
  assert.equal(detectService('https://sctapi.ftqq.com/SCT99999Txyz123.send').key, 'SCT99999Txyz123')
  assert.equal(detectService('https://ntfy.sh/my-dsh-topic').topic, 'my-dsh-topic')
  assert.equal(detectService('https://ntfy.sh/').kind, 'invalid')
  assert.equal(detectService('https://ntfy.example.com/t1').kind, 'ntfy')
  assert.equal(detectService('https://open.feishu.cn/open-apis/bot/v2/hook/xxx').kind, 'feishu')
  assert.equal(detectService('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k').kind, 'wecom')
  assert.equal(detectService('https://oapi.dingtalk.com/robot/send?access_token=t').kind, 'dingtalk')
  assert.equal(detectService('https://api.telegram.org/bot123:ABC/sendMessage?chat_id=42').chat, '42')
  assert.equal(detectService('https://api.telegram.org/bot123:ABC/sendMessage').kind, 'invalid')
  assert.equal(detectService('https://bark.my-home.net/KEY').kind, 'webhook')
  assert.equal(detectService('不是网址').kind, 'invalid')
  assert.equal(detectService('ftp://x.com/a').kind, 'invalid')
  assert.equal(detectService('javascript:alert(1)').kind, 'invalid')
})

test('各家的请求格式', () => {
  let r = buildRequest(detectService('https://api.day.app/KEY/'), msg)
  assert.equal(r.url, 'https://api.day.app/KEY')
  assert.deepEqual(bodyOf(r), { title: msg.title, body: msg.body, group: 'DSH', url: msg.url })

  r = buildRequest(detectService('SCT123456TAbcdefg'), msg)
  assert.equal(r.url, 'https://sctapi.ftqq.com/SCT123456TAbcdefg.send')
  const form = new URLSearchParams(r.init.body)
  assert.equal(form.get('title'), msg.title)
  assert.ok(form.get('desp').includes(msg.url))
  assert.equal(buildRequest(detectService('sctp1234tABCDEFGH'), msg).url, 'https://1234.push.ft07.com/send/sctp1234tABCDEFGH.send')

  r = buildRequest(detectService('https://ntfy.sh/my-topic'), msg)
  assert.equal(r.url, 'https://ntfy.sh/')
  assert.deepEqual(bodyOf(r), { topic: 'my-topic', title: msg.title, message: msg.body, tags: ['computer'], click: msg.url })

  r = buildRequest(detectService('https://open.feishu.cn/open-apis/bot/v2/hook/xxx'), msg)
  assert.equal(bodyOf(r).msg_type, 'text')
  assert.ok(bodyOf(r).content.text.startsWith('DSH'))
  r = buildRequest(detectService('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k'), msg)
  assert.equal(r.url, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k')
  assert.ok(bodyOf(r).text.content.includes(msg.body))
  r = buildRequest(detectService('https://oapi.dingtalk.com/robot/send?access_token=t'), msg)
  assert.equal(bodyOf(r).msgtype, 'text')

  r = buildRequest(detectService('https://api.telegram.org/bot123:ABC/sendMessage?chat_id=42'), msg)
  assert.equal(r.url, 'https://api.telegram.org/bot123:ABC/sendMessage')
  assert.equal(bodyOf(r).chat_id, '42')

  r = buildRequest(detectService('https://hook.example.com/x?y=1'), { ...msg, url: '' })
  assert.deepEqual(bodyOf(r), { title: msg.title, body: msg.body, group: 'DSH' })
})

test('HTTP 200 但服务说没发出去：当失败', async () => {
  const fake = (j, status = 200) => async () => new Response(JSON.stringify(j), { status })
  const s = detectService('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k')
  await assert.rejects(send(s, msg, fake({ errcode: 93000, errmsg: 'invalid webhook url' })), /invalid webhook url/)
  await assert.rejects(send(s, msg, fake({ ok: false, description: 'chat not found' })), /chat not found/)
  await assert.rejects(send(s, msg, fake({ code: 40001, message: 'bad key' })), /bad key/)
  await assert.rejects(send(s, msg, fake({}, 500)), /HTTP 500/)
  await send(s, msg, fake({ errcode: 0, errmsg: 'ok' }))
  await send(s, msg, fake({ code: 200, message: 'success' }))
})

test('真发一条到本地 Webhook', async () => {
  const got = []
  const srv = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => { got.push({ method: req.method, type: req.headers['content-type'], body: JSON.parse(b) }); res.end('{"ok":true}') })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    await send(detectService(`http://127.0.0.1:${srv.address().port}/hook`), msg)
    assert.equal(got.length, 1)
    assert.equal(got[0].method, 'POST')
    assert.match(got[0].type, /application\/json/)
    assert.equal(got[0].body.body, msg.body)
  } finally {
    srv.close()
  }
})

test('文字：中英文，带会话标题和用时', () => {
  assert.equal(message('done', { title: '修 bug', ms: 125000 }, true).body, '「修 bug」跑完了，用时 2 分 5 秒')
  assert.equal(message('approval', { title: 'x', tool: 'bash' }, true).body, '「x」要用 bash，等你点批准')
  assert.equal(message('done', { ms: 5000 }, false).body, 'A task finished in 5s')
  for (const k of ['done', 'error', 'approval', 'question', 'test']) assert.ok(message(k, {}, true).title.startsWith('DSH'))
})

function harness(config, opts = {}) {
  const sent = []
  let t = 1_000_000
  const pusher = createPusher({
    config: () => config,
    link: () => 'https://p.trycloudflare.com',
    zh: true,
    now: () => t,
    fetchImpl: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response('{}') },
    ...opts,
  })
  const flush = () => new Promise((r) => setTimeout(r, 5))
  return { pusher, sent, flush, advance: (ms) => { t += ms } }
}

test('开关、防刷屏、发一条试试', async () => {
  const cfg = { url: 'https://ntfy.sh/t', done: true, approval: false }
  const { pusher, sent, flush, advance } = harness(cfg)
  pusher.event('done', { session: 's1', title: 'A', ms: 40000 })
  await flush()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].body.click, 'https://p.trycloudflare.com')
  pusher.event('done', { session: 's1', title: 'A', ms: 40000 }) // 20 秒内同一个会话：不发
  pusher.event('approval', { session: 's1', title: 'A' }) // 批准开关关着：不发
  await flush()
  assert.equal(sent.length, 1)
  pusher.event('done', { session: 's2', title: 'B', ms: 40000 }) // 别的会话照发
  advance(21000)
  pusher.event('done', { session: 's1', title: 'A', ms: 40000 })
  await flush()
  assert.equal(sent.length, 3)
  await pusher.test()
  assert.equal(sent.length, 4)
  assert.equal(pusher.last.ok, true)

  const none = harness({ url: '' })
  await assert.rejects(none.pusher.test(), /还没填推送地址/)
  none.pusher.event('done', { session: 's', ms: 99999 })
  await none.flush()
  assert.equal(none.sent.length, 0)

  const bad = harness({ url: 'https://ntfy.sh/t' }, { fetchImpl: async () => new Response('nope', { status: 403 }) })
  await assert.rejects(bad.pusher.test(), /HTTP 403/)
  assert.equal(bad.pusher.last.ok, false)
})

function fakeCtx() {
  const on = {}
  return {
    on(name, fn, prepend) { (on[name] ||= []).push({ fn, prepend }); return () => {} },
    emit(name, payload) { for (const l of on[name] || []) l.fn(payload) },
    waterfall(name, payload, fallback) { return on[name][0].fn(payload, fallback) },
    listeners: on,
  }
}

test('接 DSH 的事件：跑完、出错、子任务不推、批准接力照常往下传', async () => {
  const ctx = fakeCtx()
  const events = []
  let t = 0
  watchAgents(ctx, { event: (kind, info) => events.push({ kind, ...info }) }, {
    info: (agent) => ({ session: agent.id, title: `会话${agent.id}` }),
    now: () => t,
  })
  const top = { id: 'a', session: { header: {} } }
  const sub = { id: 'b', session: { header: { origin: 'subagent', delegationDepth: 1 } } }

  ctx.emit('agent/status', { agent: top, status: 'running' })
  t += 5000
  ctx.emit('agent/status', { agent: top, status: 'idle' }) // 太短：不推
  assert.equal(events.length, 0)

  ctx.emit('agent/status', { agent: top, status: 'running' })
  ctx.emit('agent/status', { agent: sub, status: 'running' })
  t += DONE_MIN_MS + 1000
  ctx.emit('agent/status', { agent: sub, status: 'idle' }) // 子任务：不推
  ctx.emit('agent/status', { agent: top, status: 'idle' })
  assert.deepEqual(events, [{ kind: 'done', session: 'a', title: '会话a', ms: DONE_MIN_MS + 1000 }])

  ctx.emit('agent/status', { agent: top, status: 'running' })
  ctx.emit('agent/error', { agent: top, error: new Error('boom') })
  t += 1000
  ctx.emit('agent/status', { agent: top, status: 'idle' }) // 出错：再短也推
  assert.equal(events.at(-1).kind, 'error')

  ctx.emit('agent/status', { agent: top, status: 'running' })
  const abort = new Error('stopped'); abort.name = 'AbortError'
  ctx.emit('agent/error', { agent: top, error: abort }) // 用户自己按停：不算出错
  t += 1000
  ctx.emit('agent/status', { agent: top, status: 'idle' })
  assert.equal(events.length, 2)

  // 批准 / 提问：插在最前面，推完交给下一位，结果原样返回
  assert.equal(ctx.listeners['approval/request'][0].prepend, true)
  assert.equal(ctx.listeners['user-questions/request'][0].prepend, true)
  const outcome = await ctx.waterfall('approval/request', { agent: top, toolName: 'bash' }, async () => 'allowed-once')
  assert.equal(outcome, 'allowed-once')
  assert.deepEqual(events.at(-1), { kind: 'approval', session: 'a', title: '会话a', tool: 'bash' })
  const answer = await ctx.waterfall('user-questions/request', { agent: top, questions: [] }, async () => ({ answers: ['x'] }))
  assert.deepEqual(answer, { answers: ['x'] })
  assert.equal(events.at(-1).kind, 'question')

  // 推送那边出岔子也不能卡住批准
  const ctx2 = fakeCtx()
  watchAgents(ctx2, { event: () => { throw new Error('x') } }, { info: () => ({}) })
  assert.equal(await ctx2.waterfall('approval/request', { agent: top, toolName: 'bash' }, async () => 'rejected'), 'rejected')
})

test('设置页：存推送地址、认不出来报错、发一条试试', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-push-'))
  const sent = []
  const store = createStore({ dir })
  const mobile = createMobile({
    store,
    binDir: path.join(dir, 'bin'),
    address: () => '192.168.1.5',
    upstream: { port: () => 1, authUrl: () => undefined },
    deps: {
      createTunnel: () => ({ start() {}, stop() {}, detach() {}, get status() { return { state: 'off', url: '', error: '' } } }),
      findCloudflared: () => null,
      assetFor: () => null,
      fetch: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response('{}') },
    },
  })
  try {
    assert.deepEqual(mobile.state().push, { url: '', kind: '', done: true, approval: true, last: null })
    let s = await mobile.act({ action: 'push', url: ' https://ntfy.sh/dsh-test ' })
    assert.equal(s.push.url, 'https://ntfy.sh/dsh-test')
    assert.equal(s.push.kind, 'ntfy')
    await assert.rejects(mobile.act({ action: 'push', url: 'ftp://nope' }), /认不出来/)
    s = await mobile.act({ action: 'push', done: false })
    assert.equal(s.push.done, false)
    assert.equal(s.push.url, 'https://ntfy.sh/dsh-test')
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).push.done, false)
    s = await mobile.act({ action: 'pushTest' })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].body.topic, 'dsh-test')
    assert.equal(sent[0].body.click, undefined) // 没开手机访问：没有地址可点
    assert.equal(s.push.last.ok, true)
    // 推送的话跟设置页的界面语言走（DSH 后台进程的系统语言可能是英文）
    await mobile.act({ action: 'pushTest', lang: 'zh' })
    assert.match(sent[1].body.message, /推送设置好了/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).push.lang, 'zh')
    await mobile.act({ action: 'push', approval: false, lang: 'en' })
    await mobile.act({ action: 'pushTest' })
    assert.match(sent[2].body.message, /^Push is set up/)
    await mobile.act({ action: 'push', done: true, lang: 'nope' }) // 不认识的语言：不动
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).push.lang, 'en')
  } finally {
    await mobile.stopAll()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
