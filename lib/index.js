import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-screen'
export const inject = ['tools']

const API_PATH = '/dsh-screen-api'

const DEFAULT_SCALE = 1280
const MIN_SCALE = 480
const MAX_SCALE = 2560
const MAX_FRAMES = 8
const MAX_SECONDS = 15
const MIN_INTERVAL_MS = 400
const MAX_INTERVAL_MS = 5000

const AUTO_MIN_MS = 10_000
const AUTO_MAX_MS = 300_000
const AUTO_DEFAULT_MS = 30_000

const SAMPLE_MS = 1200
const CACHE_FRESH_MS = 3000
const DIFF_THRESHOLD = 2.2
const HEARTBEAT_MS = 5 * 60 * 1000
const THUMB_SIZE = 16
const VOICE_MAX_SECONDS = 45
const VOICE_MODEL_URL = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'
const VOICE_MODEL_FILE = 'ggml-base.bin'
const VOICE_MODEL_BYTES = 147951465
const NOTES_WINDOW_MS = 10 * 60 * 1000
const NOTES_MAX_ITEMS = 40
const NOTES_MAX_CHARS = 2400
const DIGEST_MAX_CHARS = 900

// CI 里没有图形会话也没有 TCC，抓屏必然失败；用固定帧替代，只验证代码路径。
const FAKE_CAPTURE = process.env.DSH_SCREEN_FAKE_CAPTURE === '1'

const OBS_MARK = '【屏幕观察】'
const NO_CHANGE = '<no-change>'
const NO_CHANGE_RE = /<no-change>|没有(?:实质)?变化|无明显变化|无变化/

const runtime = {
  stats: { days: {} },
  registeredCommands: [],
  enabled: false,
  baseMs: AUTO_DEFAULT_MS,
  intervalMs: AUTO_DEFAULT_MS,
  sessionId: null,
  lastActiveSession: null,
  notes: [],
  lastCaptureAt: 0,
  lastError: null,
  pendingObs: null,
  noChangeStreak: 0,
  timer: null,
  ticking: false,
  epoch: 0,
  cache: null,
  sampler: null,
  sampling: false,
  changes: 0,
  changeSeq: 0,
  lastInjectedSeq: -1,
  lastInjectedAt: 0,
  noteSeq: 0,
  lastInjectedNoteSeq: 0,
  voice: {
    recording: false,
    serverReady: false,
    startedAt: 0,
    child: null,
    spool: null,
    wav: null,
    stopFile: null,
    preparing: null,
    download: null,
    awaitingReply: false,
    tts: true,
    lastText: '',
    lastError: null,
  },
}

/* ------------------------------------------------------------------ utils */

