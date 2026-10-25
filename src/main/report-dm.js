// 报告私信：报告文件保存成功后，把摘要私信给「我的人设」里填写的主人 UID。
// 文案由本地模板确定性拼装，只有最后一句由模型按人设补充；模板始终可用。
// 所有网络与模型调用都由调用方注入，便于测试。

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// 前作实测 B 站私信约 500 字符上限，超长会返回 code 21007；留 20 字余量。
export const REPORT_DM_MAX_CHARS = 480
// 主动私信是写操作，加一个每日上限，避免异常循环反复打扰主人和触发风控。
export const REPORT_DM_DAILY_LIMIT = 20

export function normalizeReportDmConfig(value = {}) {
  return { enabled: value?.enabled === true }
}

export function localDay(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now)
  if (!Number.isFinite(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function validDayKey(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''))
  if (!match) return ''
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? String(text) : ''
}

export function normalizeReportDmState(value = {}) {
  const timestamp = typeof value?.lastSentAt === 'string' ? new Date(value.lastSentAt) : null
  const count = Number(value?.daily?.count)
  return {
    version: 1,
    lastSentAt: timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : '',
    lastReport: String(value?.lastReport || '').slice(0, 120),
    lastResult: String(value?.lastResult || '').slice(0, 240),
    daily: { date: validDayKey(value?.daily?.date), count: Number.isInteger(count) && count > 0 ? count : 0 },
  }
}

export async function readReportDmState(statePath) {
  try {
    return normalizeReportDmState(JSON.parse(await fs.readFile(statePath, 'utf8')))
  } catch {
    return normalizeReportDmState({})
  }
}

export async function writeReportDmState(statePath, state) {
  const normalized = normalizeReportDmState(state)
  await fs.mkdir(path.dirname(statePath), { recursive: true })
  const tempPath = `${statePath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tempPath, JSON.stringify(normalized, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await fs.rename(tempPath, statePath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

function unescapeMarkdown(text) {
  return String(text || '').replace(/\\([\\`*_{}\[\]()#+.!|<>~-])/g, '$1')
}

