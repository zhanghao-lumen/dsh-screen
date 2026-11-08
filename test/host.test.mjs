process.env.DSH_SCREEN_NO_SAMPLER = '1'
import { createServer } from 'node:http'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const { apply, internals } = mod
const runtime = internals.runtime

const tools = new Map()
const commands = new Map()
let route = null
let sessionHandler = null
const disposers = []
const sections = []

const agent = {
  id: 'session-1',
  status: 'idle',
  options: { provider: 'deepseek', model: 'deepseek-vision' },
  followup(msg) { this.sent = msg },
}

const other = {
  id: 'session-2',
  status: 'idle',
  options: { provider: 'deepseek', model: 'deepseek-vision' },
  followup(msg) { this.sent = msg },
}
let boundAlive = true

const ctx = {
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
  // cordis: 服务就绪后才执行回调；桩里服务都在，直接同步执行
  inject(deps, cb) { return cb(this) },
  on(name, handler) { if (name === 'session/event') sessionHandler = handler; return () => {} },
  get(key) {
    if (key === 'tools') return { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } }
    if (key === 'commands') return { register: (def) => { commands.set(def.name, def); return () => commands.delete(def.name) } }
    if (key === 'webServer') return { register: (r) => { route = r; return () => { route = null } } }
    if (key === 'agents')
      return {
        get: (id) => (id === 'session-1' && boundAlive ? agent : id === 'session-2' ? other : undefined),
        list: () => (boundAlive ? [agent, other] : [other]),
      }
    if (key === 'attachments') return { saveImages: async (list) => list.map((f, i) => ({ attachmentId: `att-${i}`, bytes: f.data.length })) }
    if (key === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
    if (key === 'systemPrompt') return { section: (def) => { sections.push(def); return () => {} } }
    return undefined
  },
}

for (const key of ['tools', 'commands', 'webServer', 'agents', 'attachments', 'llm', 'systemPrompt']) {
  Object.defineProperty(ctx, key, { get: () => ctx.get(key) })
}

apply(ctx)
console.log('tools:', [...tools.keys()].join(','))
console.log('commands:', [...commands.keys()].join(','))
console.log('route:', route?.path, route?.kind)

// 1. /study on
const on = await commands.get('study').handler({ agent, rawInput: ' on', attachments: [] })
console.log('\n[study on]', on.kind, '|', on.text)
console.log('timer 已启动:', runtime.timer !== null)
const sec = sections[0]
console.log('prompt section:', sec?.name, 'order', sec?.order)
console.log('prompt(on):', String(sec?.text()).split('\n')[0])
console.log('runtime.enabled=', runtime.enabled, 'interval=', runtime.intervalMs)

// 2. tick → followup
const t1 = await internals.tick(ctx)
console.log('\n[tick]', JSON.stringify(t1))
const sent = agent.sent
console.log('followup content blocks:', sent.content.map((b) => b.type).join(','))
console.log('text head:', sent.content[0].text.split('\n')[0])
console.log('source:', JSON.stringify(sent.source), 'role:', sent.role, 'id:', Boolean(sent.id))

// 3. harvest assistant reply
sessionHandler({ id: 'session-1' }, { type: 'assistant/message', data: { stream: [
  { type: 'chunk', time: 1000, chunk: { type: 'text-delta', text: '第三章线性回归，' } },
  { type: 'chunk', time: 1001, chunk: { type: 'text-delta', text: '讲到最小二乘法的推导。' } },
] } })
await new Promise((r) => setTimeout(r, 30))
console.log('\n[harvest] notes=', runtime.notes.length, '|', runtime.notes[0]?.text ?? '(none)')
console.log('digest:', internals.digest())

// 3b. 摘要差分：第二次注入只带「自上次以来」的新笔记，不重复整段 10 分钟摘要
runtime.changeSeq += 1
await internals.tick(ctx)
const deltaText = agent.sent.content[0].text
const deltaLine = deltaText.split('\n').find((line) => line.startsWith('自上次观察以来'))
console.log('\n[digest delta] has old note:', deltaText.includes('最小二乘'), '|', deltaLine ?? '(missing)')
if (!deltaText.includes('最小二乘') || !deltaLine) throw new Error('digest delta 没有带上新笔记')

runtime.changeSeq += 1
await internals.tick(ctx)
const againText = agent.sent.content[0].text
console.log('[digest delta] no-new-note line:', againText.includes('自上次观察以来没有新的笔记。'))
if (!againText.includes('自上次观察以来没有新的笔记。')) throw new Error('无新笔记时应明确说明')

// 4a. 屏幕没变化 → 本地直接跳过，不产生模型调用
const skip = await internals.tick(ctx)
console.log('\n[local dedup]', JSON.stringify(skip))

// 4b. 有变化但模型两次都说 <no-change> → 退避
const before = runtime.baseMs
for (let round = 1; round <= 2; round += 1) {
  runtime.changeSeq += 1
  await internals.tick(ctx)
  sessionHandler({ id: 'session-1' }, { type: 'assistant/message', data: { stream: [
    { type: 'chunk', time: 1000, chunk: { type: 'text-delta', text: '<no-change>' } },
  ] } })
  await new Promise((r) => setTimeout(r, 30))
  console.log(`[no-change round ${round}] streak=`, runtime.noChangeStreak, 'baseMs=', runtime.baseMs)
}
console.log('[backoff]', before, '->', runtime.baseMs, '| notes 仍为', runtime.notes.length)