function optionalService(ctx, key) {
  try {
    const viaGet = ctx?.get?.(key)
    if (viaGet) return viaGet
  } catch {
    /* service not mounted */
  }
  try {
    return ctx?.[key]
  } catch {
    return undefined
  }
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function nowIso() {
  return new Date().toISOString()
}

function hhmm(t) {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function statePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-screen.state.json')
}

async function readPersisted() {
  try {
    const raw = await readFile(statePath(), 'utf8')
    const parsed = JSON.parse(raw)
    return {
      enabled: parsed?.enabled === true,
      intervalMs: clamp(parsed?.intervalMs, AUTO_MIN_MS, AUTO_MAX_MS, AUTO_DEFAULT_MS),
    }
  } catch {
    return { enabled: false, intervalMs: AUTO_DEFAULT_MS }
  }
}

async function writePersisted() {
  const payload = JSON.stringify({ enabled: runtime.enabled, intervalMs: runtime.baseMs }, null, 2)
  try {
    await writeFile(statePath(), `${payload}\n`, 'utf8')
  } catch (err) {
    runtime.lastError = `状态写盘失败：${err?.message ?? err}`
  }
}

/* ------------------------------------------------------------- screen cap */

function run(cmd, args, signal) {
  return new Promise((resolve, reject) => {
    let stderr = ''
    let child
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], signal })
    } catch (err) {
      reject(err)
      return
    }
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} 退出码 ${code}: ${stderr.trim() || '无输出'}`))
    })
  })
}

function runCapture(cmd, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    let timer
    const done = (result) => {
      clearTimeout(timer)
      resolve(result)
    }
    timer = setTimeout(() => {
      try {
        child?.kill?.()
      } catch {
        /* already gone */
      }
      done({ ok: false, stdout, stderr: stderr || '超时' })
    }, timeoutMs)
    timer.unref?.()
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      done({ ok: false, stdout: '', stderr: String(err?.message ?? err) })
      return
    }
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (err) => done({ ok: false, stdout, stderr: String(err?.message ?? err) }))
    child.on('close', (code) => done({ ok: code === 0, stdout, stderr }))
  })
}

function jpegSize(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1
      continue
    }
    const marker = buf[i + 1]
    if (marker === 0xd8 || marker === 0xd9) {
      i += 2
      continue
    }
    const len = buf.readUInt16BE(i + 2)
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    i += 2 + len
  }
  return null
}

export async function captureFrame({ display, scale, signal } = {}) {
  if (FAKE_CAPTURE) {
    try {
      const data = readFileSync(join(PLUGIN_ROOT, 'test', 'fixtures', 'frame.jpg'))
      const size = jpegSize(data) ?? { width: 480, height: 312 }
      return { data, width: size.width, height: size.height, bytes: data.length, at: Date.now() }
    } catch (err) {
      throw new Error(`假抓屏失败（缺少 test/fixtures/frame.jpg）：${err?.message ?? err}`)
    }
  }
  const width = clamp(scale, MIN_SCALE, MAX_SCALE, DEFAULT_SCALE)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-screen-'))
  const raw = join(dir, 'raw.jpg')
  const out = join(dir, 'frame.jpg')
  try {
    const args = ['-x', '-t', 'jpg']
    const d = Number(display)
    if (Number.isFinite(d) && d > 1) args.push('-D', String(Math.round(d)))
    args.push(raw)
    await run('/usr/sbin/screencapture', args, signal)
    await run('/usr/bin/sips', ['-Z', String(width), '-s', 'format', 'jpeg', raw, '--out', out], signal)
    const data = await readFile(out)
    const size = jpegSize(data) ?? { width, height: 0 }
    return { data, width: size.width, height: size.height, bytes: data.length, scale: width }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/* ------------------------------------------------------------ live sampler */

function parseBmpGray(buf) {
  const offset = buf.readUInt32LE(10)
  const width = buf.readInt32LE(18)
  const rawHeight = buf.readInt32LE(22)
  const bpp = buf.readUInt16LE(28)
  const topDown = rawHeight < 0
  const height = Math.abs(rawHeight)
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4
  const bytesPerPixel = Math.max(1, Math.floor(bpp / 8))
  const gray = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    const srcY = topDown ? y : height - 1 - y
    const row = offset + srcY * rowSize
    for (let x = 0; x < width; x += 1) {
      const i = row + x * bytesPerPixel
      gray[y * width + x] = Math.round(0.299 * buf[i + 2] + 0.587 * buf[i + 1] + 0.114 * buf[i])
    }
  }
  return { width, height, gray }
}

/** 16px 缩略图，只用来判断“画面变了没有”，不进模型。 */
function fakeThumbBmp() {
  const w = THUMB_SIZE
  const h = 10
  const rowSize = Math.ceil((w * 3) / 4) * 4
  const pixelBytes = rowSize * h
  const buf = Buffer.alloc(54 + pixelBytes)
  buf.write('BM', 0, 'ascii')
  buf.writeUInt32LE(54 + pixelBytes, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(w, 18)
  buf.writeInt32LE(h, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(pixelBytes, 34)
  return buf
}

async function captureThumb(signal) {
  if (FAKE_CAPTURE) return parseBmpGray(fakeThumbBmp())
  const dir = await mkdtemp(join(tmpdir(), 'dsh-screen-thumb-'))
  const raw = join(dir, 'raw.jpg')
  const out = join(dir, 'thumb.bmp')
  try {
    await run('/usr/sbin/screencapture', ['-x', '-t', 'jpg', raw], signal)
    await run('/usr/bin/sips', ['-Z', String(THUMB_SIZE), '-s', 'format', 'bmp', raw, '--out', out], signal)
    return parseBmpGray(await readFile(out))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function meanAbsDiff(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return Number.POSITIVE_INFINITY
  let sum = 0
  for (let i = 0; i < a.gray.length; i += 1) sum += Math.abs(a.gray[i] - b.gray[i])
  return sum / a.gray.length
}

/** 采样一次：更新缓存，必要时（有变化）立刻触发一次观察。 */
export async function sampleOnce(ctx) {
  if (runtime.sampling) return { skipped: 'sampling-busy' }
  runtime.sampling = true
  try {
    const frame = await captureFrame({ scale: 960 })
    const thumb = await captureThumb()
    const diff = meanAbsDiff(runtime.cache?.thumb, thumb)
    const changed = !runtime.cache || diff > DIFF_THRESHOLD
    runtime.cache = { frame, thumb, at: Date.now(), diff, changed }
    if (changed) {
      runtime.changes += 1
      runtime.changeSeq += 1
    }
    runtime.lastError = null
    return { changed, diff: Math.round(diff * 10) / 10, bytes: frame.bytes }
  } catch (err) {
    runtime.lastError = String(err?.message ?? err)
    return { error: runtime.lastError }
  } finally {
    runtime.sampling = false
  }
}

function startSampler(ctx) {
  if (runtime.sampler || process.env.DSH_SCREEN_NO_SAMPLER === '1') return
  runtime.sampler = setInterval(() => {
    if (!runtime.enabled) return
    void sampleOnce(ctx)
  }, SAMPLE_MS)
  runtime.sampler.unref?.()
}

function stopSampler() {
  if (!runtime.sampler) return
  clearInterval(runtime.sampler)
  runtime.sampler = null
  runtime.cache = null
}

/* ------------------------------------------------------- model / attachments */

function routeOf(agent) {
  const options = agent?.options ?? {}
  return { provider: options.provider, model: options.model }
}

async function canSeeImages(ctx, agent, signal) {
  const llm = optionalService(ctx, 'llm')
  if (!llm?.resolveModelInfo) return { ok: false, reason: '当前没有可用的 llm 服务' }
  const { provider, model } = routeOf(agent)
  if (!provider || !model) return { ok: false, reason: '拿不到当前会话使用的模型' }
  try {
    const info = await llm.resolveModelInfo(provider, model, signal)
    const modalities = info?.inputModalities ?? []
    if (!modalities.includes('image')) {
      return { ok: false, reason: `模型 ${model} 不接受图片输入` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `查询模型能力失败：${err?.message ?? err}` }
  }
}

async function saveFrames(ctx, frames) {
  const attachments = optionalService(ctx, 'attachments')
  if (!attachments?.saveImages) throw new Error('附件服务不可用，无法把画面交给模型')
  const refs = await attachments.saveImages(
    frames.map((frame) => ({ data: new Uint8Array(frame.data), mediaType: 'image/jpeg' })),
  )
  return Array.isArray(refs) ? refs : [refs]
}

function renderValue(value) {
  const blocks = [{ type: 'text', text: value?.imageStatus ?? '已抓取屏幕画面' }]
  for (const image of value?.images ?? []) blocks.push({ type: 'image', attachment: image })
  if (value?.meta) blocks.push({ type: 'text', text: value.meta })
  return blocks
}

/* ------------------------------------------------------------------ notes */

function pruneNotes() {
  const cutoff = Date.now() - NOTES_WINDOW_MS
  runtime.notes = runtime.notes.filter((note) => note.t >= cutoff)
  if (runtime.notes.length > NOTES_MAX_ITEMS) runtime.notes = runtime.notes.slice(-NOTES_MAX_ITEMS)
  let total = runtime.notes.reduce((sum, note) => sum + note.text.length, 0)
  while (total > NOTES_MAX_CHARS && runtime.notes.length > 1) {
    total -= runtime.notes[0].text.length
    runtime.notes.shift()
  }
}

function addNote(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim()
  if (!clean) return
  runtime.noteSeq += 1
  runtime.notes.push({ t: Date.now(), seq: runtime.noteSeq, text: clean })
  pruneNotes()
}

function digest(maxChars = DIGEST_MAX_CHARS) {
  pruneNotes()
  if (!runtime.notes.length) return ''
  const lines = runtime.notes.map((note) => `${hhmm(note.t)} ${note.text}`)
  let out = lines.join('\n')
  if (out.length > maxChars) out = `${out.slice(out.length - maxChars)}`
  return out
}

/**
 * 只取「自上次注入以来」的新笔记，最多 limit 条。
 * 笔记窗口有 10 分钟而注入每 30 秒一次，若每次都重发整段摘要，
 * 九成内容与上一次完全相同——这是插件最大的一处纯浪费。
 */
function digestDelta(sinceSeq, limit = 3) {
  pruneNotes()
  // 用自增序号而不是时间戳：同一毫秒内「注入」与「回捞」的顺序不可靠。
  const fresh = runtime.notes.filter((note) => note.seq > sinceSeq)
  if (!fresh.length) return { text: '', total: 0, omitted: 0 }
  const picked = fresh.slice(-limit)
  const text = picked.map((note) => `${hhmm(note.t)} ${note.text}`).join('\n')
  return { text, total: fresh.length, omitted: Math.max(0, fresh.length - picked.length) }
}

/* ------------------------------------------------------------------- tick */

/**
 * 找当前要注入的会话。
 *
 * 自动注入（tick）必须严格：只认开启学习模式时绑定的那个会话，绑定失效就跳过，
 * 绝不能「顺手挑一个活着的会话」——那会把 A 会话的屏幕画面注入到 B 会话里，
 * 而且用户完全看不出来。只有用户显式发起的动作（HTTP 按钮、命令）才允许回落。
 */
function currentAgent(ctx, { allowFallback = false } = {}) {
  const agents = optionalService(ctx, 'agents')
  if (!agents?.get) return undefined
  if (runtime.sessionId) {
    try {
      const bound = agents.get(runtime.sessionId)
      if (bound) return bound
    } catch {
      /* stale id */
    }
    if (!allowFallback) return undefined
  }
  if (typeof agents.list === 'function') {
    try {
      const live = agents.list() ?? []
      const pick = live.find((a) => a?.status === 'running') ?? live[live.length - 1]
      if (pick?.id) {
        if (!runtime.sessionId || allowFallback) runtime.sessionId = pick.id
        return pick
      }
    } catch {
      /* registry closed */
    }
  }
  return undefined
}

function scheduleTimer(ctx) {
  if (runtime.timer) {
    clearInterval(runtime.timer)
    runtime.timer = null
  }
  if (!runtime.enabled) {
    stopSampler()
    return
  }
  startSampler(ctx)
  runtime.intervalMs = runtime.baseMs
  runtime.timer = setInterval(() => {
    void tick(ctx)
  }, runtime.intervalMs)
  runtime.timer.unref?.()
}

function slowDown() {
  runtime.noChangeStreak += 1
  if (runtime.noChangeStreak < 2) return
  runtime.intervalMs = clamp(Math.round(runtime.intervalMs * 1.5), AUTO_MIN_MS, AUTO_MAX_MS, runtime.baseMs)
  runtime.baseMs = runtime.intervalMs
}

export async function tick(ctx) {
  if (!runtime.enabled || runtime.ticking) return { skipped: 'disabled-or-busy' }
  const agent = currentAgent(ctx)
  if (!agent) return { skipped: runtime.sessionId ? 'bound-session-missing' : 'no-session' }
  if (agent.status !== 'idle') return { skipped: 'agent-running' }
  // 本地去重：屏幕自上次注入以来没变过、也不到心跳时间，就什么都不发（省 token）。
  const idleSinceInject = Date.now() - runtime.lastInjectedAt
  if (runtime.changeSeq === runtime.lastInjectedSeq && idleSinceInject < HEARTBEAT_MS) {
    return { skipped: 'no-change-local', secs: Math.round(idleSinceInject / 1000) }
  }
  runtime.ticking = true
  try {
    const support = await canSeeImages(ctx, agent)
    const cache = runtime.cache
    const cachedFresh = cache && Date.now() - cache.at < CACHE_FRESH_MS
    const frame = cachedFresh ? cache.frame : await captureFrame({ scale: DEFAULT_SCALE })
    if (cachedFresh) runtime.cache = { ...cache, ageMs: Date.now() - cache.at }
    const frames = support.ok ? [frame] : []
    const images = frames.length ? await saveFrames(ctx, frames) : []
    const delta = digestDelta(runtime.lastInjectedNoteSeq)
    const freshLine = delta.total
      ? `自上次观察以来的新笔记（${delta.total} 条${delta.omitted ? `，只列最新 ${delta.total - delta.omitted} 条` : ''}）：\n${delta.text}`
      : runtime.lastInjectedNoteSeq
        ? '自上次观察以来没有新的笔记。'
        : '这是本次学习的第一条观察，之前没有笔记。'
    const text = [
      `${OBS_MARK} ${nowIso()} 自动抓取（每 ${Math.round(runtime.intervalMs / 1000)} 秒一次）`,
      support.ok
        ? `这是当前整屏画面（${frame.width}×${frame.height}，${Math.round(frame.bytes / 1024)} KB）。`
        : `画面无法交给模型：${support.reason}。这一次只有时间与元信息。`,
      freshLine,
      `请用不超过两句话记下此刻屏幕上值得学习的内容（在讲什么、进行到哪、有没有需要注意的点）。如果和上面的观察相比没有实质变化，只回复 ${NO_CHANGE}。`,
    ].join('\n')

    const blocks = [{ type: 'text', text }]
    for (const image of images) blocks.push({ type: 'image', attachment: image })
    const message = await makeUserMessage(blocks, { kind: 'schedule' })
    agent.followup(message)
    runtime.pendingObs = { at: Date.now() }
    runtime.lastCaptureAt = Date.now()
    runtime.lastInjectedSeq = runtime.changeSeq
    runtime.lastInjectedAt = Date.now()
    runtime.lastInjectedNoteSeq = runtime.noteSeq
    runtime.lastError = null
    bumpStats({
      ticks: 1,
      images: images.length,
      textChars: text.length,
      imageTokens: images.length && support.ok ? imageTokensFor(frame.width, frame.height) : 0,
    })
    return { ok: true, bytes: frame.bytes, images: images.length, support: support.ok }
  } catch (err) {
    runtime.lastError = String(err?.message ?? err)
    return { error: runtime.lastError }
  } finally {
    runtime.ticking = false
  }
}

/* ---------------------------------------------------------------- messages */

let llmModulePromise

function llmModule() {
  if (!llmModulePromise) {
    llmModulePromise = import('@deepseek-ai/dsh-llm').catch((err) => {
      console.warn(`[dsh-screen] 无法加载 @deepseek-ai/dsh-llm：${err?.message ?? err}`)
      return null
    })
  }
  return llmModulePromise
}

async function makeUserMessage(content, source) {
  const api = await llmModule()
  if (api?.createUserMessage) return api.createUserMessage({ content, source })
  return { role: 'user', content, source }
}

async function textOfStream(stream) {
  if (!stream) return ''
  const api = await llmModule()
  if (!api?.expandAssistantStream) return ''
  try {
    let out = ''
    for (const { chunk } of api.expandAssistantStream(stream)) {
      if (chunk?.type === 'text-delta') out += chunk.text
    }
    return out.trim()
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------- study mode */

export async function enableStudy(ctx, agent, intervalMs) {
  runtime.epoch += 1
  const rebind = Boolean(agent?.id) && runtime.sessionId !== agent.id
  runtime.enabled = true
  runtime.baseMs = clamp(intervalMs, AUTO_MIN_MS, AUTO_MAX_MS, runtime.baseMs)
  runtime.intervalMs = runtime.baseMs
  if (agent?.id) runtime.sessionId = agent.id
  runtime.noChangeStreak = 0
  if (rebind) {
    // 换了会话就换一份笔记：另一个对话的观察不该出现在这里。
    runtime.notes = []
    runtime.noteSeq = 0
    runtime.lastInjectedNoteSeq = 0
    runtime.pendingObs = null
  }
  await writePersisted()
  scheduleTimer(ctx)
  startSampler(ctx)
  return `${OBS_MARK} 学习模式已开启，每 ${Math.round(runtime.intervalMs / 1000)} 秒自动观察一次。`
}

export async function disableStudy(ctx) {
  runtime.epoch += 1
  runtime.enabled = false
  runtime.pendingObs = null
  await writePersisted()
  scheduleTimer(ctx)
  stopSampler()
  return '学习模式已关闭，不再自动抓取屏幕。'
}

/* ------------------------------------------------------------------ tools */


/* ------------------------------------------------------------------ voice */

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN_DIR = join(PLUGIN_ROOT, 'native', 'bin')
const VOICE_PROMPT = '以下是普通话的句子。'

function voiceRoot() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-screen')
}

function whisperBin() {
  return join(BIN_DIR, 'whisper-server')
}

function recBin() {
  return join(BIN_DIR, 'rec')
}

function modelPath() {
  return process.env.DSH_SCREEN_WHISPER_MODEL || join(voiceRoot(), 'models', VOICE_MODEL_FILE)
}

function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.end()
        resolve(true)
      })
      socket.on('error', () => {
        socket.destroy()
        if (Date.now() > deadline) resolve(false)
        else setTimeout(attempt, 250)
      })
      socket.setTimeout(1000, () => socket.destroy())
    }
    attempt()
  })
}

async function ensureModel() {
  const target = modelPath()
  if (existsSync(target)) return target
  const vendored = join(PLUGIN_ROOT, 'vendor', 'models', VOICE_MODEL_FILE)
  await mkdir(dirname(target), { recursive: true })
  if (existsSync(vendored)) {
    await copyFile(vendored, target)
    return target
  }
  if (runtime.voice.download?.child) return null
  const child = spawn('/usr/bin/curl', ['-L', '--retry', '2', '-o', `${target}.part`, VOICE_MODEL_URL], {
    stdio: 'ignore',
  })
  runtime.voice.download = { child, startedAt: Date.now(), url: VOICE_MODEL_URL }
  child.on('exit', (code) => {
    runtime.voice.download = null
    if (code === 0) {
      void import('node:fs/promises').then((fs) => fs.rename(`${target}.part`, target).catch(() => {}))
    } else {
      runtime.voice.lastError = `语音模型下载失败（curl 退出码 ${code}）`
    }
  })
  return null
}

/** 让 whisper-server 常驻：模型只加载一次，之后每次转写 0.1–1 秒。 */
async function ensureWhisper(ctx) {
  const voice = runtime.voice
  if (voice.server && voice.server.exitCode === null) return voice.server
  if (voice.preparing) return voice.preparing
  voice.preparing = (async () => {
    const model = await ensureModel()
    if (!model) return null
    if (!existsSync(whisperBin())) throw new Error(`找不到 ${whisperBin()}，请先运行 native/build.sh`)
    const port = 65100 + Math.floor(Math.random() * 300)
    const child = spawn(whisperBin(), ['-m', model, '--port', String(port), '--host', '127.0.0.1', '-l', 'zh', '-t', '4', '--prompt', VOICE_PROMPT], {
      stdio: 'ignore',
    })
    child.on('exit', () => {
      if (runtime.voice.server === child) {
        runtime.voice.server = null
        runtime.voice.port = 0
      }
    })
    voice.server = child
    voice.port = port
    voice.serverReady = false
    process.once('exit', () => {
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
    })
    const ok = await waitPort(port, 90_000)
    voice.serverReady = ok
    if (!ok) {
      child.kill()
      voice.server = null
      voice.port = 0
      throw new Error('whisper 模型加载超时（第一次加载要编译 Metal 内核，可能要 20–40 秒）')
    }
    return child
  })()
  try {
    return await voice.preparing
  } finally {
    runtime.voice.preparing = null
  }
}

export async function wavRms(wavPath) {
  const buf = await readFile(wavPath).catch(() => null)
  if (!buf || buf.length < 44) return 0
  let i = 12
  while (i + 8 <= buf.length) {
    const id = buf.toString('ascii', i, i + 4)
    const size = buf.readUInt32LE(i + 4)
    if (id === 'data') {
      const start = i + 8
      const end = Math.min(buf.length, start + size)
      let sum = 0
      let n = 0
      for (let p = start; p + 1 < end; p += 2) {
        const v = buf.readInt16LE(p)
        sum += v * v
        n += 1
      }
      return n ? Math.sqrt(sum / n) : 0
    }
    i += 8 + size + (size % 2)
  }
  return 0
}

export async function transcribe(wavPath) {
  const voice = runtime.voice
  if (!voice.port) throw new Error('语音服务还没就绪')
  const buf = await readFile(wavPath)
  if (buf.length < 8000) return ''
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'speech.wav')
  form.append('language', 'zh')
  form.append('prompt', VOICE_PROMPT)
  form.append('response_format', 'text')
  const res = await fetch(`http://127.0.0.1:${voice.port}/inference`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`转写失败：HTTP ${res.status}`)
  const text = (await res.text()).trim()
  return text.replace(/\[[^\]]*\]/g, '').trim()
}

