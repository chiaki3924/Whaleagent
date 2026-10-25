// 端到端只读验证（不发消息、不点赞、不收藏）。
//
// 用途：升级后确认「推送台账 + 提示词压缩」在真实数据上确实生效。
// 1. 从已有自动报告回填推送台账；
// 2. 用真实私信重放 fetchDmTriggers；
// 3. 走真实的 buildInteractionPrompt，对比压缩前后的上下文字数。
//
// 输出只包含条数、字数、BV 号，**不打印任何私信正文或视频标题**：
// 这份输出会被贴进交接文档，主人的私聊内容不能进去。
//
// 用法：node_modules\electron\dist\electron.exe scripts\push-log-e2e.mjs
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchDmTriggers } from '../src/main/interaction-bilibili.js'
import { buildInteractionPrompt } from '../src/main/model.js'
import { buildPushLogFromReports, buildPushedVideoPayload, describePushLog } from '../src/main/push-log.js'

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SOURCE_DATA = path.join(APP_DIR, 'release', 'Whaleagent-win32-x64', 'WhaleagentData')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const out = (message) => console.log(message)

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whaleagent-push-'))
const tempData = path.join(tempRoot, 'WhaleagentData')
fs.mkdirSync(path.join(tempData, 'secrets'), { recursive: true })
fs.mkdirSync(path.join(tempData, 'runtime'), { recursive: true })
for (const name of fs.readdirSync(path.join(SOURCE_DATA, 'secrets'))) {
  fs.copyFileSync(path.join(SOURCE_DATA, 'secrets', name), path.join(tempData, 'secrets', name))
}
fs.copyFileSync(path.join(SOURCE_DATA, 'runtime', 'Local State'), path.join(tempData, 'runtime', 'Local State'))
app.setPath('userData', path.join(tempData, 'runtime'))

app.whenReady().then(async () => {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(SOURCE_DATA, 'config', 'settings.json'), 'utf8'))
    const reportDir = path.join(SOURCE_DATA, 'reports')
    const reports = fs.readdirSync(reportDir).filter((name) => name.endsWith('.md'))
      .map((name) => ({ name, content: fs.readFileSync(path.join(reportDir, name), 'utf8') }))
    const pushLog = buildPushLogFromReports(reports)
    out(`报告 ${reports.length} 份 → 回填 ${describePushLog(pushLog)}`)
    for (const entry of pushLog.pushes) {
      out(`  ${entry.report} @ ${entry.pushedAt}：${entry.items.map((item) => `${item.bvid}(${item.score ?? '-'})`).join(' ')}`)
    }
    const pushedVideos = buildPushedVideoPayload(pushLog)
    out(`recentPushes ${pushedVideos.length} 条：#1 ${pushedVideos[0]?.bvid} … #${pushedVideos.length} ${pushedVideos.at(-1)?.bvid}`)

    const credential = JSON.parse(safeStorage.decryptString(fs.readFileSync(path.join(tempData, 'secrets', 'bilibili-session.bin'))))
    const headers = { 'User-Agent': UA, Referer: 'https://message.bilibili.com/', Cookie: `SESSDATA=${credential.sessdata}; bili_jct=${credential.bili_jct}; buvid3=${credential.buvid3 || ''}` }
    const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers })).json()
    const selfMid = String(nav?.data?.mid || '')
    // 把主人会话强制标成未读，让 fetchDmTriggers 走完整条链路（不改任何服务端状态）。
    const forcedFetch = async (url, options) => {
      const response = await fetch(url, options)
      if (!String(url).includes('/get_sessions')) return response
      const payload = await response.json()
      for (const session of payload?.data?.session_list || []) {
        if (Number(session?.session_type) !== 1 || Number(session?.system_msg_type || 0) !== 0) continue
        if (String(session.talker_id) !== String(settings?.persona?.ownerUid)) continue
        session.unread_count = 1
        session.last_msg = { ...(session.last_msg || {}), sender_uid: session.talker_id }
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const inbox = await fetchDmTriggers(credential, selfMid, { fetchImpl: forcedFetch })
    const event = inbox.events.find((item) => String(item.target?.talkerId) === String(settings?.persona?.ownerUid))
    if (!event) { out('没拿到主人的会话事件'); return }
    const pushCount = event.context.filter((entry) => /^主人，今天(?:筛出|的报告好了)/.test(entry.text)).length
    const before = event.context.reduce((sum, entry) => sum + entry.text.length, 0)
    const prompt = buildInteractionPrompt({ event, persona: settings.persona, pushedVideos })
    const after = prompt.payload.history.reduce((sum, entry) => sum + entry.text.length, 0)
    const emptyTexts = prompt.payload.history.filter((entry) => !entry.text).length
    out(`真实私信：上下文 ${event.context.length} 条（其中推送 ${pushCount} 条）`)
    out(`history 压缩：${before} 字 → ${after} 字（省 ${before - after} 字）；空条目 ${emptyTexts} 条`)
    out(`payload.recentPushes：${prompt.payload.recentPushes?.length ?? 0} 条；payload 合计 ${JSON.stringify(prompt.payload).length} 字`)
  } catch (error) {
    out(`失败: ${String(error?.message || error).slice(0, 400)}`)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    app.quit()
  }
})
