// 打包版里确认 0.9.2 的新设置真的可用：启动临时目录里的真实 Whaleagent.exe，
// 走 IPC 保存“只看最近 2 天”，读回 maxAgeDays=2、记录保留期=3。
// 结果写文件（electron.exe 是 GUI 子系统程序，stdout 不回管道）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPORT = path.join(here, 'packaged-dedupe-result.txt')
const lines = []
function step(message) {
  lines.push(String(message))
  try { fs.writeFileSync(REPORT, `${lines.join('\n')}\n`, 'utf8') } catch {}
}

const verifyDir = String(process.argv[2] || '').trim()
if (!verifyDir || !fs.existsSync(verifyDir)) {
  step(`验证目录无效: "${verifyDir}"`)
  process.exit(1)
}
const EXE = path.join(verifyDir, 'Whaleagent.exe')
const PORT = 9466
step(`验证目录: ${verifyDir}`)

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
child.stderr.on('data', (chunk) => { stderr += String(chunk) })
child.stdout.on('data', () => {})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function connect() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await response.json()
      const page = list.find((target) => target.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error(`CDP 没起来：${stderr.slice(-600)}`)
}

try {
  const ws = new WebSocket(await connect())
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let nextId = 1
  const pending = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
  }
  const send = (method, params = {}) => {
    const id = nextId++
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve) => pending.set(id, resolve))
  }
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 400))
    return result.result?.result?.value
  }

  await send('Runtime.enable')
  await sleep(3500)

  const out = await evaluate(`(async () => {
    // 走真实的界面保存路径：改输入框 → 触发 input 事件 → 等自动保存（600ms 防抖）→ 读回状态与说明文案。
    const input = document.getElementById('max-age-days')
    const before = document.getElementById('age-window-note')?.textContent || ''
    input.value = '2'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 1600))
    const state = await window.whaleagent.readingStatus()
    return {
      maxAgeDays: state.screen?.maxAgeDays,
      retention: state.historyRetentionDays,
      hasInput: Boolean(input),
      before,
      note: document.getElementById('age-window-note')?.textContent || '',
      inputValue: input.value,
    }
  })()`)
  step(`打包版界面输入 2 天 → 保存后 screen.maxAgeDays=${out.maxAgeDays} historyRetentionDays=${out.retention}`)
  step(`界面有“只看最近几天”输入框: ${out.hasInput}`)
  step(`保存前文案: ${out.before}`)
  step(`保存后文案: ${out.note}`)
  step(`保留期 = 窗 + 1: ${out.maxAgeDays === 2 && out.retention === 3}`)
  step(`说明文案跟着更新: ${/最近 2 天/.test(out.note) && /保留 3 天/.test(out.note)}`)

  ws.close()
} catch (error) {
  step(`失败: ${String(error?.message || error).slice(0, 500)}`)
} finally {
  child.kill()
  await sleep(1200)
}