function readSpoolFinal(spoolPath) {
  return readFile(spoolPath, 'utf8')
    .then((raw) =>
      raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean),
    )
    .catch(() => [])
}

export async function voiceStart(ctx, agent) {
  const voice = runtime.voice
  if (voice.recording) return { recording: true, startedAt: voice.startedAt }
  if (!existsSync(recBin())) throw new Error(`找不到录音器 ${recBin()}`)
  // 同时开始准备模型/服务，不阻塞录音
  void ensureWhisper(ctx).catch((err) => {
    voice.lastError = String(err?.message ?? err)
  })
  const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-'))
  voice.spool = join(dir, 'spool.jsonl')
  voice.wav = join(dir, 'speech.wav')
  voice.stopFile = join(dir, 'stop')
  const child = spawn(recBin(), ['--spool', voice.spool, '--out', voice.wav, '--stop-file', voice.stopFile, '--seconds', String(VOICE_MAX_SECONDS)], {
    stdio: 'ignore',
  })
  voice.child = child
  voice.recording = true
  voice.startedAt = Date.now()
  voice.lastError = null
  if (agent?.id) runtime.sessionId = agent.id
  child.on('exit', () => {
    voice.recording = false
  })
  return { recording: true, startedAt: voice.startedAt, preparing: !voice.port }
}

