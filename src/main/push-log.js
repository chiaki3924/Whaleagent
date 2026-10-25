// 推送台账：把「agent 推过哪几条视频」从聊天窗口里搬进本地结构化记录。
//
// 为什么必须有这个文件：
// B站 私信接口只返回最近一小段消息，而一条推送私信本身就是 200–500 字的模板摘要。
// 主人再聊十几句，推送就被挤出窗口，agent 于是「忘了自己推过什么」。
// 即使还在窗口里，模型看到的也只是一段自己写过的长文本，没法把「第一条」映射回 BV 号。
// 所以「推过什么」必须由代码落盘，不能指望模型的上下文窗口。
//
// 这里只存：报告名、推送时间、BV、标题、评分，以及主人后来要求做的写操作。
// 不存私信正文、不存主人 UID、不存任何凭据。
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const BV_PATTERN = /^BV[0-9A-Za-z]{10}$/
const MAX_PUSHES = 60
const MAX_ITEMS_PER_PUSH = 3
const MAX_TITLE_CHARS = 120
const DAY_MS = 86_400_000
export const PUSH_LOG_RETENTION_DAYS = 30
// 交给模型时只给最近几条：推送越多，越容易让模型对着旧视频乱点。
export const PUSH_PROMPT_LIMIT = 6
export const PUSH_ACTION_TYPES = Object.freeze(['like', 'favorite'])

function cleanTitle(value) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS)
}

function cleanTime(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}

function cleanActions(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const actions = {}
  for (const type of PUSH_ACTION_TYPES) {
    const at = cleanTime(source[type])
    if (at) actions[type] = at
  }
  return actions
}

export function normalizePushItems(items) {
  const list = Array.isArray(items) ? items : []
  const seen = new Set()
  const normalized = []
  for (const item of list) {
    const bvid = String(item?.bvid || '')
    // 没有 BV 的条目不记：认不出来的视频既不能去重点赞，也没法在提示词里指代。
    if (!BV_PATTERN.test(bvid) || seen.has(bvid)) continue
    seen.add(bvid)
    const score = Number(item?.score)
    normalized.push({
      bvid,
      title: cleanTitle(item?.title),
      score: Number.isFinite(score) && score >= 0 && score <= 10 ? score : null,
      actions: cleanActions(item?.actions),
    })
    if (normalized.length >= MAX_ITEMS_PER_PUSH) break
  }
  return normalized
}

export function normalizePushLog(data, { retentionDays = PUSH_LOG_RETENTION_DAYS, now = new Date() } = {}) {
  const raw = Array.isArray(data) ? data : Array.isArray(data?.pushes) ? data.pushes : []
  const current = new Date(now).getTime()
  const cutoff = Number.isFinite(current) && retentionDays > 0 ? current - retentionDays * DAY_MS : null
  const pushes = []
  for (const entry of raw) {
    const pushedAt = cleanTime(entry?.pushedAt)
    if (!pushedAt) continue
    if (cutoff !== null && new Date(pushedAt).getTime() < cutoff) continue
    const items = normalizePushItems(entry?.items)
    if (!items.length) continue
    pushes.push({
      report: String(entry?.report || '').slice(0, 120),
      pushedAt,
      items,
    })
  }
  // 新的在前，便于提示词只取前几条。
  pushes.sort((a, b) => b.pushedAt.localeCompare(a.pushedAt))
  return { version: 1, pushes: pushes.slice(0, MAX_PUSHES) }
}

// 台账损坏不能让私信监听停摆：按空台账处理，代价只是这一轮认不出旧推送。
export async function readPushLog(logPath, options = {}) {
  try {
    return normalizePushLog(JSON.parse(await fs.readFile(logPath, 'utf8')), options)
  } catch {
    return normalizePushLog({}, options)
  }
}

