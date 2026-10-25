/**
 * 推送真机测试：全新的 DSH 网页版 + 一个本地「假模型」+ 无头 Chrome 在官方界面里真发任务，看推送有没有发出来
 *   ① 打包、装进全新的 DSH，推送地址设成本地的一个 Webhook
 *   ② 设置页「发一条试试」→ Webhook 收到
 *   ③ 在界面里发一个要跑 30 秒以上的任务（假模型故意慢慢回）→ 收到「任务完成」，带会话标题
 *   ④ 再发一个让模型用 bash 的任务 → 要批准时收到「等你批准」；批准卡片照常出现（推送不替用户做决定）
 *
 *   node e2e/e2e-push.mjs [--dsh latest|next|<版本>]
 * 假模型说 Anthropic Messages 协议（DSH 的 DeepSeek 接口就是这个），通过 DEEPSEEK_BASE_URL 指过去。
 * HOME、DSH_HOME 都是临时的。要本机装着 Chrome（CHROME_BIN 可指定）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, spawnSync, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const DSH_SPEC = argv.includes('--dsh') ? argv[argv.indexOf('--dsh') + 1] : 'latest'
const REGISTRY = 'https://registry.npmjs.org/'
const WIN = process.platform === 'win32'
const OS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] || process.platform
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DONE_WAIT_MS = 33_000

const results = []
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond, extra: cond ? '' : String(extra) })
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${extra}`}`)
  return !!cond
}
const failed = () => results.filter((r) => !r.ok)

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-push-')))
const HOME = path.join(tmp, 'home')
fs.mkdirSync(HOME, { recursive: true })
const env = { ...process.env, HOME, USERPROFILE: HOME, DSH_HOME: path.join(tmp, 'dsh-home'), npm_config_registry: REGISTRY, DEEPSEEK_API_KEY: 'sk-e2e-fake' }
env.PATH = `${path.join(tmp, 'cli', 'node_modules', '.bin')}${path.delimiter}${env.PATH}`
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { env, encoding: 'utf8', maxBuffer: 64 << 20, shell: WIN && cmd === 'npm', ...opts })
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() }
}

// ── 假模型：Anthropic Messages，SSE ──
const llmLog = []
function sse(res, blocks, stop) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  ev('message_start', { message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })
  blocks.forEach((b, i) => {
    if (b.type === 'text') {
      ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } })
      ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: b.text } })
    } else {
      ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
      ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
    }
    ev('content_block_stop', { index: i })
  })
  ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } })
  ev('message_stop', {})
  res.end()
}
let shell = null // 模型这一边看到的命令行工具：{ name, escalation }
const textOf = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || (c.type === 'tool_result' ? '[tool_result]' : '')).join(' '))
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', async () => {
    let body = {}
    try { body = JSON.parse(raw) } catch {}
    const msgs = body.messages || []
    const last = msgs[msgs.length - 1] || {}
    const all = msgs.map(textOf).join('\n')
    const agent = Array.isArray(body.tools) && body.tools.length > 0
    const result = (Array.isArray(last.content) ? last.content : []).filter((c) => c.type === 'tool_result')
      .map((c) => (typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text || '').join(' '))).join(' ')
    llmLog.push({ path: req.url, agent, tools: (body.tools || []).map((t) => t.name), last: textOf(last).slice(0, 80), ...(result ? { result: result.slice(0, 600) } : {}) })
    if (!req.url.includes('/messages')) { res.writeHead(404); return res.end() }
    if (!agent) return sse(res, [{ type: 'text', text: all.includes('PUSH-SLOW') ? '慢任务' : '批准测试' }], 'end_turn') // 起标题之类的旁路请求
    if (textOf(last).includes('[tool_result]')) return sse(res, [{ type: 'text', text: '好了。' }], 'end_turn')
    // 看最后一条（这一轮的话）：历史里还留着上一轮的 PUSH-SLOW
    if (textOf(last).includes('PUSH-SLOW')) { await sleep(DONE_WAIT_MS); return sse(res, [{ type: 'text', text: '慢慢做完了。' }], 'end_turn') }
    if (textOf(last).includes('PUSH-BASH')) {
      // 只有带沙盒的 DSH 才会为「要更大权限」弹批准（工具参数里有 sandbox_permissions）；没有就不跑命令
      const tool = (body.tools || []).find((t) => /bash|shell|pwsh/i.test(t.name))
      const props = (tool && (tool.input_schema || tool.parameters || {}).properties) || {}
      shell = { name: tool && tool.name, escalation: 'sandbox_permissions' in props }
      if (!shell.escalation) return sse(res, [{ type: 'text', text: '这台没有沙盒。' }], 'end_turn')
      const input = { command: `echo hi > "${path.join(HOME, 'outside.txt')}"`, sandbox_permissions: 'danger-full-access', justification: '测试：要写工作区外的文件' }
      if ('description' in props) input.description = '写一个工作区外的文件'
      return sse(res, [{ type: 'tool_use', id: 'toolu_e2e_1', name: tool.name, input }], 'tool_use')
    }
    return sse(res, [{ type: 'text', text: '你好。' }], 'end_turn')
  })
})

// ── 本地 Webhook：当作用户的推送服务 ──
const pushes = []
const T0 = Date.now()
const hook = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => { try { pushes.push({ ...JSON.parse(raw), t: Date.now() - T0 }) } catch { pushes.push({ raw, t: Date.now() - T0 }) } res.end('{"ok":true}') })
})

// ── 无头 Chrome（CDP 走 --remote-debugging-pipe）──
function chromeBin() {
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)
  const c = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    win32: roots.map((d) => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
  }
  return [process.env.CHROME_BIN, ...(c[process.platform] || [])].filter(Boolean).find((p) => fs.existsSync(p)) || null
}
function launchChrome(bin) {
  const udd = path.join(tmp, 'chrome')
  const proc = spawn(bin, ['--remote-debugging-pipe', `--user-data-dir=${udd}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,900', ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []), ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true })
  const pending = new Map()
  let seq = 0
  let buf = Buffer.alloc(0)
  proc.stdio[4].on('data', (d) => {
    buf = Buffer.concat([buf, d])
    let i
    while ((i = buf.indexOf(0)) >= 0) {
      const msg = JSON.parse(buf.subarray(0, i).toString('utf8'))
      buf = buf.subarray(i + 1)
      const p = msg.id && pending.get(msg.id)
      if (!p) continue
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result)
    }
  })
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    proc.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`)
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} 超时`)) }, 30000)
  })
  const close = () => new Promise((r) => {
    if (proc.exitCode !== null) return r()
    if (WIN) execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => r())
    else { proc.kill('SIGKILL'); setTimeout(r, 500) }
  })
  return { cdp, close }
}

let web = null
let webLog = ''
let chrome = null
let dshVersion = DSH_SPEC

try {
  await new Promise((r) => llm.listen(0, '127.0.0.1', r))
  await new Promise((r) => hook.listen(0, '127.0.0.1', r))
  env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${llm.address().port}`
  const HOOK = `http://127.0.0.1:${hook.address().port}/hook`

  // ① 打包、装进全新的 DSH
  fs.mkdirSync(path.join(tmp, 'cli'), { recursive: true })
  const pack = run('npm', ['pack', '--pack-destination', tmp], { cwd: ROOT })
  const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'))
  if (!check('打包', pack.code === 0 && tgz, pack.out.slice(-800))) throw new Error('打包失败')
  fs.writeFileSync(path.join(tmp, 'cli', 'package.json'), '{"private":true}')
  const inst = run('npm', ['i', `@deepseek-ai/dsh@${DSH_SPEC}`, 'pnpm@11', `--registry=${REGISTRY}`, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: path.join(tmp, 'cli') })
  if (!check(`装 DSH ${DSH_SPEC}`, inst.code === 0, inst.out.slice(-800))) throw new Error('DSH 没装上')
  const cliDir = path.join(tmp, 'cli', 'node_modules', '@deepseek-ai', 'dsh')
  dshVersion = JSON.parse(fs.readFileSync(path.join(cliDir, 'package.json'), 'utf8')).version
  const add = run(process.execPath, [path.join(cliDir, 'lib', 'bin.js'), 'plugin', '--profile', 'web', 'add', path.join(tmp, tgz)], { cwd: tmp })
  if (!check('DSH 装上插件', add.code === 0, add.out.slice(-800))) throw new Error('插件没装上')
  const work = path.join(tmp, 'work')
  fs.mkdirSync(work, { recursive: true })
  const url = await new Promise((resolve) => {
    web = spawn(process.execPath, [path.join(cliDir, 'lib', 'bin.js'), 'web', '--no-open', '--port', '0', '--host', '127.0.0.1'], { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })
    const on = (d) => { webLog = (webLog + d).slice(-50000); const m = /dsh web: (http:\/\/\S+)/.exec(webLog); if (m) resolve(m[1]) }
    web.stdout.on('data', on)
    web.stderr.on('data', on)
    web.on('exit', () => resolve(null))
    setTimeout(() => resolve(null), 180_000)
  })
  if (!check('DSH 网页版起来了', url, webLog.slice(-1500))) throw new Error('网页版没起来')
  const origin = new URL(url).origin

  // ② 浏览器打开官方界面（带登录令牌），设置页接口也从页面里调（用页面的登录）
  const bin = chromeBin()
  if (!check('找到 Chrome', bin)) throw new Error('没有 Chrome')
  chrome = launchChrome(bin)
  const { targetId } = await chrome.cdp('Target.createTarget', { url })
  const { sessionId } = await chrome.cdp('Target.attachToTarget', { targetId, flatten: true })
  const page = async (expression) => {
    const r = await chrome.cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  const until = async (expression, ms = 60000) => {
    const end = Date.now() + ms
    let v = null
    while (Date.now() < end) {
      try { v = await page(expression) } catch { v = null }
      if (v) return v
      await sleep(500)
    }
    return v
  }
  const panel = (body) => page(`fetch('/dsh-mobile/panel', ${body ? `{ method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} }` : '{}'}).then((r) => r.json())`)
  const composer = '[contenteditable="true"], textarea'
  if (!check('界面加载出输入框', await until(`!!document.querySelector('${composer}')`, 90000), (await page('document.body.innerText.slice(0, 400)').catch((e) => e.message)))) throw new Error('没有输入框')

  // 第一次打开有「预览版说明」挡着：点「继续」
  await page(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^(继续|Continue)$/.test(x.innerText.trim())); if (b) b.click(); return !!b })()`)
  await sleep(800)

  let st = await panel({ action: 'push', url: HOOK })
  check('设置页存下推送地址', st.push && st.push.kind === 'webhook', JSON.stringify(st.push))
  st = await panel({ action: 'pushTest' })
  check('发一条试试：Webhook 收到', !st.actionError && pushes.length === 1 && /^DSH/.test(pushes[0].title), st.actionError || JSON.stringify(pushes))

  const say = async (text) => {
    await page(`(() => { const el = document.querySelector('${composer}'); el.focus(); return true })()`)
    await chrome.cdp('Input.insertText', { text }, sessionId)
    await sleep(300)
    for (const type of ['keyDown', 'keyUp']) await chrome.cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) }, sessionId)
  }

  // ③ 慢任务 → 「任务完成」
  const before = pushes.length
  await say('PUSH-SLOW 请慢慢做一件事')
  const started = await until(`(() => { const t = document.body.innerText; return t.includes('PUSH-SLOW') })()`, 30000)
  check('任务发出去了', started, (await page('document.body.innerText.slice(-600)').catch((e) => e.message)))
  const end = Date.now() + DONE_WAIT_MS + 60000
  while (Date.now() < end && !pushes.slice(before).some((p) => /完成|done/i.test(p.title))) await sleep(1000)
  const done = pushes.slice(before).find((p) => /完成|done/i.test(p.title))
  check('跑了 30 秒以上：收到「任务完成」', done, `收到 ${JSON.stringify(pushes.slice(before))}；模型请求 ${JSON.stringify(llmLog.slice(-4))}`)
  if (done) {
    check('通知里有用时', /\d+ 秒|\d+ 分|\d+s/.test(done.body), done.body)
    console.log(`  （通知：${done.title} / ${done.body}）`)
  }

  // ④ 让模型用 bash → 「等你批准」
  const before2 = pushes.length
  await say('PUSH-BASH 请执行一个命令')
  const end2 = Date.now() + 60000
  while (Date.now() < end2 && !(shell && !shell.escalation) && !pushes.slice(before2).some((p) => /批准|approval/i.test(p.title))) await sleep(1000)
  const ask = pushes.slice(before2).find((p) => /批准|approval/i.test(p.title))
  if (shell && !shell.escalation) console.log(`  （这台机器上 DSH 的 ${shell.name || '命令行工具'} 没有沙盒，不会弹批准：跳过这一项）`)
  else check('要批准时收到「等你批准」', ask, `收到 ${JSON.stringify(pushes.slice(before2))}；全部推送 ${JSON.stringify(pushes)}；页面 ${(await page('document.body.innerText.slice(-800)').catch((e) => e.message))}`)
  if (ask) {
    console.log(`  （通知：${ask.title} / ${ask.body}）`)
    const card = await until(`/批准|允许|Allow|Approve/i.test(document.body.innerText)`, 20000)
    check('批准卡片照常出现（推送没替用户做决定）', card, (await page('document.body.innerText.slice(-600)').catch((e) => e.message)))
    check('命令还没执行', !fs.existsSync(path.join(HOME, 'outside.txt')))
  }
} catch (e) {
  check('没有异常', false, (e && e.stack) || e)
} finally {
  if (failed().length) {
    console.log(`\n── DSH 日志 ──\n${webLog.split('\n').slice(-25).join('\n')}`)
    console.log(`\n── 模型请求 ──\n${JSON.stringify(llmLog.slice(-8), null, 1)}`)
    const ml = path.join(tmp, 'dsh-home', 'dsh-mobile', 'mobile.log')
    try { console.log(`\n── 插件日志 ──\n${fs.readFileSync(ml, 'utf8').slice(-1500)}`) } catch {}
  }
  if (chrome) await chrome.close()
  if (web && web.exitCode === null) web.kill('SIGTERM')
  llm.close()
  hook.close()
  await sleep(1500)
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) } catch {}
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 手机推送真机测试 · ${OS} · DSH ${dshVersion}\n\n${results.map((x) => `- ${x.ok ? '✅' : '❌'} ${x.name}${x.ok ? '' : `：${x.extra.split('\n')[0]}`}`).join('\n')}\n\n`)
  console.log(failed().length ? `\n❌ ${failed().length} 项没过` : '\n✅ 全部通过')
  process.exit(failed().length ? 1 : 0)
}