export async function voiceStop(ctx, agent) {
  const voice = runtime.voice
  if (!voice.recording || !voice.spool) return { text: '', reason: 'not-recording' }
  await writeFile(voice.stopFile, '1').catch(() => {})
  const child = voice.child
  if (child && child.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 6000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  voice.recording = false
  const events = await readSpoolFinal(voice.spool)
  const final = events.find((e) => e.type === 'final')
  const errorEvent = events.find((e) => e.type === 'error')
  if (errorEvent) {
    voice.lastError = errorEvent.message
    throw new Error(errorEvent.message)
  }
  if (!final || (final.seconds ?? 0) < 0.4) {
    voice.lastError = '没有录到声音'
    throw new Error('没有录到声音，检查麦克风权限或再说一次')
  }
  const rms = await wavRms(voice.wav)
  if (rms < 90) {
    voice.lastError = '几乎没有声音'
    throw new Error('几乎没有声音：麦克风没收到话音，检查输入设备或靠近一点再说')
  }
  await ensureWhisper(ctx)
  const text = await transcribe(voice.wav)
  voice.lastText = text
  if (text) bumpStats({ voiceTurns: 1, textChars: text.length })
  if (!text) {
    voice.lastError = '没有听清'
    return { text: '', seconds: final.seconds }
  }
  const target = agent ?? currentAgent(ctx)
  if (target) {
    const blocks = [{ type: 'text', text }]
    // 学习模式开着就顺手把当前画面带上，模型不用再问一次
    if (runtime.enabled && runtime.cache && Date.now() - runtime.cache.at < CACHE_FRESH_MS) {
      try {
        const ids = await saveFrames(ctx, [runtime.cache.frame])
        for (const image of ids) blocks.push({ type: 'image', attachment: image })
      } catch {
        /* 画面带不上就只发文字 */
      }
    }
    const message = await makeUserMessage(blocks)
    target.followup(message)
    voice.awaitingReply = true
  }
  await rm(dirname(voice.spool), { recursive: true, force: true }).catch(() => {})
  return { text, seconds: final.seconds }
}

function speakable(text) {
  return text
    .replace(/```[\s\S]*?```/g, '代码就不念了。')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[#*_>|-]{1,}/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export function speak(text) {
  if (!runtime.voice.tts) return
  const clean = speakable(text)
  if (!clean || NO_CHANGE_RE.test(clean)) return
  const short = clean.length > 420 ? `${clean.slice(0, 420)}…` : clean
  const child = spawn('/usr/bin/say', ['-r', '200', short], { stdio: 'ignore' })
  child.on('error', () => {})
  runtime.voice.speaking = child
}

/* ------------------------------------------------------------------ stats */

/**
 * 当日用量：自动观察次数、图片张数、估算 token。
 *
 * 目的不是精确计费，是让你自己判断「开着学习模式值不值」。
 * token 是估算：图片按 宽×高/800，文字按 字符数/1.6（中文大约 1 字 1 token，混排折中）。
 */
const STATS_KEEP_DAYS = 14
const IMAGE_TOKEN_DIVISOR = 800
const TEXT_CHARS_PER_TOKEN = 1.6

function dayKeyOf(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function statsPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-screen-stats.json')
}

function emptyDay() {
  return { ticks: 0, images: 0, imageTokens: 0, textChars: 0, onDemand: 0, cameraShots: 0, cameraFrames: 0, voiceTurns: 0 }
}

function todayStats() {
  const key = dayKeyOf()
  if (!runtime.stats.days[key]) runtime.stats.days[key] = emptyDay()
  return runtime.stats.days[key]
}

let statsSaveTimer = null

function scheduleStatsSave() {
  if (statsSaveTimer) return
  statsSaveTimer = setTimeout(() => {
    statsSaveTimer = null
    void saveStats()
  }, 2000)
  statsSaveTimer.unref?.()
}

async function saveStats() {
  const days = Object.keys(runtime.stats.days).sort().slice(-STATS_KEEP_DAYS)
  const trimmed = {}
  for (const key of days) trimmed[key] = runtime.stats.days[key]
  runtime.stats.days = trimmed
  try {
    await writeFile(statsPath(), `${JSON.stringify({ days: trimmed }, null, 2)}\n`, 'utf8')
  } catch {
    /* 统计写不进去不该影响主功能 */
  }
}

async function loadStats() {
  try {
    const parsed = JSON.parse(await readFile(statsPath(), 'utf8'))
    if (parsed?.days && typeof parsed.days === 'object') {
      runtime.stats.days = parsed.days
    }
  } catch {
    /* 第一次运行没有文件 */
  }
}

function imageTokensFor(width, height) {
  return Math.round((Number(width) * Number(height)) / IMAGE_TOKEN_DIVISOR)
}

function bumpStats(patch) {
  const today = todayStats()
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    today[key] = (today[key] ?? 0) + value
  }
  scheduleStatsSave()
}

function statsTokens(day) {
  return (day.imageTokens ?? 0) + Math.round((day.textChars ?? 0) / TEXT_CHARS_PER_TOKEN)
}

export function statsSummary() {
  const key = dayKeyOf()
  const today = runtime.stats.days[key] ?? emptyDay()
  const days = Object.keys(runtime.stats.days)
    .sort()
    .map((day) => ({ day, ...runtime.stats.days[day], tokens: statsTokens(runtime.stats.days[day]) }))
  return { day: key, today: { ...today, tokens: statsTokens(today) }, days }
}

function statsLines() {
  const summary = statsSummary()
  const today = summary.today
  const lines = [
    `今日（${summary.day}）：自动观察 ${today.ticks} 次 · 图片 ${today.images} 张（按需 ${today.onDemand} 张）· ≈${Math.round(today.tokens / 100) / 10}k token`,
  ]
  if (today.cameraShots) lines.push(`       摄像头 ${today.cameraShots} 次 / ${today.cameraFrames} 帧 · 语音 ${today.voiceTurns} 次`)
  const recent = summary.days.slice(-7, -1)
  if (recent.length) {
    lines.push(`最近 ${recent.length} 天：${recent.map((day) => `${day.day.slice(5)} ${Math.round(day.tokens / 100) / 10}k`).join(' · ')}`)
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ camera */

const CAM_BIN = join(BIN_DIR, 'cam')
const CAM_FAKE = process.env.DSH_SCREEN_FAKE_CAMERA === '1'
const CAM_MAX_FRAMES = 8
const CAM_MAX_SECONDS = 10
const CAM_MIN_INTERVAL_MS = 200
const CAM_DEFAULT_SCALE = 960

function parseJsonl(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      /* 半行或被截断的行直接跳过 */
    }
  }
  return out
}

function cameraHint(message, stderr) {
  const text = `${message ?? ''} ${stderr ?? ''}`
  if (/权限|denied|authorized/i.test(text)) {
    return '摄像头权限被拒绝：到 系统设置 → 隐私与安全性 → 摄像头 里允许当前应用后重试。'
  }
  if (/没有找到摄像头/.test(text)) return '没有找到摄像头：检查盖子是否合上、外接摄像头是否被别的应用占用。'
  if (/超时/.test(text)) return '没拿到画面：相机可能被别的应用占用（视频会议、拍照应用），关掉后再试。'
  return undefined
}

async function fakeCameraFrames(count) {
  const data = await readFile(join(PLUGIN_ROOT, 'test', 'fixtures', 'camera.jpg')).catch(() =>
    readFile(join(PLUGIN_ROOT, 'test', 'fixtures', 'frame.jpg')),
  )
  const list = []
  for (let i = 0; i < count; i += 1) {
    list.push({
      data,
      width: 480,
      height: 312,
      diff: i === 0 ? 0 : i * 3.5,
      at: Date.now() + i * 400,
      bytes: data.length,
    })
  }
  return list
}

/**
 * 用摄像头连续取帧。
 *
 * frames 越多，越能看出动作；但每一帧都是要花钱的图片，默认只取 1 帧，
 * 连续观察由 camera_watch 显式要求。
 */
export async function captureCamera({ frames = 1, intervalMs = 400, size = CAM_DEFAULT_SCALE, device, warmMs = 500 } = {}) {
  const count = clamp(frames, 1, CAM_MAX_FRAMES, 1)
  const gap = clamp(intervalMs, CAM_MIN_INTERVAL_MS, 5000, 400)
  const width = clamp(size, 480, 1920, CAM_DEFAULT_SCALE)
  if (CAM_FAKE) return fakeCameraFrames(count)
  if (!existsSync(CAM_BIN)) throw new Error(`摄像头工具不存在：${CAM_BIN}（在插件目录执行 native/build.sh）`)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-screen-cam-'))
  const args = ['--frames', String(count), '--interval-ms', String(gap), '--out-dir', dir, '--size', String(width), '--warm', String(warmMs)]
  if (device) args.push('--device', String(device))
  try {
    const result = await runCapture(CAM_BIN, args, { timeoutMs: warmMs + count * gap + 20_000 })
    const events = parseJsonl(result.stdout)
    const failure = events.find((event) => event.type === 'error')
    if (failure) throw new Error(cameraHint(failure.message, result.stderr) ?? failure.message)
    const shots = events.filter((event) => event.type === 'frame')
    if (!shots.length) throw new Error(cameraHint(result.stderr, result.stderr) ?? '没有拿到摄像头画面')
    const out = []
    for (const shot of shots) {
      const data = await readFile(shot.path)
      out.push({ data, width: shot.w, height: shot.h, diff: shot.diff ?? 0, at: shot.at ?? Date.now(), bytes: data.length })
    }
    return out
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 从连续帧里挑「最值得看」的几帧：首帧、末帧、变化最大的，避免把 8 张几乎一样的图塞给模型。 */
function pickInteresting(frames, limit = 5) {
  if (frames.length <= limit) return frames.slice()
  const byDiff = frames
    .map((frame, index) => ({ frame, index }))
    .sort((a, b) => Math.abs(b.frame.diff) - Math.abs(a.frame.diff))
  const keep = new Set([0, frames.length - 1])
  for (const item of byDiff) {
    if (keep.size >= limit) break
    keep.add(item.index)
  }
  return [...keep].sort((a, b) => a - b).map((index) => frames[index])
}

export async function cameraDoctor() {
  const lines = []
  if (CAM_FAKE) {
    lines.push('摄像头：测试模式（DSH_SCREEN_FAKE_CAMERA=1），用的是固定帧')
    return lines.join('\n')
  }
  if (!existsSync(CAM_BIN)) {
    lines.push(`❌ 摄像头工具不存在：${CAM_BIN}`)
    lines.push('   在插件目录执行 native/build.sh 重新构建。')
    return lines.join('\n')
  }
  const listed = await runCapture(CAM_BIN, ['--list'], { timeoutMs: 8000 })
  const devices = parseJsonl(listed.stdout).find((event) => event.type === 'devices')?.devices ?? []
  if (!devices.length) {
    lines.push('❌ 没有找到摄像头')
  } else {
    lines.push(`✅ 摄像头 ${devices.length} 个`)
    for (const device of devices) lines.push(`   · ${device.name}（${device.id}）`)
  }
  try {
    const frames = await captureCamera({ frames: 1, warmMs: 600 })
    const frame = frames[0]
    lines.push(`✅ 拍到一帧：${frame.width}×${frame.height}，${Math.round(frame.bytes / 1024)} KB`)
    lines.push('   下一步：让模型看一眼并说出画面内容，就知道整条链路通了。')
  } catch (err) {
    lines.push(`❌ 拍摄失败：${err?.message ?? err}`)
  }
  return lines.join('\n')
}

function cameraShotTool(ctx) {
  return {
    name: 'camera_shot',
    description:
      '用摄像头拍一张照片，把图片作为工具结果交给自己看。用户说「看看这个 / 这道题 / 我手上拿着什么 / 摄像头看一下」时使用。',
    parameters: {
      type: 'object',
      properties: {
        device: { type: 'string', description: '摄像头唯一 ID，不传就用第一个' },
        scale: { type: 'integer', description: '目标宽度像素，480 到 1920，默认 960' },
      },
      additionalProperties: false,
    },
    timeoutMs: 30_000,
    output: {
      schema: {
        type: 'object',
        properties: { imageStatus: { type: 'string' }, meta: { type: 'string' } },
        required: ['imageStatus'],
      },
      render(_args, value) {
        return renderValue(value)
      },
    },
    async execute(args, exec) {
      const support = await canSeeImages(ctx, exec?.agent, exec?.signal)
      const frames = await captureCamera({ frames: 1, size: args?.scale ?? CAM_DEFAULT_SCALE, device: args?.device })
      const frame = frames[frames.length - 1]
      const kb = Math.round(frame.bytes / 1024)
      if (!support.ok) {
        return {
          images: [],
          imageStatus: `已拍摄（${frame.width}×${frame.height}，${kb} KB），但没有把画面交给你：${support.reason}。`,
          meta: '如果需要你能看图，请切换到支持图片输入的模型后重试。',
        }
      }
      const images = await saveFrames(ctx, [frame])
      bumpStats({ cameraShots: 1, cameraFrames: 1, onDemand: 1, images: 1, imageTokens: imageTokensFor(frame.width, frame.height) })
      return {
        images,
        imageStatus: `已提供 1 张摄像头画面（${frame.width}×${frame.height}，${kb} KB）。`,
        meta: `拍摄时间 ${new Date().toISOString()}`,
      }
    },
  }
}

function cameraWatchTool(ctx) {
  return {
    name: 'camera_watch',
    description:
      '用摄像头连续拍几帧，用来看「在做什么动作 / 东西怎么动 / 翻到哪一页」。用户说「看着我 / 连续看 / 我做个动作」时使用。只挑变化最大的几帧交给你。',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'integer', description: `拍多久，1 到 ${CAM_MAX_SECONDS} 秒，默认 3` },
        intervalMs: { type: 'integer', description: '间隔毫秒，200 到 5000，默认 400' },
        device: { type: 'string', description: '摄像头唯一 ID，不传就用第一个' },
        scale: { type: 'integer', description: '目标宽度像素，480 到 1920，默认 960' },
      },
      additionalProperties: false,
    },
    timeoutMs: 60_000,
    output: {
      schema: {
        type: 'object',
        properties: { imageStatus: { type: 'string' }, meta: { type: 'string' } },
        required: ['imageStatus'],
      },
      render(_args, value) {
        return renderValue(value)
      },
    },
    async execute(args, exec) {
      const support = await canSeeImages(ctx, exec?.agent, exec?.signal)
      const seconds = clamp(args?.seconds ?? 3, 1, CAM_MAX_SECONDS, 3)
      const gap = clamp(args?.intervalMs ?? 400, CAM_MIN_INTERVAL_MS, 5000, 400)
      const wanted = clamp(Math.round((seconds * 1000) / gap) + 1, 2, CAM_MAX_FRAMES, 3)
      const frames = await captureCamera({ frames: wanted, intervalMs: gap, size: args?.scale ?? CAM_DEFAULT_SCALE, device: args?.device })
      const picked = pickInteresting(frames, 5)
      const timeline = frames
        .map((frame, index) => `#${index + 1} ${Math.round(frame.diff)}`)
        .join(' · ')
      const kb = Math.round(picked.reduce((sum, frame) => sum + frame.bytes, 0) / 1024)
      const summary = `拍 ${frames.length} 帧，挑了 ${picked.length} 帧（${kb} KB），帧间变化：${timeline}`
      if (!support.ok) {
        return { images: [], imageStatus: `${summary}。但没有把画面交给你：${support.reason}。`, meta: '请切换到支持图片输入的模型后重试。' }
      }
      const images = await saveFrames(ctx, picked)
      bumpStats({
        cameraShots: 1,
        cameraFrames: frames.length,
        onDemand: 1,
        images: picked.length,
        imageTokens: picked.reduce((sum, frame) => sum + imageTokensFor(frame.width, frame.height), 0),
      })
      return {
        images,
        imageStatus: `已提供 ${picked.length} 张摄像头画面。${summary}`,
        meta: '变化值越大说明动作越剧烈；如果都在 0 附近，说明画面基本静止。',
      }
    },
  }
}

