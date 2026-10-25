// 只读排查：私信「窗口」到底能看到什么。
// 目的：确认 agent 主动推送给主人的报告私信，是否出现在 fetch_session_msgs 的返回里，
// 以及它距离最新一条有多远（是否会被 size=20 的窗口挤掉）。
// 只发 GET，不发消息、不点赞；结果只写条数/长度/指纹，不写任何消息正文。
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SOURCE_DATA = path.join(APP_DIR, 'release', 'Whaleagent-win32-x64', 'WhaleagentData')
const REPORT = path.join(APP_DIR, 'scripts', 'dm-window-probe-result.txt')
const VC = 'https://api.vc.bilibili.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const lines = []
function step(message) {
  lines.push(String(message))
  try { fs.writeFileSync(REPORT, `${lines.join('\n')}\n`, 'utf8') } catch {}
}
function fp(text) {
  const value = String(text || '')
  if (!value) return '空'
  let hash = 0
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  return `${value.length}字/${hash.toString(16)}`
}

// 报告私信的两种开头（见 report-dm.js 的 buildReportDmText）。
const REPORT_DM_PATTERN = /^主人，(今天筛出|今天的报告好了)/

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whaleagent-probe-'))
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
    const credential = JSON.parse(safeStorage.decryptString(fs.readFileSync(path.join(tempData, 'secrets', 'bilibili-session.bin'))))
    const headers = { 'User-Agent': UA, Referer: 'https://message.bilibili.com/', Cookie: `SESSDATA=${credential.sessdata}; bili_jct=${credential.bili_jct}; buvid3=${credential.buvid3 || ''}` }
    const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers })).json()
    const selfMid = String(nav?.data?.mid || '')
    step(`自己 mid: ${selfMid}`)
    // 主人 UID 从设置里读，和报告私信收件人一致。
    const settings = JSON.parse(fs.readFileSync(path.join(SOURCE_DATA, 'config', 'settings.json'), 'utf8'))
    const ownerUid = String(settings?.persona?.ownerUid || '')
    step(`主人 UID: ${ownerUid}`)

    const sessionsUrl = new URL(`${VC}/session_svr/v1/session_svr/get_sessions`)
    sessionsUrl.search = new URLSearchParams({ session_type: '1', group_fold: '1', unfollow_fold: '0', sort_rule: '2', size: '100', build: '0', mobi_app: 'web' }).toString()
    const sessions = await (await fetch(sessionsUrl, { headers })).json()
    const list = (sessions?.data?.session_list || []).filter((item) => Number(item?.session_type) === 1 && Number(item?.system_msg_type || 0) === 0)
    step(`用户会话数: ${list.length}`)
    for (const session of list) {
      step(`  会话 talker_id=${String(session.talker_id)}（主人=${String(session.talker_id) === ownerUid ? '是' : '否'}）unread=${session.unread_count} last_msg.sender_uid=${session?.last_msg?.sender_uid} max_seqno=${session?.max_seqno}`)
    }

    async function fetchMsgs(talkerId, extra = {}) {
      const url = new URL(`${VC}/svr_sync/v1/svr_sync/fetch_session_msgs`)
      url.search = new URLSearchParams({ sender_device_id: '1', talker_id: talkerId, session_type: '1', size: '20', build: '0', mobi_app: 'web', ...extra }).toString()
      const response = await (await fetch(url, { headers })).json()
      return response
    }

    for (const session of list) {
      const talkerId = String(session.talker_id)
      step(`\n=== 会话 ${talkerId} ===`)
      for (const size of ['20', '50', '100', '200']) {
        const response = await fetchMsgs(talkerId, { size })
        if (response.code !== 0) { step(`  size=${size} code=${response.code} ${response.message}`); continue }
        const messages = Array.isArray(response.data?.messages) ? response.data.messages : []
        const order = messages.length > 1
          ? (Number(messages[0].timestamp) <= Number(messages[messages.length - 1].timestamp) ? '正序(旧→新)' : '倒序(新→旧)')
          : '单条'
        const selfCount = messages.filter((m) => String(m.sender_uid) === selfMid).length
        // 报告私信在不在这一批里，离最新一条有多远。
        const reportIndexes = []
        messages.forEach((m, index) => {
          if (Number(m.msg_type) !== 1) return
          let text = ''
          try { text = String(JSON.parse(String(m.content || '{}'))?.content || '') } catch {}
          if (REPORT_DM_PATTERN.test(text)) reportIndexes.push(index)
        })
        step(`  size=${size}: 返回 ${messages.length} 条，${order}，自己 ${selfCount} 条，报告私信命中 ${reportIndexes.length} 条（下标 ${reportIndexes.join(',') || '无'}）`)
        if (size === '20') {
          const types = {}
          const statuses = {}
          for (const m of messages) {
            types[m.msg_type] = (types[m.msg_type] || 0) + 1
            statuses[m.msg_status] = (statuses[m.msg_status] || 0) + 1
          }
          step(`    msg_type 分布 ${JSON.stringify(types)}｜msg_status 分布 ${JSON.stringify(statuses)}`)
          step(`    字段样本 ${JSON.stringify(Object.keys(messages[0] || {}))}`)
        }
      }
      // 分页：end_seqno 是否能把更早的消息翻出来。
      const latest = await fetchMsgs(talkerId, { size: '20' })
      const newest = (latest.data?.messages || []).reduce((best, m) => (Number(m.msg_seqno) > Number(best?.msg_seqno ?? -1) ? m : best), null)
      if (newest) {
        const older = await fetchMsgs(talkerId, { size: '50', end_seqno: String(newest.msg_seqno) })
        const olderMessages = Array.isArray(older.data?.messages) ? older.data.messages : []
        const olderSelf = olderMessages.filter((m) => String(m.sender_uid) === selfMid).length
        step(`  end_seqno=${newest.msg_seqno} 翻页: code=${older.code} 返回 ${olderMessages.length} 条，自己 ${olderSelf} 条，最新一条 seqno=${olderMessages[0]?.msg_seqno} 最旧=${olderMessages[olderMessages.length - 1]?.msg_seqno}`)
      }
    }

    // 报告私信正文到底长什么样：拿本机报告按 report-dm 的模板拼一次，比对长度是否超过上下文预算。
    const reportDir = path.join(SOURCE_DATA, 'reports')
    const reports = fs.existsSync(reportDir) ? fs.readdirSync(reportDir).filter((name) => name.endsWith('.md')) : []
    step(`\n本机报告 ${reports.length} 份`)
    for (const name of reports.slice(-3)) {
      const content = fs.readFileSync(path.join(reportDir, name), 'utf8')
      step(`  ${name}: ${content.length} 字`)
    }
  } catch (error) {
    step(`失败: ${String(error?.message || error).slice(0, 400)}`)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    app.quit()
  }
})
