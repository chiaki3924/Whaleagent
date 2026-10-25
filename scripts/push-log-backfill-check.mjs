// 回填验证：把打包版复制到临时目录，放入两份自动报告，启动真实 exe，
// 等待启动期的 backfillPushLog 跑完，然后检查 WhaleagentData\history\pushed-videos.json。
// 结果写 scripts/push-log-backfill-result.txt。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.dirname(here)
const REPORT = path.join(here, 'push-log-backfill-result.txt')
const lines = []
const step = (message) => {
  lines.push(String(message))
  try { fs.writeFileSync(REPORT, `${lines.join('\n')}\n`, 'utf8') } catch {}
}

const SOURCE = path.join(APP_DIR, 'release', 'Whaleagent-win32-x64')
const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whaleagent-backfill-'))
for (const entry of fs.readdirSync(SOURCE, { withFileTypes: true })) {
  if (entry.name === 'WhaleagentData') continue
  fs.cpSync(path.join(SOURCE, entry.name), path.join(verifyDir, entry.name), { recursive: true })
}
const dataDir = path.join(verifyDir, 'WhaleagentData')
fs.mkdirSync(path.join(dataDir, 'reports'), { recursive: true })
fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
fs.writeFileSync(path.join(dataDir, 'config', 'settings.json'), JSON.stringify({ models: [] }), 'utf8')

const report = (title, bvid, score) => `# Whaleagent 视频筛选\n\n## ${title}\n\n- BV号：${bvid}\n- UP主：某UP\n- 评分：${score}/10\n- 字幕：已读取\n- 值得关注：理由\n- 视频：https://www.bilibili.com/video/${bvid}/\n`
fs.writeFileSync(path.join(dataDir, 'reports', 'Whaleagent-自动-20261025-120000.md'), report('甲', 'BV0000000001', 9) + report('乙', 'BV0000000002', 8), 'utf8')
fs.writeFileSync(path.join(dataDir, 'reports', 'Whaleagent-自动-20261025-140000.md'), report('丙', 'BV0000000003', 7), 'utf8')
// 手动报告不该被回填。
fs.writeFileSync(path.join(dataDir, 'reports', '我的手动报告.md'), report('丁', 'BV0000000004', 6), 'utf8')
step(`验证目录: ${verifyDir}`)

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(path.join(verifyDir, 'Whaleagent.exe'), ['--remote-debugging-port=9455'], { env, stdio: 'ignore' })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
await sleep(9000)
child.kill()
await sleep(1500)

try {
  const logPath = path.join(dataDir, 'history', 'pushed-videos.json')
  step(`台账存在: ${fs.existsSync(logPath)}`)
  if (fs.existsSync(logPath)) {
    const log = JSON.parse(fs.readFileSync(logPath, 'utf8'))
    step(`推送次数: ${log.pushes.length}`)
    for (const entry of log.pushes) {
      step(`  ${entry.report} @ ${entry.pushedAt} → ${entry.items.map((item) => `${item.bvid}(${item.score ?? '-'})`).join(' ')}`)
    }
    step(`含手动报告: ${log.pushes.some((entry) => entry.report.includes('我的手动报告'))}`)
  }
  const appLog = path.join(dataDir, 'logs', 'whaleagent.log')
  if (fs.existsSync(appLog)) {
    const hits = fs.readFileSync(appLog, 'utf8').split('\n').filter((line) => line.includes('push-log'))
    step(`日志: ${hits.length ? hits.join(' | ') : '（无 push-log 记录）'}`)
  }
} catch (error) {
  step(`失败: ${String(error?.message || error).slice(0, 300)}`)
} finally {
  fs.rmSync(verifyDir, { recursive: true, force: true })
}
