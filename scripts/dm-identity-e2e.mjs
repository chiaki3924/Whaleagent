// 端到端验证：用真实登录态跑 fetchDmTriggers + createIdentityDirectory，
// 确认“私信对方昵称”这条链路真的能拿到名字（只读，不发消息）。
// 结果写 scripts/dm-identity-e2e-result.txt；不写完整昵称，只写长度与前 2 字。
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchDmTriggers } from '../src/main/interaction-bilibili.js'
import { createIdentityDirectory, describeIdentityLookup, identityFingerprint } from '../src/main/interaction-identity.js'

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SOURCE_DATA = path.join(APP_DIR, 'release', 'Whaleagent-win32-x64', 'WhaleagentData')
const REPORT = path.join(APP_DIR, 'scripts', 'dm-identity-e2e-result.txt')
const VC = 'https://api.vc.bilibili.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const lines = []
function step(message) {
  lines.push(String(message))
  try { fs.writeFileSync(REPORT, `${lines.join('\n')}\n`, 'utf8') } catch {}
}
// 只写长度和指纹，不写昵称本身：这个结果文件会留在仓库里，昵称是别人的个人信息。
function mask(value) {
  const text = String(value || '')
  return text ? `（${text.length} 字，指纹 ${identityFingerprint(text)}）` : '（空）'
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whaleagent-dme2e-'))
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
    step(`登录态 mid 指纹: ${identityFingerprint(selfMid)}`)

    // 1. 昵称目录单独跑一次：把当前所有用户会话的 mid 都查一遍。
    const sessionsUrl = new URL(`${VC}/session_svr/v1/session_svr/get_sessions`)
    sessionsUrl.search = new URLSearchParams({ session_type: '1', group_fold: '1', unfollow_fold: '0', sort_rule: '2', size: '100', build: '0', mobi_app: 'web' }).toString()
    const sessions = await (await fetch(sessionsUrl, { headers })).json()
    const mids = (sessions?.data?.session_list || [])
      .filter((item) => Number(item?.session_type) === 1 && Number(item?.system_msg_type || 0) === 0)
      .map((item) => String(item.talker_id))
    const directory = createIdentityDirectory()
    const names = await directory.lookup(headers, mids)
    step(`目录查询 ${describeIdentityLookup(names, mids)}`)
    for (const mid of mids) step(`  mid 指纹 ${identityFingerprint(mid)} → ${mask(names.get(mid))}`)

    // 2. 走真实的 fetchDmTriggers：诊断里的 namedSessions 就是“这一轮拿到了几个昵称”。
    const inbox = await fetchDmTriggers(credential, selfMid, { identityDirectory: directory })
    step(`fetchDmTriggers: 事件 ${inbox.events.length} 个，warnings ${inbox.warnings.length} 条`)
    step(`diagnostics: ${JSON.stringify(inbox.diagnostics)}`)
    for (const event of inbox.events) {
      step(`  事件 senderName=${mask(event.senderName)} 上下文 ${event.context.length} 条，其中带名字 ${event.context.filter((entry) => entry.name).length} 条`)
    }

    // 3. 走完整链路再确认一次：当前没有未读会话，所以只把 get_sessions 响应里的
    //    unread_count 改成 1（其余仍是真实响应、真实消息、真实昵称查询），
    //    用来验证 fetchDmTriggers 确实会把昵称带到事件和上下文上。
    const forcedFetch = async (url, options) => {
      const response = await fetch(url, options)
      if (!String(url).includes('/get_sessions')) return response
      const payload = await response.json()
      for (const session of payload?.data?.session_list || []) {
        if (Number(session?.session_type) !== 1 || Number(session?.system_msg_type || 0) !== 0) continue
        // 两个条件都放开：当前会话最后一条都是自己发的，否则不会进入“待回复”分支。
        session.unread_count = 1
        session.last_msg = { ...(session.last_msg || {}), sender_uid: session.talker_id }
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const forced = await fetchDmTriggers(credential, selfMid, { fetchImpl: forcedFetch, identityDirectory: directory })
    step(`强制未读后: 事件 ${forced.events.length} 个，warnings ${forced.warnings.length} 条`)
    step(`  diagnostics: ${JSON.stringify(forced.diagnostics)}`)
    for (const event of forced.events) {
      step(`  事件 senderName=${mask(event.senderName)} 上下文 ${event.context.length} 条，其中带名字 ${event.context.filter((entry) => entry.name).length} 条`)
      step(`  对方发言条目的 name: ${event.context.filter((entry) => entry.speaker === 'other').map((entry) => mask(entry.name)).join(' | ') || '（无）'}`)
    }

    // 4. 会话列表里确实没有昵称：把这一条结论再确认一次，写进报告备查。
    const userSessions = (sessions?.data?.session_list || []).filter((item) => Number(item?.session_type) === 1 && Number(item?.system_msg_type || 0) === 0)
    step(`用户会话数 ${userSessions.length}，其中带 account_info 的 ${userSessions.filter((item) => item?.account_info).length} 个（系统会话才带 account_info）`)
  } catch (error) {
    step(`失败: ${String(error?.message || error).slice(0, 400)}`)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    app.quit()
  }
})
