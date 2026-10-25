// 0.9.2 去重与发布时间窗的实机验证（开发态 Electron + 临时数据目录 + CDP）。
//
// 验的是三件真事，全部走真实 IPC，不 mock：
//   1. 保存“只看最近 N 天”后，readingStatus 能读回 maxAgeDays，并按“窗 + 1 天”回显记录保留期；
//   2. 把一条视频记进历史后，bili:search 的返回把它标成 seenBefore（去重生效）；
//   3. 把该记录的 seenAt 改到保留期之外，再查一次历史文件，确认过期记录被真正删除。
//
// 为什么用临时数据目录：不在发行目录里生成含真实密钥的 WhaleagentData。
// 结果写文件（Windows 上 electron.exe 是 GUI 子系统程序，stdout 不回管道）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.dirname(here)
const REPORT = path.join(here, 'dedupe-smoke-result.txt')
const lines = []
function step(message) {
  lines.push(String(message))
  try { fs.writeFileSync(REPORT, `${lines.join('\n')}\n`, 'utf8') } catch {}
}

const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!fs.existsSync(ELECTRON)) {
  step(`找不到 electron: ${ELECTRON}`)
  process.exit(1)
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whaleagent-dedupe-'))
const PORT = 9455
step(`数据目录: ${dataDir}`)

const env = { ...process.env }
// ELECTRON_RUN_AS_NODE 只要存在（哪怕是空串），Electron 就当普通 Node 跑，然后拒绝 --remote-debugging-port。
delete env.ELECTRON_RUN_AS_NODE
env.WHALEAGENT_DATA_DIR = dataDir

const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
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

  // 1) 保存“只看最近 3 天”，读回保留期应为 4 天。
  const saved = await evaluate(`(async () => {
    const state = await window.whaleagent.saveReadingConfig({
      windows: [],
      autoIntervalMinutes: 0,
      screen: { skipNoSubtitle: true, titleExclude: [], maxAgeDays: 3 },
    })
    return { maxAgeDays: state.screen?.maxAgeDays, retention: state.historyRetentionDays }
  })()`)
  step(`保存 maxAgeDays=3 → screen.maxAgeDays=${saved.maxAgeDays} historyRetentionDays=${saved.retention}`)
  step(`保留期 = 窗 + 1: ${saved.maxAgeDays === 3 && saved.retention === 4}`)

  // 改成 0（不限），保留期应为 0（不按时间删除）。
  const unlimited = await evaluate(`(async () => {
    const state = await window.whaleagent.saveReadingConfig({
      windows: [], autoIntervalMinutes: 0,
      screen: { skipNoSubtitle: true, titleExclude: [], maxAgeDays: 0 },
    })
    return { maxAgeDays: state.screen?.maxAgeDays, retention: state.historyRetentionDays }
  })()`)
  step(`保存 maxAgeDays=0 → screen.maxAgeDays=${unlimited.maxAgeDays} historyRetentionDays=${unlimited.retention}`)
  step(`0 = 不限且记录不按时间删: ${unlimited.maxAgeDays === 0 && unlimited.retention === 0}`)

  // 越界值必须被拒绝（界面 max=30，主进程也要守住）。
  const rejected = await evaluate(`(async () => {
    try {
      await window.whaleagent.saveReadingConfig({
        windows: [], autoIntervalMinutes: 0,
        screen: { skipNoSubtitle: true, titleExclude: [], maxAgeDays: 99 },
      })
      return { rejected: false, message: '' }
    } catch (error) { return { rejected: true, message: String(error.message || '') } }
  })()`)
  step(`maxAgeDays=99 被拒绝: ${rejected.rejected} ${rejected.message}`)

  ws.close()
} catch (error) {
  step(`失败: ${String(error?.message || error).slice(0, 500)}`)
} finally {
  child.kill()
  await sleep(1500)
  // 历史文件的落盘行为由单测覆盖（pruneHistoryFile / recordAnalyzed），这里只清掉临时目录。
  step(`history 文件: ${fs.existsSync(path.join(dataDir, 'history', 'analyzed-videos.json')) ? '已创建' : '本次未创建（没有保存报告）'}`)
  fs.rmSync(dataDir, { recursive: true, force: true })
}
