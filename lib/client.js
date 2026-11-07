/**
 * dsh-screen 客户端半：对话输入栏左侧的一枚「学习模式」开关。
 *
 * 这是手写的模块加载协议脚本，不是打包产物：
 *   - 整个文件在一个 window.__ModuleLoader__.load({ id, factory }) 里注册；
 *   - 不能用顶层 import / export；react 由 factory 的 require 取得；
 *   - 返回的 module.exports 需要 inject 与 apply。
 *
 * 开关状态由宿主半的 HTTP 接口持有（/dsh-screen-api/state），
 * 与 /study 命令读写同一份状态，因此两边永远一致。
 */
window.__ModuleLoader__.load({
  id: 'dsh-screen',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/dsh-screen-api/state'
    const POLL_MS = 5000

    async function readState() {
      const response = await fetch(API, { cache: 'no-store' })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.json()
    }

    async function writeState(enabled) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.json()
    }

    function ScreenWatchToggle() {
      const stateValue = React.useState(null)
      const snapshot = stateValue[0]
      const setSnapshot = stateValue[1]
      const busyState = React.useState(false)
      const busy = busyState[0]
      const setBusy = busyState[1]
      const problemState = React.useState('')
      const problem = problemState[0]
      const setProblem = problemState[1]
      const hoverState = React.useState(false)
      const hovered = hoverState[0]
      const setHovered = hoverState[1]

      React.useEffect(() => {
        let alive = true
        const sync = () => {
          readState()
            .then((value) => {
              if (alive) {
                setSnapshot(value)
                setProblem('')
              }
            })
            .catch(() => {
              if (alive) setProblem('插件未就绪')
            })
        }
        sync()
        const timer = setInterval(sync, POLL_MS)
        window.addEventListener('focus', sync)
        return () => {
          alive = false
          clearInterval(timer)
          window.removeEventListener('focus', sync)
        }
      }, [])

      const toggle = React.useCallback(
        (event) => {
          event.stopPropagation()
          if (busy || !snapshot) return
          const next = !snapshot.enabled
          setBusy(true)
          setSnapshot(Object.assign({}, snapshot, { enabled: next }))
          writeState(next)
            .then((value) => {
              setSnapshot(value)
              setProblem('')
            })
            .catch(() => {
              setSnapshot(Object.assign({}, snapshot, { enabled: !next }))
              setProblem('切换失败')
            })
            .finally(() => setBusy(false))
        },
        [busy, snapshot],
      )

      const on = snapshot?.enabled === true
      const notes = snapshot?.notes ?? 0
      const interval = Math.round((snapshot?.intervalMs ?? 30000) / 1000)
      const dotColor = problem ? '#c8341e' : on ? '#1a9c5b' : 'rgba(127,127,127,0.55)'
      const label = problem ? problem : on ? '学习模式 · 开' : '学习模式 · 关'
      const hint = problem
        ? '宿主接口没有响应：插件可能还没装载完成'
        : on
          ? [
            `每 ${interval} 秒整理一次笔记，最近 10 分钟记了 ${notes} 条`,
            typeof snapshot?.freshMs === 'number' ? `屏幕 ${Math.max(0, Math.round(snapshot.freshMs / 1000))} 秒前刷新` : null,
            typeof snapshot?.changes === 'number' ? `累计变化 ${snapshot.changes} 次` : null,
            '点击关闭',
          ]
            .filter(Boolean)
            .join('；')
          : '开启后模型会按节奏自动观察屏幕并记笔记；单帧查看始终按需可用'

      return h(
        'button',
        {
          type: 'button',
          onClick: toggle,
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          disabled: busy || !snapshot,
          title: hint,
          'aria-pressed': on,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            height: '28px',
            padding: '0 10px',
            marginRight: '6px',
            fontSize: '12px',
            lineHeight: '1',
            borderRadius: '999px',
            border: '1px solid rgba(127,127,127,0.35)',
            background: hovered ? 'rgba(127,127,127,0.10)' : 'transparent',
            color: 'inherit',
            opacity: busy ? 0.6 : 1,
            cursor: busy ? 'progress' : 'pointer',
            transition: 'background 120ms ease',
          },
        },
        h('span', {
          style: {
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            background: dotColor,
            boxShadow: on && !problem ? '0 0 0 2px rgba(26,156,91,0.18)' : 'none',
          },
        }),
        label,
      )
    }

    const VOICE_API = '/dsh-screen-api/voice'

    async function voicePost(path, body) {
      const response = await fetch(VOICE_API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status)
      return data
    }

    function VoiceButton() {
      const stateValue = React.useState(null)
      const snapshot = stateValue[0]
      const setSnapshot = stateValue[1]
      const busyState = React.useState(false)
      const busy = busyState[0]
      const setBusy = busyState[1]
      const problemState = React.useState('')
      const problem = problemState[0]
      const setProblem = problemState[1]
      const hoverState = React.useState(false)
      const hovered = hoverState[0]
      const setHovered = hoverState[1]
      const tickState = React.useState(0)
      const setTick = tickState[1]

      React.useEffect(() => {
        let alive = true
        let timer = null
        const schedule = (ms) => {
          timer = setTimeout(sync, ms)
        }
        const sync = () => {
          fetch(VOICE_API + '/state', { cache: 'no-store' })
            .then((response) => {
              if (!response.ok) throw new Error('HTTP ' + response.status)
              return response.json()
            })
            .then((value) => {
              if (!alive) return
              setSnapshot(value)
              setProblem('')
              setTick((n) => n + 1)
              schedule(value && value.recording ? 300 : 4000)
            })
            .catch(() => {
              if (!alive) return
              setProblem('语音不可用')
              schedule(5000)
            })
        }
        sync()
        const onFocus = () => sync()
        window.addEventListener('focus', onFocus)
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
          window.removeEventListener('focus', onFocus)
        }
      }, [])

      const recording = Boolean(snapshot && snapshot.recording)
      const seconds = snapshot ? snapshot.seconds : 0
      const ready = Boolean(snapshot && snapshot.ready)

      const toggle = () => {
        if (busy) return
        if (recording) {
          // 停止后要等转写，先切到“识别中”
          setBusy(true)
          setSnapshot(snapshot ? Object.assign({}, snapshot, { recording: false, preparing: true }) : snapshot)
          voicePost('/stop')
            .then((value) => {
              setSnapshot(value)
              if (value.error) setProblem(value.error)
              else if (!value.text) setProblem('没听清')
              else setProblem('')
            })
            .catch((err) => setProblem(String(err.message || err)))
            .finally(() => setBusy(false))
          return
        }
        setBusy(true)
        voicePost('/start')
          .then((value) => setSnapshot(value))
          .catch((err) => setProblem(String(err.message || err)))
          .finally(() => setBusy(false))
      }

      const preparing = Boolean(snapshot && !ready && (snapshot.preparing || snapshot.downloading))
      const label = problem
        ? problem
        : recording
          ? '录音中 ' + seconds.toFixed(1) + 's · 点击发送'
          : busy || preparing
            ? '语音准备中'
            : '语音'
      const hint = problem
        ? '语音接口没有响应：插件可能还没装载完成'
        : recording
          ? '再点一次结束录音并发送'
          : ready
            ? '点击开始说话，再点一次结束并发送；说完的回复会被朗读'
            : '首次使用要加载语音模型（约 20–40 秒），期间照着说就行'

      return h(
        'button',
        {
          type: 'button',
          onClick: toggle,
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          disabled: busy && !recording,
          title: hint,
          'aria-pressed': recording,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            height: '28px',
            padding: '0 10px',
            marginRight: '6px',
            fontSize: '12px',
            lineHeight: '1',
            borderRadius: '999px',
            border: '1px solid rgba(127,127,127,0.35)',
            background: hovered ? 'rgba(127,127,127,0.10)' : 'transparent',
            color: 'inherit',
            opacity: busy && !recording ? 0.6 : 1,
            cursor: busy && !recording ? 'progress' : 'pointer',
            transition: 'background 120ms ease',
          },
        },
        h('span', {
          style: {
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            background: problem ? '#c8341e' : recording ? '#f43146' : 'rgba(127,127,127,0.55)',
            boxShadow: recording ? '0 0 0 2px rgba(244,49,70,0.18)' : 'none',
          },
        }),
        label,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'screen-watch-toggle',
            order: 50,
          },
          ScreenWatchToggle,
        ),
      )
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'screen-voice-button',
            order: 60,
          },
          VoiceButton,
        ),
      )
    }

    return { inject, apply }
  },
})
