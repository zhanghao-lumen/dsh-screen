// 失败时把测试日志尾部写进本次 check run 的 output.summary，
// 这样没登录也能通过公开 API 读到失败原因。
import { readFileSync } from 'node:fs'

const token = process.env.GITHUB_TOKEN
const repo = process.env.GITHUB_REPOSITORY
const sha = process.env.GITHUB_SHA
const api = process.env.GITHUB_API_URL || 'https://api.github.com'
if (!token || !repo || !sha) {
  console.log('缺少 GITHUB_TOKEN / GITHUB_REPOSITORY / GITHUB_SHA，跳过')
  process.exit(0)
}

let log = ''
try {
  log = readFileSync('/tmp/test.log', 'utf8')
} catch {
  log = '(没有 /tmp/test.log)'
}
const tail = log.split('\n').slice(-60).join('\n').slice(-6000)

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'content-type': 'application/json',
}

const list = await fetch(`${api}/repos/${repo}/commits/${sha}/check-runs`, { headers })
if (!list.ok) {
  console.log('列出 check runs 失败', list.status, await list.text())
  process.exit(0)
}
const { check_runs: runs = [] } = await list.json()
const mine = runs.find((run) => run.name === 'test') ?? runs[0]
if (!mine) {
  console.log('没找到 check run')
  process.exit(0)
}

const res = await fetch(`${api}/repos/${repo}/check-runs/${mine.id}`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({ output: { title: '测试失败（日志尾部）', summary: '```\n' + tail + '\n```' } }),
})
console.log('上报诊断:', res.status)
