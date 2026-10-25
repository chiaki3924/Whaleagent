// 打包版冒烟验证：启动复制到临时目录的真实 Whaleagent.exe，用 CDP 检查
// 便携目录、images 子目录、preload 桥和图片库扫描结果。
// 结果写文件（electron.exe 是 GUI 子系统程序，stdout 不回管道）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPORT = path.join(here, 'packaged-smoke-result.txt')
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
const PORT = 9444
step(`验证目录: ${verifyDir}`)

const env = { ...process.env }
// 关键：ELECTRON_RUN_AS_NODE 只要存在（哪怕是空串）Electron 就当普通 Node 跑，
// 然后拒绝 --remote-debugging-port。
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
    const info = await window.whaleagent.dataInfo()
    return {
      hasBridge: Boolean(window.whaleagent),
      mode: info.mode,
      rootDir: info.rootDir,
      imagesDir: info.subdirs?.images || '',
      encryptionAvailable: info.encryptionAvailable,
      secretsReadable: info.secrets?.readable,
    }
  })()`)
  step(`bridge/data: ${JSON.stringify(out)}`)

  // 确认 images 目录真的被创建在 exe 旁边。
  step(`images 目录存在: ${fs.existsSync(out.imagesDir)}`)
  step(`images 位于 exe 同级的 WhaleagentData 下: ${out.imagesDir.startsWith(path.join(verifyDir, 'WhaleagentData'))}`)
  step(`%APPDATA%\\whaleagent\\WhaleagentData 未被创建: ${!fs.existsSync(path.join(process.env.APPDATA, 'whaleagent', 'WhaleagentData'))}`)

  ws.close()
} catch (error) {
  step(`失败: ${String(error?.message || error).slice(0, 500)}`)
} finally {
  child.kill()
  await sleep(1200)
}