function cameraCommand(ctx) {
  return {
    name: 'camera',
    description: '用摄像头看一眼当前的东西：/camera 拍一张，/camera doctor 检查设备与权限',
    recordInput: false,
    async handler(invocation) {
      const input = String(invocation?.rawInput ?? '').trim()
      if (input === 'doctor') return { kind: 'success', text: await cameraDoctor() }
      const agent = invocation?.agent ?? currentAgent(ctx, { allowFallback: true })
      if (!agent?.id) return { kind: 'error', text: '没有可以接收画面的会话：先在一个对话里发条消息，再执行 /camera。' }
      let frame
      try {
        const frames = await captureCamera({ frames: 1 })
        frame = frames[frames.length - 1]
      } catch (err) {
        return { kind: 'error', text: `拍照失败：${err?.message ?? err}` }
      }
      const kb = Math.round(frame.bytes / 1024)
      const blocks = [{ type: 'text', text: `【摄像头】${nowIso()} 用户用摄像头拍了一张照片（${frame.width}×${frame.height}，${kb} KB）。` }]
      const support = await canSeeImages(ctx, agent)
      if (!support.ok) {
        blocks.push({ type: 'text', text: `画面无法交给模型：${support.reason}` })
      } else {
        try {
          for (const image of await saveFrames(ctx, [frame])) blocks.push({ type: 'image', attachment: image })
        } catch (err) {
          blocks.push({ type: 'text', text: `画面保存失败：${err?.message ?? err}` })
        }
      }
      agent.followup(await makeUserMessage(blocks))
      return { kind: 'success', text: `已拍摄一张照片（${frame.width}×${frame.height}，${kb} KB）并发给当前对话。` }
    },
  }
}