async function writePushLog(logPath, log) {
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  const tempPath = `${logPath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tempPath, JSON.stringify(log, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await fs.rename(tempPath, logPath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
  return log
}

// 记录一次推送。重发同一份报告就是两次推送，不去重。
export async function recordPush(logPath, { report = '', items = [], now = new Date() } = {}, options = {}) {
  const pushedAt = cleanTime(now)
  if (!pushedAt) throw new Error('推送时间无效，未写入推送台账。')
  const normalizedItems = normalizePushItems(items)
  if (!normalizedItems.length) return { log: await readPushLog(logPath, options), recorded: false, count: 0 }
  const log = await readPushLog(logPath, options)
  const next = normalizePushLog({
    pushes: [{ report: String(report || '').slice(0, 120), pushedAt, items: normalizedItems }, ...log.pushes],
  }, { ...options, now })
  return { log: await writePushLog(logPath, next), recorded: true, count: normalizedItems.length }
}

// 主人要求点赞/收藏成功后回写：同一 BV 同一动作只记第一次时间。
export async function recordPushAction(logPath, { bvid, action, now = new Date() } = {}, options = {}) {
  const id = String(bvid || '')
  if (!BV_PATTERN.test(id)) throw new Error('推送台账动作的 BV 号无效。')
  if (!PUSH_ACTION_TYPES.includes(action)) throw new Error('推送台账动作类型无效。')
  const at = cleanTime(now)
  if (!at) throw new Error('动作时间无效，未写入推送台账。')
  const log = await readPushLog(logPath, options)
  let found = false
  const pushes = log.pushes.map((entry) => ({
    ...entry,
    items: entry.items.map((item) => {
      if (item.bvid !== id) return item
      found = true
      return item.actions?.[action] ? item : { ...item, actions: { ...item.actions, [action]: at } }
    }),
  }))
  if (!found) return { log, recorded: false }
  return { log: await writePushLog(logPath, normalizePushLog({ pushes }, { ...options, now })), recorded: true }
}

// 展平成「一条视频一项」，新的在前；提示词和动作校验都用这个视图。
export function recentPushedVideos(log, { limit = PUSH_PROMPT_LIMIT } = {}) {
  const max = Number(limit)
  if (!Number.isFinite(max) || max <= 0) return []
  const pushes = Array.isArray(log?.pushes) ? log.pushes : []
  const list = []
  for (const entry of pushes) {
    for (const item of entry.items) {
      list.push({
        bvid: item.bvid,
        title: item.title,
        score: item.score,
        pushedAt: entry.pushedAt,
        report: entry.report,
        liked: Boolean(item.actions?.like),
        favorited: Boolean(item.actions?.favorite),
      })
      if (list.length >= max) return list
    }
  }
  return list
}

// 本机时间（YYYY-MM-DD HH:mm），交给模型看的「什么时候推的」必须和主人看到的时钟一致。
function localMinute(iso) {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 交给模型的候选：只给「这条视频是什么」，不给本机路径和内部字段。
export function buildPushedVideoPayload(log, { limit = PUSH_PROMPT_LIMIT } = {}) {
  return recentPushedVideos(log, { limit }).map((item, index) => ({
    index: index + 1,
    bvid: item.bvid,
    title: item.title,
    score: item.score,
    pushedAt: localMinute(item.pushedAt),
    liked: item.liked,
    favorited: item.favorited,
  }))
}

// 写操作只能落在「最近推给主人的视频」上：模型乱编一个 BV、或主人想点别人的视频，都不执行。
export function resolvePushedVideo(log, bvid, { limit = PUSH_PROMPT_LIMIT } = {}) {
  const id = String(bvid || '')
  if (!BV_PATTERN.test(id)) return null
  return recentPushedVideos(log, { limit }).find((item) => item.bvid === id) || null
}

// 诊断只写条数，不写视频标题（标题来自 B站，属于外部内容）。
export function describePushLog(log) {
  const pushes = Array.isArray(log?.pushes) ? log.pushes : []
  if (!pushes.length) return '无推送记录'
  const videos = pushes.reduce((sum, entry) => sum + entry.items.length, 0)
  const acted = pushes.reduce((sum, entry) => sum + entry.items.filter((item) => item.actions?.like || item.actions?.favorite).length, 0)
  return `${pushes.length} 次推送 / ${videos} 条视频${acted ? ` / ${acted} 条已操作` : ''}`
}

// ── 从已有报告回填台账 ─────────────────────────────────────────────
//
// 升级到带台账的版本时，主人过去收到的推送已经只剩报告文件了。
// 不回填的话，新版本第一次运行时 agent 依旧“不记得推过什么”，要等到下一次自动读取才有记录。
// 所以只在台账文件不存在时，从自动报告（Whaleagent-自动-YYYYMMDD-HHmmss.md）重建一次。
//
// 只读自动报告：手动另存的报告不一定私信过主人，混进来会让 agent 对没推过的视频动手。
//
// 注意 `.md` 后缀是可选的：`listReports()` 返回的是**去掉后缀**的报告名，
// 而 `buildPushLogFromReports` 的调用方可能给带后缀的名字。两种都得认，
// 否则回填会静默地一条都匹配不上（这是实际踩到的坑）。
const AUTO_REPORT_NAME = /^Whaleagent-自动-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?(?:\.md)?$/
const REPORT_BV_LINE = /^- BV号：(BV[0-9A-Za-z]{10})\s*$/m
const REPORT_SCORE_LINE = /^- 评分：(\d+(?:\.\d+)?)\/10\s*$/m

export function isAutoReportName(name) {
  return AUTO_REPORT_NAME.test(String(name || ''))
}

function reportTime(name) {
  const match = AUTO_REPORT_NAME.exec(String(name || ''))
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  // 文件名用的是本机时间，按本地时间还原。
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  return Number.isFinite(date.getTime()) ? date : null
}

// 一份标准筛选报告 → 一次推送记录。解析不出 BV 的条目不记（无法去重、也无法指代）。
export function parseReportAsPush(content, reportName = '') {
  const pushedAt = reportTime(reportName)
  if (!pushedAt) return null
  const text = String(content || '').replace(/\r\n?/g, '\n')
  const items = []
  for (const block of text.split(/\n(?=## )/)) {
    if (!block.startsWith('## ')) continue
    const lines = block.split('\n')
    const title = lines[0].slice(3).trim().replace(/\\([\\`*_{}[\]()#+.!|<>~-])/g, '$1')
    const bvid = REPORT_BV_LINE.exec(block)?.[1] || ''
    if (!title || !bvid) continue
    const score = Number(REPORT_SCORE_LINE.exec(block)?.[1])
    items.push({ bvid, title, score: Number.isFinite(score) ? score : null })
    if (items.length >= MAX_ITEMS_PER_PUSH) break
  }
  if (!items.length) return null
  return { report: String(reportName).slice(0, 120), pushedAt: pushedAt.toISOString(), items }
}

// reports: [{ name, content }]。返回规范化后的台账；调用方自己决定要不要落盘。
export function buildPushLogFromReports(reports, options = {}) {
  const pushes = []
  for (const entry of Array.isArray(reports) ? reports : []) {
    const parsed = parseReportAsPush(entry?.content, entry?.name)
    if (parsed) pushes.push(parsed)
  }
  return normalizePushLog({ pushes }, options)
}