// 4c. 采样一次，尺寸/差异/大小
const sampleA = await internals.sampleOnce(ctx)
const sampleB = await internals.sampleOnce(ctx)
console.log('[sample] first:', JSON.stringify(sampleA))
console.log('[sample] second:', JSON.stringify(sampleB))
console.log('[cache]', 'thumb', runtime.cache.thumb.width + 'x' + runtime.cache.thumb.height,
  'changes', runtime.changes, 'watching', Boolean(runtime.sampler))

// 5. agent running → skip
agent.status = 'running'
console.log('\n[tick busy]', JSON.stringify(await internals.tick(ctx)))
agent.status = 'idle'

// 6. tools
const shot = await tools.get('screen_shot').execute({ scale: 480 }, { agent, signal: undefined })
console.log('\n[screen_shot]', shot.imageStatus, '| images:', shot.images.length)
const blocks = tools.get('screen_shot').output.render({}, shot)
console.log('render types:', blocks.map((b) => b.type).join(','))
console.log('[screen_status]\n' + (await tools.get('screen_status').execute({}, {})))
console.log('\n[study_notes]\n' + (await tools.get('study_notes').execute({ limit: 5 }, {})))

// 7. HTTP matrix
const server = createServer((req, res) => route.handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}${route.path}`
const call = async (path, init) => {
  const res = await fetch(base + path, init)
  const text = await res.text()
  return `${res.status} ${text.slice(0, 110)}`
}
console.log('\n[api] GET /state ->', await call('/state'))
console.log('[api] POST off ->', await call('/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) }))
console.log('[api] POST bad type ->', await call('/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: 'yes' }) }))
console.log('[api] POST text/plain ->', await call('/state', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }))
console.log('[api] DELETE ->', await call('/state', { method: 'DELETE' }))
console.log('[api] GET /nope ->', await call('/nope'))
console.log('[prompt off] 关闭后 section 文本长度:', (await commands.get('study').handler({ agent, rawInput: ' off', attachments: [] }), String(sec.text()).length))
console.log('timer 已停止:', runtime.timer === null)

// 8. gate: watch tool while off
try {
  await tools.get('screen_watch').execute({ seconds: 1 }, { agent })
  console.log('\n[gate] ✗ 未拦截')
} catch (err) {
  console.log('\n[gate] 拦截：', err.message.slice(0, 46))
}
// 9. voice
console.log('\n[voice cmd]\n' + (await commands.get('voice').handler({ agent, rawInput: ' status', attachments: [] })).text)
console.log('[api] GET /voice/state ->', await call('/voice/state'))
console.log('[api] POST /voice/tts off ->', await call('/voice/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) }))
console.log('[api] POST /voice/state（错误方法）->', await call('/voice/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
console.log('[api] POST /voice/stop（没在录）->', await call('/voice/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
console.log('[api] POST /voice/nope ->', await call('/voice/nope', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))

const realFetch = globalThis.fetch
globalThis.fetch = async () => ({ ok: true, text: async () => '  这是语音测试，请把这句话转成文字。 [BLANK_AUDIO]\n' })
runtime.voice.port = 64999
console.log('[transcribe] ->', JSON.stringify(await mod.transcribe('/tmp/t.wav')))
globalThis.fetch = realFetch

// 11b. 电平阈值：现场生成 WAV，不依赖本机任何临时文件（CI 也能跑）
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function wavBuffer(seconds, amp) {
  const sr = 16000
  const n = Math.round(sr * seconds)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sr, 24)
  buf.writeUInt32LE(sr * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(Math.sin(i / 8) * amp * 32767), 44 + i * 2)
  return buf
}

const silentWav = join(tmpdir(), `dsh-screen-silence-${process.pid}.wav`)
const voiceWav = join(tmpdir(), `dsh-screen-voice-${process.pid}.wav`)
writeFileSync(silentWav, wavBuffer(1, 0))
writeFileSync(voiceWav, wavBuffer(1, 0.3))
const silentRms = Math.round(await internals.wavRms(silentWav))
const voiceRms = Math.round(await internals.wavRms(voiceWav))
console.log('[silence] 静音 RMS =', silentRms, '| 有声音 RMS =', voiceRms, '（<90 视为没说话）')
if (silentRms >= 90 || voiceRms < 90) throw new Error('电平阈值判断不对')

runtime.voice.tts = false
mod.speak('这一句不该被念出来')
console.log('[tts] 关闭时不说话:', runtime.voice.speaking === undefined || runtime.voice.speaking === null)

// 10. doctor：真抓一帧 + 检查模型 + 真发一帧
const doc = await commands.get('study').handler({ agent, rawInput: ' doctor', attachments: [] })
console.log('\n[study doctor]\n' + doc.text)
if (!doc.text.includes('抓屏') || !doc.text.includes('支持图片输入')) throw new Error('study doctor 输出不完整')

// 11. 会话隔离：绑定会话下线后必须跳过，绝不注入到别的会话
runtime.enabled = true
runtime.sessionId = 'session-1'
boundAlive = false
runtime.changeSeq += 1
const iso = await internals.tick(ctx)
console.log('\n[isolation]', JSON.stringify(iso), '| 别的会话收到消息:', Boolean(other.sent))
if (iso.skipped !== 'bound-session-missing') throw new Error('绑定会话失效时应跳过')
if (other.sent) throw new Error('会话隔离失败：注入到了别的会话')

// 12. 任意会话的事件不再改写绑定
sessionHandler({ id: 'session-2' }, { type: 'assistant/message', data: { stream: [] } })
console.log('[isolation] onEvent 之后绑定仍是:', runtime.sessionId, '| lastActive:', runtime.lastActiveSession)
if (runtime.sessionId !== 'session-1') throw new Error('onEvent 不应改写注入目标')

server.close()
process.exit(0)