function screenShotTool(ctx) {
  return {
    name: 'screen_shot',
    description:
      '抓取一次整屏画面，把图片作为工具结果交给自己看。用户说“看我屏幕 / 看这个 / 现在是什么”时使用。',
    parameters: {
      type: 'object',
      properties: {
        display: { type: 'integer', description: '显示器序号，默认主屏' },
        scale: { type: 'integer', description: '目标宽度像素，480 到 2560，默认 1280' },
      },
      additionalProperties: false,
    },
    timeoutMs: 20_000,
    output: {
      schema: {
        type: 'object',
        properties: { imageStatus: { type: 'string' }, meta: { type: 'string' } },
        required: ['imageStatus'],
      },
      render(_args, value) {
        return renderValue(value)
      },
    },
    async execute(args, exec) {
      const signal = exec?.signal
      const support = await canSeeImages(ctx, exec?.agent, signal)
      // 正在持续观察时直接用缓存帧，几乎零延迟；缓存过期或按需模式才真抓一次。
      const cache = runtime.cache
      const useCache = runtime.enabled && !args?.display && !args?.scale && cache && Date.now() - cache.at < CACHE_FRESH_MS
      const frame = useCache ? cache.frame : await captureFrame({ display: args?.display, scale: args?.scale, signal })
      const ageMs = useCache ? Date.now() - cache.at : 0
      if (!support.ok) {
        return {
          images: [],
          imageStatus: `已抓取整屏（${frame.width}×${frame.height}，${Math.round(frame.bytes / 1024)} KB），但没有把画面交给你：${support.reason}。`,
          meta: '如果需要你能看图，请切换到支持图片输入的模型后重试。',
        }
      }
      const images = await saveFrames(ctx, [frame])
      const at = Date.now()
      runtime.lastCaptureAt = at
      bumpStats({ images: 1, onDemand: 1, imageTokens: imageTokensFor(frame.width, frame.height) })
      return {
        images,
        imageStatus: useCache
          ? `已提供 1 张整屏画面（${frame.width}×${frame.height}，${Math.round(ageMs / 100) / 10} 秒前的缓存帧，持续观察中）。`
          : `已提供 1 张整屏画面（${frame.width}×${frame.height}，${Math.round(frame.bytes / 1024)} KB）。`,
        meta: useCache ? '缓存帧：画面每 1.2 秒刷新一次，必要时可用 screen_shot 再看。' : `抓取时间 ${new Date(at).toISOString()}`,
      }
    },
  }
}

function screenWatchTool(ctx) {
  return {
    name: 'screen_watch',
    description:
      '连续抓取若干帧整屏画面并交给自己看，用于观察一段正在变化的操作。必须先在设置里或通过 /study on、开关按钮开启屏幕观察。',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'integer', description: '观察时长（秒），1 到 15，默认 3' },
        intervalMs: { type: 'integer', description: '帧间隔毫秒，400 到 5000，默认 1000' },
        display: { type: 'integer', description: '显示器序号，默认主屏' },
        scale: { type: 'integer', description: '目标宽度像素，480 到 2560，默认 960' },
      },
      additionalProperties: false,
    },
    timeoutMs: 40_000,
    output: {
      schema: {
        type: 'object',
        properties: { imageStatus: { type: 'string' }, meta: { type: 'string' } },
        required: ['imageStatus'],
      },
      render(_args, value) {
        return renderValue(value)
      },
    },
    async execute(args, exec) {
      if (!runtime.enabled) {
        throw new Error(
          '屏幕观察没有开启。连续观看必须由用户明确开启：输入 /study on，或者点击输入框下方的「学习模式」按钮。',
        )
      }
      const signal = exec?.signal
      const seconds = clamp(args?.seconds, 1, MAX_SECONDS, 3)
      const intervalMs = clamp(args?.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS, 1000)
      const scale = clamp(args?.scale, MIN_SCALE, MAX_SCALE, 960)
      const planned = Math.min(MAX_FRAMES, Math.max(1, Math.floor((seconds * 1000) / intervalMs) + 1))
      const support = await canSeeImages(ctx, exec?.agent, signal)
      const frames = []
      for (let i = 0; i < planned; i += 1) {
        frames.push(await captureFrame({ display: args?.display, scale, signal }))
        if (i < planned - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
      const span = frames.length > 1 ? (frames.length - 1) * intervalMs : 0
      if (!support.ok) {
        return {
          images: [],
          imageStatus: `已抓取 ${frames.length} 帧（跨约 ${Math.round(span / 100) / 10} 秒），但没有交给你：${support.reason}。`,
          meta: '切换到支持图片输入的模型后可以再看一次。',
        }
      }
      const images = await saveFrames(ctx, frames)
      return {
        images,
        imageStatus: `已提供 ${images.length} 张整屏画面，跨约 ${Math.round(span / 100) / 10} 秒，间隔 ${intervalMs} ms。`,
        meta: '按时间顺序排列，第一张最早。',
      }
    },
  }
}

function screenStatusTool(ctx) {
  return {
    name: 'screen_status',
    description: '查看屏幕观察的开关状态、自动观察节奏和最近的观察记录数量。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 5_000,
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value ?? '') }]
      },
    },
    async execute() {
      pruneNotes()
      const lines = [
        `学习模式：${runtime.enabled ? '已开启' : '未开启'}`,
        `自动观察间隔：${Math.round(runtime.intervalMs / 1000)} 秒`,
        `绑定会话：${runtime.sessionId ?? '（无，先 /study on）'}`,
        `最近窗口内观察条数：${runtime.notes.length}`,
        `上次抓取：${runtime.lastCaptureAt ? new Date(runtime.lastCaptureAt).toISOString() : '从未'}`,
      ]
      if (runtime.lastError) lines.push(`最近错误：${runtime.lastError}`)
      return lines.join('\n')
    },
  }
}

function studyNotesTool(ctx) {
  return {
    name: 'study_notes',
    description: '读取最近 10 分钟的屏幕观察笔记。当上下文变长、你忘了刚才屏幕上出现过什么时使用。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '最多返回多少条，1 到 40' } },
      additionalProperties: false,
    },
    timeoutMs: 5_000,
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value ?? '') }]
      },
    },
    async execute(args) {
      pruneNotes()
      const limit = clamp(args?.limit, 1, NOTES_MAX_ITEMS, NOTES_MAX_ITEMS)
      const notes = runtime.notes.slice(-limit)
      if (!notes.length) return '最近 10 分钟没有观察记录。'
      return notes.map((note) => `- ${hhmm(note.t)} ${note.text}`).join('\n')
    },
  }
}

/* --------------------------------------------------------------- commands */

async function studyDoctor(ctx, agent) {
  const lines = []
  const live = agent ?? currentAgent(ctx, { allowFallback: true })
  let frame
  try {
    frame = await captureFrame({ scale: DEFAULT_SCALE })
    lines.push(`✅ 抓屏：${frame.width}×${frame.height}，${Math.round(frame.bytes / 1024)} KB`)
  } catch (err) {
    lines.push(`❌ 抓屏失败：${err?.message ?? err}`)
  }
  if (!live) {
    lines.push('❌ 没有可用的会话：请在一个对话里执行 /study doctor。')
    if (!frame) {
      lines.push('   抓屏本身也失败了，先在 系统设置 → 隐私与安全性 → 屏幕与系统录制 里给 DeepSeek Harness 打开权限。')
    }
    return lines.join('\n')
  }
  const support = await canSeeImages(ctx, live, undefined)
  const provider = live.options?.provider ?? '当前'
  const model = live.options?.model ?? '模型'
  lines.push(
    support.ok
      ? `✅ ${provider}/${model} 支持图片输入`
      : `❌ ${provider}/${model} 不支持图片输入：${support.reason}。学习模式只能拿到文字元信息。`,
  )
  if (!frame) {
    lines.push('   抓屏失败时无法做「发一帧给模型」这一步。')
    return lines.join('\n')
  }
  if (!support.ok) return lines.join('\n')
  try {
    const [image] = await saveFrames(ctx, [frame])
    const text = [
      `【自检】${nowIso()} 用户刚刚运行了 /study doctor。`,
      '下面这张图是刚刚抓到的整屏画面。请只用一句话描述你实际看到的内容（比如打开了哪些窗口、页面上有什么字），不要评价、不要猜测看不到的部分。',
      '如果画面里只有桌面壁纸、没有任何窗口内容，请直接说「只看到壁纸」。',
    ].join('\n')
    live.followup(await makeUserMessage([{ type: 'text', text }, { type: 'image', attachment: image }], { kind: 'schedule' }))
    lines.push('✅ 已把这一帧发给模型，看它接下来那句话：')
    lines.push('   · 说得出你屏幕上的窗口 → 抓屏和图片链路都通了。')
    lines.push('   · 只说「只看到壁纸」或「只有桌面」 → 屏幕录制权限没给到这个应用。')
  } catch (err) {
    lines.push(`❌ 发送失败：${err?.message ?? err}`)
  }
  return lines.join('\n')
}