function clip(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (max <= 0) return ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// 从标准筛选报告里取出条目，供私信摘要使用；非标准报告返回空数组。
export function parseReportItems(content) {
  const text = String(content || '').replace(/\r\n?/g, '\n')
  const items = []
  for (const block of text.split(/\n(?=## )/)) {
    if (!block.startsWith('## ')) continue
    const lines = block.split('\n')
    const title = unescapeMarkdown(lines[0].slice(3).trim())
    if (!title) continue
    const field = (label) => {
      const line = lines.find((entry) => entry.startsWith(`- ${label}：`))
      return line ? line.slice(`- ${label}：`.length).trim() : ''
    }
    const scoreText = field('评分').replace(/\/10$/, '')
    const score = scoreText === '' ? null : Number(scoreText)
    const bvid = field('BV号')
    const url = field('视频') || (/^BV[0-9A-Za-z]{10}$/.test(bvid) ? `https://www.bilibili.com/video/${bvid}/` : '')
    items.push({
      title,
      score: Number.isFinite(score) && score >= 0 && score <= 10 ? score : null,
      reason: unescapeMarkdown(field('值得关注')),
      url: /^https:\/\/www\.bilibili\.com\/video\/BV[0-9A-Za-z]{10}\/$/.test(url) ? url : '',
    })
    if (items.length >= 8) break
  }
  return items
}

function bvidOf(url) {
  const match = /\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(String(url || ''))
  return match ? match[1] : ''
}

function itemBlock(item, index, reasonLimit) {
  const score = item.score === null || item.score === undefined ? '' : `${item.score}/10`
  const reason = reasonLimit > 0 ? clip(item.reason, reasonLimit) : ''
  const meta = [score, reason].filter(Boolean).join(' · ')
  return `${index + 1}. ${clip(item.title, 32)}${meta ? `\n${meta}` : ''}${item.url ? `\n${item.url}` : ''}`
}

export function buildReportDmText({ reportName = '', items = [], extraLine = '', maxChars = REPORT_DM_MAX_CHARS } = {}) {
  const limit = Number.isInteger(maxChars) && maxChars >= 120 ? maxChars : REPORT_DM_MAX_CHARS
  const list = (Array.isArray(items) ? items : []).filter((item) => item && item.title).slice(0, 3)
  const name = clip(reportName, 40)
  const header = list.length ? `主人，今天筛出 ${list.length} 条：` : '主人，今天的报告好了：'
  const footer = `\n\n报告：${name}${extraLine ? `\n\n${clip(extraLine, 60)}` : ''}`
  // 先保条数，再逐步压缩理由；都放不下时只发标题和报告名。
  for (const reasonLimit of [60, 40, 24, 12, 0]) {
    for (let count = list.length; count >= 1; count -= 1) {
      const body = list.slice(0, count).map((item, index) => itemBlock(item, index, reasonLimit)).join('\n\n')
      const text = `${header}\n\n${body}${footer}`
      if (text.length <= limit) return text
    }
  }
  const fallback = `${header}${footer}`
  return fallback.length <= limit ? fallback : `${fallback.slice(0, limit - 1)}…`
}

// 推送私信的开头由 buildReportDmText 固定生成，用来在会话历史里认出「这是我自己推的」。
// 只认这一种开头：主人或别人转发的消息即使提到“报告”也不会被误判成推送。
export const PUSHED_DM_PATTERN = /^主人，今天(?:筛出\s*\d+\s*条|的报告好了)/

export function isPushedDmText(value) {
  return PUSHED_DM_PATTERN.test(String(value || '').trim())
}

// 把一条推送私信还原成结构化条目，供本地台账和提示词摘要使用。
//
// 注意：这里的输入通常已经被 interaction-context 折成单行（normalizeContextEntry 会把
// 连续空白替换成一个空格），所以**不能按行解析**，换行必须当作普通分隔符处理。
// 解析不出来（用户手改过、被截断）就返回空条目，调用方按“认不出”处理，绝不猜。
export function parsePushedDmText(value) {
  const raw = String(value || '').replace(/\r\n?/g, '\n').trim()
  if (!isPushedDmText(raw)) return null
  const text = raw.replace(/\s+/g, ' ')
  const reportMatch = /报告：(\S+)/.exec(text)
  const items = []
  // 条目形如：`1. 标题 8.5/10 · 理由 https://www.bilibili.com/video/BV…/`，
  // 下一个条目以 `2. ` 开头，末尾是 `报告：`。用前瞻切分，不依赖换行。
  const pattern = /(?:^|\s)([1-3])\.\s+(.+?)(?=\s[1-3]\.\s|\s报告：|$)/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const chunk = match[2].trim()
    if (!chunk) continue
    const scoreMatch = /(\d+(?:\.\d+)?)\/10/.exec(chunk)
    const urlMatch = /https:\/\/www\.bilibili\.com\/video\/(BV[0-9A-Za-z]{10})\/?/.exec(chunk)
    // 标题是“评分/链接”之前的那一段；两者都没有时整段都是标题。
    const cut = [scoreMatch?.index, urlMatch?.index].filter((index) => Number.isInteger(index) && index >= 0)
    const title = (cut.length ? chunk.slice(0, Math.min(...cut)) : chunk).replace(/[\s·]+$/, '').trim()
    items.push({
      title: title.slice(0, 120),
      score: scoreMatch ? Number(scoreMatch[1]) : null,
      bvid: urlMatch ? urlMatch[1] : '',
      url: urlMatch ? `https://www.bilibili.com/video/${urlMatch[1]}/` : '',
    })
    if (items.length >= 3) break
  }
  return {
    report: String(reportMatch?.[1] || '').trim().slice(0, 120),
    items,
  }
}

// 历史里的一条推送私信压缩成一行：模型不需要再读 400 字模板，也能知道推过哪几条。
// 例：[推送 2026-10-25] Whaleagent-自动-…：标题甲(8.5分) / 标题乙(2分)
export function compactPushedDmText(value, { maxChars = 200 } = {}) {
  const parsed = parsePushedDmText(value)
  if (!parsed) return ''
  const parts = parsed.items.map((item) => `${item.title}${item.score === null ? '' : `（${item.score}分）`}`)
  const head = parsed.report ? `[推送 ${parsed.report}]` : '[推送报告]'
  const text = `${head}：${parts.join(' / ') || '（条目未解析出）'}`
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

export function reportDmRemainingToday(state, now = new Date()) {
  const normalized = normalizeReportDmState(state)
  const day = localDay(now)
  const used = normalized.daily.date === day ? normalized.daily.count : 0
  return Math.max(0, REPORT_DM_DAILY_LIMIT - used)
}

// 一次报告私信投递。返回的 state 需要由调用方持久化。
export async function executeReportDm({
  reportName = '',
  content = '',
  persona = {},
  config = {},
  state = {},
  credential = null,
  account = null,
  now = new Date(),
  generateLine = null,
  sendMessage = null,
  log = () => {},
} = {}) {
  const settings = normalizeReportDmConfig(config)
  const current = normalizeReportDmState(state)
  const finish = (message, extra = {}) => ({
    message,
    sent: false,
    skipped: true,
    state: current,
    stateChanged: false,
    ...extra,
  })

  if (!settings.enabled) return finish('报告私信未开启。')
  const recipientUid = String(persona?.ownerUid || '').trim()
  if (!/^\d{1,20}$/.test(recipientUid)) return finish('未在【提示词】填写主人UID，报告私信已跳过。')
  if (!credential) return finish('B站未登录，报告私信已跳过。')
  if (!account?.loggedIn || !/^\d{1,20}$/.test(String(account?.mid || ''))) {
    return finish('B站登录态无效，报告私信已跳过。')
  }
  if (String(account.mid) === recipientUid) return finish('登录账号与主人UID相同，不能私信自己。')
  if (typeof sendMessage !== 'function') return finish('报告私信未配置发送方式。')

  const day = localDay(now)
  const usedToday = current.daily.date === day ? current.daily.count : 0
  if (usedToday >= REPORT_DM_DAILY_LIMIT) {
    return finish(`今天已发送 ${usedToday} 条报告私信，达到每日上限。`)
  }

  const items = parseReportItems(content)
  let extraLine = ''
  if (typeof generateLine === 'function') {
    try {
      extraLine = String(await generateLine({ reportName, items }) || '').trim()
    } catch (error) {
      log('warn', 'report-dm-line-failed', error)
    }
  }
  const text = buildReportDmText({ reportName, items, extraLine })
  // 台账只记真正进了正文的条数（私信可能因为长度被压缩到 2 条），标题用完整标题。
  const sentCount = (text.match(/^[1-3]\. /gm) || []).length
  const pushItems = items.slice(0, sentCount || items.length).map((item) => ({ bvid: bvidOf(item.url), title: item.title, score: item.score }))
  try {
    const receipt = await sendMessage(recipientUid, text)
    const next = normalizeReportDmState({
      ...current,
      lastSentAt: now.toISOString(),
      lastReport: String(reportName || '').slice(0, 120),
      lastResult: `已私信主人（${text.length} 字）。`,
      daily: { date: day, count: usedToday + 1 },
    })
    log('info', 'report-dm-sent', `${String(receipt?.id || 'accepted')}:chars=${text.length}`)
    return {
      message: '报告已私信给主人。',
      sent: true,
      skipped: false,
      text,
      receipt,
      // 推送台账用：只含真正写进私信的那几条（标题是完整标题，不是私信里的截断版）。
      pushItems: pushItems.slice(0, 3),
      state: next,
      stateChanged: true,
    }
  } catch (error) {
    const detail = String(error?.message || '未知错误').slice(0, 160)
    const next = normalizeReportDmState({ ...current, lastResult: `发送失败：${detail}` })
    log('error', 'report-dm-send-failed', error)
    return {
      message: `报告已保存，但私信发送失败：${detail}`,
      sent: false,
      skipped: false,
      state: next,
      stateChanged: true,
    }
  }
}