async function voiceDoctor(ctx) {
  const lines = []
  const rec = recBin()
  const bin = whisperBin()
  lines.push(existsSync(rec) ? `✅ 录音器：${rec}` : `❌ 缺少录音器：${rec}（重新安装，或运行 ./native/build.sh）`)
  lines.push(existsSync(bin) ? `✅ 转写引擎：${bin}` : `❌ 缺少转写引擎：${bin}（运行 ./native/build.sh）`)
  const model = modelPath()
  lines.push(
    existsSync(model)
      ? `✅ 模型：${model}`
      : `⚠️ 模型未下载：${model}（第一次录音时会自动下载约 141 MB，网络不好会卡住）`,
  )
  lines.push(`语音服务：${runtime.voice.serverReady ? '就绪' : '未启动（第一次录音时预热 20–40 秒）'}`)

  const vol = await runCapture('/usr/bin/osascript', ['-e', 'input volume of (get volume settings)'], { timeoutMs: 4000 })
  const volume = vol.ok ? vol.stdout.trim() : ''
  if (volume) {
    lines.push(`系统输入音量：${volume}/100${Number(volume) > 0 && Number(volume) < 40 ? '（偏低，建议调到 70 以上）' : ''}`)
  }

  const prof = await runCapture('/usr/bin/system_profiler', ['SPAudioDataType', '-json'], { timeoutMs: 12000 })
  const inputName = defaultInputName(prof.stdout)
  if (inputName) lines.push(`默认输入设备：${inputName}`)

  if (!existsSync(rec)) return lines.join('\n')

  const dir = await mkdtemp(join(tmpdir(), 'dsh-screen-doctor-'))
  const wav = join(dir, 'probe.wav')
  try {
    lines.push('正在录 1 秒做电平测试（刚才那句话如果没赶上，可以再跑一次）。')
    const probe = await runCapture(
      rec,
      ['--spool', join(dir, 'probe.jsonl'), '--out', wav, '--seconds', '1'],
      { timeoutMs: 6000 },
    )
    if (!probe.ok) {
      lines.push(`❌ 录音没完成：${probe.stderr.trim() || '超时'}`)
      lines.push('   → 多半是 macOS 正在等麦克风授权弹窗，或者这个进程没有麦克风权限。')
      lines.push('   → 到 系统设置 → 隐私与安全性 → 麦克风 给 DeepSeek Harness 打勾，然后重启应用。')
      return lines.join('\n')
    }
    const rms = await wavRms(wav)
    if (rms < 90) {
      lines.push(`⚠️ 几乎没有声音（RMS ${rms}，环境噪声通常 1–20，人声通常上千）`)
      lines.push('   → 检查系统输入音量、默认输入设备是否选错，以及麦克风权限。')
      return lines.join('\n')
    }
    lines.push(`✅ 录到声音（RMS ${rms}）`)
    try {
      await ensureWhisper(ctx)
      const text = await transcribe(wav)
      lines.push(text ? `✅ 转写结果：${text}` : '⚠️ 有声音但没转出文字（可以再说清楚一点）')
    } catch (err) {
      lines.push(`❌ 转写失败：${err?.message ?? err}`)
    }
    return lines.join('\n')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function defaultInputName(json) {
  try {
    const parsed = JSON.parse(json)
    const items = parsed?.SPAudioDataType ?? []
    const flat = []
    for (const item of items) {
      if (Array.isArray(item?._items)) flat.push(...item._items)
      else flat.push(item)
    }
    const input = flat.find((item) => String(item?.coreaudio_default_audio_input_device ?? '') === 'spaudio_yes')
    return input?._name ? String(input._name) : ''
  } catch {
    return ''
  }
}

function voiceCommand(ctx) {
  return {
    name: 'voice',
    description: '语音：on 开始录音（再说一次 /voice on 结束并发送），off 取消，tts on|off 控制朗读，status 看状态，doctor 自检麦克风与转写',
    recordInput: false,
    async handler(invocation) {
      const { agent } = invocation
      const raw = String(invocation.rawInput ?? '').trim()
      const head = raw.split(/\s+/)[0].toLowerCase()
      const rest = raw.split(/\s+/).slice(1).join(' ').toLowerCase()
      if (!head || head === 'status') {
        const st = voiceState()
        return {
          kind: 'success',
          text: [
            `录音：${st.recording ? `进行中 ${st.seconds}s` : '未在录'}`,
            `语音服务：${st.ready ? '就绪' : st.preparing ? '准备中（首次要 20–40 秒）' : '未启动'}`,
            `朗读回复：${st.tts ? '开' : '关'}`,
            st.lastError ? `上次错误：${st.lastError}` : null,
            '用法：/voice on | off | tts on | tts off | status | doctor',
          ]
            .filter(Boolean)
            .join('\n'),
        }
      }
      if (head === 'on') {
        if (runtime.voice.recording) {
          const result = await voiceStop(ctx, agent)
          return result.text
            ? { kind: 'success', text: `已发送：${result.text}` }
            : { kind: 'error', text: '没听清，再试一次。' }
        }
        await voiceStart(ctx, agent)
        return { kind: 'success', text: '开始录音，说完再输入一次 /voice on 结束并发送。' }
      }
      if (head === 'off') {
        if (runtime.voice.recording) {
          runtime.voice.recording = false
          runtime.voice.child?.kill?.()
        }
        return { kind: 'success', text: '已取消录音。' }
      }
      if (head === 'tts') {
        if (!rest) return { kind: 'error', text: '用法：/voice tts on | off' }
        const on = rest === 'on' || rest === 'true' || rest === '1'
        runtime.voice.tts = on
        return { kind: 'success', text: `朗读回复：${on ? '开' : '关'}` }
      }
      if (head === 'doctor') {
        return { kind: 'success', text: await voiceDoctor(ctx) }
      }
      return { kind: 'error', text: `不认识的用法：${raw}。可用：/voice on | off | tts on | tts off | status | doctor` }
    },
  }
}

function studyCommand(ctx) {
  return {
    name: 'study',
    description: '学习模式：on 开始自动观察屏幕，off 停止，notes 看笔记，status 看状态，stats 看今日用量，doctor 自检（抓屏+模型+真发一帧）',
    recordInput: false,
    async handler(invocation) {
      const { agent } = invocation
      const raw = String(invocation.rawInput ?? '').trim()
      const head = raw.split(/\s+/)[0].toLowerCase()
      if (!head || head === 'status') {
        pruneNotes()
        const live = runtime.sessionId ? sessionLive(ctx, runtime.sessionId) : false
        return {
          kind: 'success',
          text: [
            `学习模式：${runtime.enabled ? '已开启' : '未开启'}`,
            `自动观察间隔：${Math.round(runtime.intervalMs / 1000)} 秒`,
            `绑定的会话：${runtime.sessionId ? `${String(runtime.sessionId).slice(0, 8)}…${live ? '（在线）' : '（已失效，注入会跳过）'}` : '未绑定'}`,
            `最近 10 分钟观察：${runtime.notes.length} 条`,
            statsLines(),
            '用法：/study on | off | notes | status | stats | doctor',
          ].join('\n'),
        }
      }
      if (head === 'on') {
        const text = await enableStudy(ctx, agent)
        return { kind: 'success', text }
      }
      if (head === 'off') {
        return { kind: 'success', text: await disableStudy(ctx) }
      }
      if (head === 'notes') {
        const body = digest()
        return { kind: 'success', text: body ? `最近 10 分钟的观察：\n${body}` : '最近 10 分钟没有观察记录。' }
      }
      if (head === 'stats') {
        return { kind: 'success', text: statsLines() }
      }
      if (head === 'doctor') {
        return { kind: 'success', text: await studyDoctor(ctx, agent) }
      }
      return { kind: 'error', text: `不认识的用法：${raw}。可用：/study on | off | notes | status | stats | doctor` }
    },
  }
}

/* -------------------------------------------------------------------- API */

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0
    const parts = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function sessionLive(ctx, id) {
  if (!id) return false
  const agents = optionalService(ctx, 'agents')
  try {
    return Boolean(agents?.get?.(id))
  } catch {
    return false
  }
}

function currentState(ctx) {
  const stats = statsSummary().today
  pruneNotes()
  return {
    enabled: runtime.enabled,
    intervalMs: runtime.intervalMs,
    notes: runtime.notes.length,
    lastCaptureAt: runtime.lastCaptureAt,
    sessionBound: Boolean(runtime.sessionId),
    boundSession: runtime.sessionId ? String(runtime.sessionId) : null,
    sessionLive: ctx ? sessionLive(ctx, runtime.sessionId) : undefined,
    lastError: runtime.lastError,
    watching: Boolean(runtime.sampler),
    freshMs: runtime.cache ? Date.now() - runtime.cache.at : null,
    changes: runtime.changes,
    commands: [...runtime.registeredCommands],
    stats,
  }
}

function voiceState() {
  const v = runtime.voice
  return {
    recording: v.recording,
    seconds: v.recording ? Math.round((Date.now() - v.startedAt) / 100) / 10 : 0,
    preparing: !v.serverReady && !!v.preparing,
    ready: !!v.serverReady,
    downloading: !!v.download,
    tts: v.tts,
    lastText: v.lastText,
    lastError: v.lastError,
  }
}

async function handleApi(ctx, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== API_PATH && !url.pathname.startsWith(`${API_PATH}/`)) {
    sendJson(res, 404, { error: '未知路径' })
    return
  }
  const rest = url.pathname.slice(API_PATH.length) || '/'
  const method = (req.method ?? 'GET').toUpperCase()

  if (rest === '/' || rest === '/state' || rest === '/voice/state') {
    if (method === 'GET' || method === 'HEAD') {
      sendJson(res, 200, rest === '/voice/state' ? voiceState() : { ...currentState(ctx), voice: voiceState() })
      return
    }
    if (rest === '/voice/state') {
      sendJson(res, 405, { error: '只支持 GET 和 POST' })
      return
    }
    if (method !== 'POST') {
      sendJson(res, 405, { error: '只支持 GET 和 POST' })
      return
    }
    const payload = await readJson(req, res)
    if (payload === undefined) return
    if (typeof payload.enabled !== 'boolean') {
      sendJson(res, 400, { error: 'enabled 必须是布尔值' })
      return
    }
    if (typeof payload.sessionId === 'string' && payload.sessionId) runtime.sessionId = payload.sessionId
    if (payload.enabled) {
      const target = payload.sessionId ? currentAgent(ctx, { allowFallback: true }) : undefined
      await enableStudy(ctx, target, payload.intervalMs)
    } else await disableStudy(ctx)
    sendJson(res, 200, currentState(ctx))
    return
  }

  if (rest === '/voice/start' || rest === '/voice/stop' || rest === '/voice/tts') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: '只支持 POST' })
      return
    }
    const payload = await readJson(req, res)
    if (payload === undefined) return
    try {
      if (rest === '/voice/tts') {
        if (typeof payload.enabled !== 'boolean') {
          sendJson(res, 400, { error: 'enabled 必须是布尔值' })
          return
        }
        runtime.voice.tts = payload.enabled
        sendJson(res, 200, voiceState())
        return
      }
      if (rest === '/voice/start') {
        const agent = currentAgent(ctx, { allowFallback: true })
        const result = await voiceStart(ctx, agent)
        sendJson(res, 200, { ...voiceState(), preparing: result.preparing ?? false })
        return
      }
      const agent = currentAgent(ctx, { allowFallback: true })
      const result = await voiceStop(ctx, agent)
      if (!result.text) {
        sendJson(res, 200, { ...voiceState(), text: '', reason: result.reason ?? 'empty' })
        return
      }
      sendJson(res, 200, { ...voiceState(), text: result.text })
      return
    } catch (err) {
      sendJson(res, 500, { ...voiceState(), error: String(err?.message ?? err) })
      return
    }
  }

  sendJson(res, 404, { error: '未知路径' })
}

async function readJson(req, res) {
  const contentType = String(req.headers['content-type'] ?? '')
  if (!contentType.toLowerCase().includes('application/json')) {
    sendJson(res, 415, { error: '需要 application/json' })
    return undefined
  }
  try {
    return JSON.parse((await readBody(req)) || '{}')
  } catch (err) {
    sendJson(res, 400, { error: `请求体不是合法 JSON：${err?.message ?? err}` })
    return undefined
  }
}

/* ------------------------------------------------------------------ model */

function noteFromAssistant(text) {
  runtime.pendingObs = null
  if (!text) return
  if (NO_CHANGE_RE.test(text)) {
    slowDown()
    return
  }
  runtime.noChangeStreak = 0
  addNote(text)
}

/**
 * 有些服务（webServer、commands、systemPrompt）在别的 bundle 里提供，插件激活时可能还没就绪。
 * 用 ctx.inject 等它们出现再挂载；服务消失时 cordis 会自己调用清理函数。
 */
function whenService(ctx, deps, setup) {
  try {
    return ctx.inject(deps, (inner) => {
      let dispose
      try {
        dispose = setup(inner)
      } catch (err) {
        console.warn(`[dsh-screen] ${deps.join(',')} 初始化失败：${err?.message ?? err}`)
        return
      }
      if (typeof dispose === 'function') inner.effect(() => dispose)
    })
  } catch (err) {
    console.warn(`[dsh-screen] 无法注入 ${deps.join(',')}：${err?.message ?? err}`)
    return undefined
  }
}

/**
 * 注册一个斜杠命令，并把「注册成功」这件事记进 runtime，
 * 这样 /state 能直接回答「宿主侧到底有没有这条命令」。
 * @param {any} c 已注入 commands 服务的 ctx
 * @param {string} name 命令名（不带斜杠）
 * @param {(ctx: any) => any} factory 生成命令定义的工厂
 * @returns {any} cordis disposer
 */
function registerHostCommand(c, name, factory) {
  const dispose = c.commands.register(factory(c))
  if (!runtime.registeredCommands.includes(name)) runtime.registeredCommands.push(name)
  console.log(`[dsh-screen] 命令已注册：/${name}`)
  return dispose
}

export function apply(ctx) {
  const disposers = []
  const push = (disposer) => {
    if (typeof disposer === 'function') disposers.push(disposer)
  }

  const tools = optionalService(ctx, 'tools')
  if (tools?.register) {
    push(tools.register(screenShotTool(ctx)))
    push(tools.register(cameraShotTool(ctx)))
    push(tools.register(cameraWatchTool(ctx)))
    push(tools.register(screenWatchTool(ctx)))
    push(tools.register(screenStatusTool(ctx)))
    push(tools.register(studyNotesTool(ctx)))
  } else {
    console.warn('[dsh-screen] 没有 tools 服务，工具不会注册')
  }

  whenService(ctx, ['commands'], (c) => registerHostCommand(c, 'study', studyCommand))
  whenService(ctx, ['commands'], (c) => registerHostCommand(c, 'voice', voiceCommand))
  whenService(ctx, ['commands'], (c) => registerHostCommand(c, 'camera', cameraCommand))
  void loadStats()

  whenService(ctx, ['systemPrompt'], (c) =>
    c.systemPrompt.section({
      name: 'dsh-screen:study-mode',
      order: 900,
      text: () => {
        if (!runtime.enabled) return ''
        return [
          '## 学习模式（屏幕观察）',
          `用户正在用「屏幕观察」学习，你能看到其整屏画面，节奏约每 ${Math.round(runtime.intervalMs / 1000)} 秒一次。`,
          '- 每次自动观察会把最新画面和最近 10 分钟的笔记一起交给你；你只需用一两句话记下值得学的点，没有实质变化就只回复 <no-change>。',
          '- 屏幕在后台持续采样（约每 1.2 秒一帧），screen_shot 会直接返回缓存的最新画面，几乎零延迟；用户提问时先看一眼再回答。',
          '- 需要观察一段连续操作时用 screen_watch。',
          '- 想回忆刚才屏幕上出现过什么、而上下文里已经看不到时，用 study_notes 取最近的笔记。',
          '- 语音消息是用户口述的，可能有同音字错误：按上下文理解意图，拿不准反问一句，不要机械照字面执行。',
          '- 语音消息会顺带附上当时的屏幕画面，回答要用口语、短句，方便朗读。',
          '- 不要臆测没看到的内容：看不出来就说不确定，并建议再看一眼。',
        ].join('\n')
      },
    }),
  )

  whenService(ctx, ['webServer'], (c) => {
    const dispose = c.webServer.register({
      kind: 'prefix',
      path: API_PATH,
      handler: (req, res) => {
        void handleApi(c, req, res).catch((err) => {
          try {
            sendJson(res, 500, { error: String(err?.message ?? err) })
          } catch {
            res.destroy?.()
          }
        })
      },
    })
    return dispose
  })

  const onEvent = (session, event) => {
    // 只记录「最近活跃」，不拿它当注入目标：注入目标只由 /study on 或按钮显式绑定。
    if (session?.id) runtime.lastActiveSession = session.id
    if (event?.type !== 'assistant/message') return
    if (runtime.voice.awaitingReply) {
      runtime.voice.awaitingReply = false
      void textOfStream(event?.data?.stream).then((text) => speak(text))
    }
    if (!runtime.pendingObs) return
    const stream = event?.data?.stream
    void textOfStream(stream).then((text) => {
      if (runtime.pendingObs) noteFromAssistant(text)
    })
  }
  push(ctx.on('session/event', onEvent))

  push(
    ctx.effect(() => () => {
      if (runtime.timer) {
        clearInterval(runtime.timer)
        runtime.timer = null
      }
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* already gone */
        }
      }
    }),
  )

  const hydratingEpoch = runtime.epoch
  void readPersisted().then((persisted) => {
    if (runtime.epoch !== hydratingEpoch) return
    runtime.baseMs = persisted.intervalMs
    runtime.intervalMs = persisted.intervalMs
    runtime.enabled = persisted.enabled
    scheduleTimer(ctx)
  })
}

export default { name, inject, apply }

export const internals = {
  statsSummary,
  statsLines,
  bumpStats,
  loadStats,
  captureCamera,
  cameraDoctor,
  runtime,
  transcribe,
  wavRms,
  tick,
  sampleOnce,
  digest,
  currentState,
  captureFrame,
}
