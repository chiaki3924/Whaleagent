// 日记：两本（给主人看 / 给自己看）。
//
// 存储：<程序目录>\WhaleagentData\diaries\diary-public.md / diary-private.md
// （0.9.0 起的便携数据目录；旧版曾放在 Documents\Whaleagent\diaries，会自动迁移）。
// 每天一节，标题固定为 `## YYYY-MM-DD`；读取和写入都以这一行为边界。
//
// 保留策略（“第 8 天删掉第 1 天”）由代码确定性地执行：
//   · 保留窗口 = 今天往前推 retentionDays - 1 天，共 retentionDays 天；
//   · 写新日记、应用启动和页面清理时调用 prune，删除窗口外的整节；
//   · 模型只会拿到窗口内的旧日记，提示词里也明确写了窗口边界。
// 删除不依赖模型“记得删文件”，避免模型遗漏或被视频字幕里的提示注入影响。

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const DIARY_KINDS = Object.freeze(['public', 'private'])

export const DIARY_KIND_LABELS = Object.freeze({
  public: '给主人看的日记',
  private: '给自己看的日记',
})

export const DIARY_FILE_NAMES = Object.freeze({
  public: 'diary-public.md',
  private: 'diary-private.md',
})

export const DEFAULT_DIARY_TIME = '23:00'
export const DEFAULT_DIARY_RETENTION_DAYS = 7
export const MIN_DIARY_RETENTION_DAYS = 1
export const MAX_DIARY_RETENTION_DAYS = 365
export const MAX_DIARY_ENTRY_CHARS = 4000
export const MAX_DIARY_HISTORY_CHARS = 6000
export const MAX_DIARY_HISTORY_ENTRY_CHARS = 1200

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const DAY_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/

const pad2 = (value) => String(value).padStart(2, '0')

export function isValidDayKey(value) {
  const match = DAY_KEY.exec(String(value ?? ''))
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

export function localDayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function normalizeClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return `${pad2(hours)}:${pad2(minutes)}`
}

function normalizeRetentionDays(value) {
  const days = value === null || value === undefined || value === '' ? DEFAULT_DIARY_RETENTION_DAYS : Number(value)
  if (!Number.isInteger(days) || days < MIN_DIARY_RETENTION_DAYS || days > MAX_DIARY_RETENTION_DAYS) {
    throw new Error(`日记保留天数必须为 ${MIN_DIARY_RETENTION_DAYS} 到 ${MAX_DIARY_RETENTION_DAYS} 之间的整数。`)
  }
  return days
}

export function normalizeDiaryConfig(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const time = normalizeClock(source.time === undefined || source.time === '' ? DEFAULT_DIARY_TIME : source.time)
  if (!time) throw new Error('自动写日记时间无效，请使用 HH:MM 格式。')
  return {
    // 总开关默认打开，但“每天自动写”默认关闭：手动写日记不会产生意外的模型费用。
    enabled: source.enabled !== false,
    autoEnabled: source.autoEnabled === true,
    publicEnabled: source.publicEnabled !== false,
    privateEnabled: source.privateEnabled !== false,
    time,
    retentionDays: normalizeRetentionDays(source.retentionDays),
  }
}

export function diaryBooksEnabled(configInput = {}) {
  const config = normalizeDiaryConfig(configInput)
  return config.enabled && (config.publicEnabled || config.privateEnabled)
}

export function normalizeDiaryState(value = {}) {
  const lastRunAt = typeof value?.lastRunAt === 'string' ? new Date(value.lastRunAt) : null
  const lastRunDate = typeof value?.lastRunDate === 'string' && isValidDayKey(value.lastRunDate) ? value.lastRunDate : ''
  return {
    version: 1,
    lastRunAt: lastRunAt && Number.isFinite(lastRunAt.getTime()) ? lastRunAt.toISOString() : '',
    lastRunDate,
    lastResult: String(value?.lastResult || '').slice(0, 240),
  }
}

export async function readDiaryState(statePath) {
  try {
    return normalizeDiaryState(JSON.parse(await fs.readFile(statePath, 'utf8')))
  } catch {
    return normalizeDiaryState({})
  }
}

export async function writeDiaryState(statePath, state) {
  const normalized = normalizeDiaryState(state)
  await fs.mkdir(path.dirname(statePath), { recursive: true })
  const tempPath = `${statePath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tempPath, JSON.stringify(normalized, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await fs.rename(tempPath, statePath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
  return normalized
}

export function diaryTimeReached(time, now = new Date()) {
  const clock = normalizeClock(time) || DEFAULT_DIARY_TIME
  const date = now instanceof Date ? now : new Date(now)
  if (!Number.isFinite(date.getTime())) return false
  const [hours, minutes] = clock.split(':').map(Number)
  return date.getHours() * 60 + date.getMinutes() >= hours * 60 + minutes
}

export function diaryDue(configInput = {}, stateInput = {}, now = new Date()) {
  const config = normalizeDiaryConfig(configInput)
  if (!config.enabled || !config.autoEnabled || (!config.publicEnabled && !config.privateEnabled)) return false
  const day = localDayKey(now)
  if (!day) return false
  if (normalizeDiaryState(stateInput).lastRunDate === day) return false
  return diaryTimeReached(config.time, now)
}

export function nextDiaryRunAt(configInput = {}, stateInput = {}, now = new Date()) {
  const config = normalizeDiaryConfig(configInput)
  if (!config.enabled || !config.autoEnabled || (!config.publicEnabled && !config.privateEnabled)) return null
  const current = now instanceof Date ? new Date(now.getTime()) : new Date(now)
  if (!Number.isFinite(current.getTime())) return null
  const [hours, minutes] = config.time.split(':').map(Number)
  const todayAt = new Date(current.getFullYear(), current.getMonth(), current.getDate(), hours, minutes, 0, 0)
  if (normalizeDiaryState(stateInput).lastRunDate === localDayKey(current)) {
    return new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1, hours, minutes, 0, 0)
  }
  if (current.getTime() >= todayAt.getTime()) return current
  return todayAt
}

export function retentionCutoffDay(retentionDays, now = new Date()) {
  const days = normalizeRetentionDays(retentionDays)
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now)
  if (!Number.isFinite(date.getTime())) throw new Error('当前时间无效，无法计算日记保留窗口。')
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - (days - 1))
  return localDayKey(date)
}

export function retentionWindow(retentionDays, now = new Date()) {
  return { from: retentionCutoffDay(retentionDays, now), to: localDayKey(now) }
}

export function parseDiarySections(text) {
  const normalized = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
  const sections = new Map()
  let currentDate = ''
  let buffer = []
  const flush = () => {
    if (!currentDate) {
      buffer = []
      return
    }
    const content = buffer.join('\n').trim()
    if (content) sections.set(currentDate, content)
    buffer = []
  }
  for (const line of normalized.split('\n')) {
    const heading = DAY_HEADING.exec(line)
    if (heading) {
      flush()
      // 形如 `## 2026-02-30` 的非法日期也算分节边界，避免它的正文被并入上一篇。
      currentDate = isValidDayKey(heading[1]) ? heading[1] : ''
      continue
    }
    if (currentDate) buffer.push(line)
  }
  flush()
  return [...sections.entries()]
    .map(([date, content]) => ({ date, content }))
    .sort((left, right) => right.date.localeCompare(left.date))
}

export function formatDiaryFile(title, sections) {
  const heading = String(title || '').trim() || '日记'
  const ordered = (Array.isArray(sections) ? sections : [])
    .filter((section) => isValidDayKey(section?.date) && String(section?.content || '').trim())
    .map((section) => ({ date: section.date, content: String(section.content).trim() }))
    .sort((left, right) => right.date.localeCompare(left.date))
  const parts = [`# ${heading}`]
  for (const section of ordered) parts.push(`## ${section.date}\n\n${section.content}`)
  return `${parts.join('\n\n')}\n`
}

export function pruneDiarySections(sections, retentionDays, now = new Date()) {
  const cutoff = retentionCutoffDay(retentionDays, now)
  const kept = []
  const removed = []
  const seen = new Set()
  for (const section of Array.isArray(sections) ? sections : []) {
    if (!isValidDayKey(section?.date)) continue
    if (section.date < cutoff) {
      removed.push(section.date)
      continue
    }
    if (seen.has(section.date)) continue
    seen.add(section.date)
    const content = String(section?.content || '').trim()
    if (!content) continue
    kept.push({ date: section.date, content })
  }
  kept.sort((left, right) => right.date.localeCompare(left.date))
  return { kept, removed }
}

export function pruneDiaryText({ text = '', title = '日记', retentionDays, now = new Date() } = {}) {
  const sections = parseDiarySections(text)
  const { kept, removed } = pruneDiarySections(sections, retentionDays, now)
  if (!removed.length) return { text: String(text ?? ''), removed, kept: sections }
  return { text: formatDiaryFile(title, kept), removed, kept }
}

function normalizeDiaryBody(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .split('\n')
    .filter((line) => !DAY_HEADING.test(line))
    .join('\n')
    .trim()
}

export function normalizeDiaryEntry(value, label = '日记') {
  if (typeof value !== 'string') throw new Error(`${label}内容缺失。`)
  const text = normalizeDiaryBody(value)
  if (!text) throw new Error(`${label}内容为空。`)
  if (text.length > MAX_DIARY_ENTRY_CHARS) {
    return `${text.slice(0, MAX_DIARY_ENTRY_CHARS - 1).trimEnd()}…`
  }
  return text
}

export function upsertDiaryText({ text = '', title = '日记', date, content, retentionDays, now = new Date() } = {}) {
  if (!isValidDayKey(date)) throw new Error('日记日期无效。')
  const body = normalizeDiaryBody(content)
  if (!body) throw new Error('日记内容为空。')
  const sections = parseDiarySections(text).filter((section) => section.date !== date)
  sections.push({ date, content: body })
  const { kept, removed } = pruneDiarySections(sections, retentionDays, now)
  return { text: formatDiaryFile(title, kept), removed, sections: kept }
}

export function diaryHistoryForPrompt(sections, { maxChars = MAX_DIARY_HISTORY_CHARS, perEntryChars = MAX_DIARY_HISTORY_ENTRY_CHARS } = {}) {
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : MAX_DIARY_HISTORY_CHARS
  const entryLimit = Number.isInteger(perEntryChars) && perEntryChars > 0 ? perEntryChars : MAX_DIARY_HISTORY_ENTRY_CHARS
  const history = []
  let total = 0
  for (const section of Array.isArray(sections) ? sections : []) {
    const content = String(section?.content || '').trim()
    if (!content) continue
    const trimmed = content.length > entryLimit ? `${content.slice(0, entryLimit - 1).trimEnd()}…` : content
    if (total + trimmed.length > limit) break
    history.push({ date: section.date, content: trimmed })
    total += trimmed.length
    if (history.length >= 31) break
  }
  return history
}

function safeErrorMessage(error) {
  return String(error?.message || '未知错误').replace(/[\r\n\t]+/g, ' ').slice(0, 180)
}

// 一次完整的日记生成。所有外部依赖注入，便于测试，也避免核心逻辑直接碰文件或网络。
export async function executeDiaryGeneration({
  config = {},
  state = {},
  hasApiKey = false,
  readDiary = async () => '',
  writeDiary = async () => {},
  collectActivity = async () => ({}),
  generate,
  log = () => {},
  now = new Date(),
  trigger = 'auto',
} = {}) {
  const diaryConfig = normalizeDiaryConfig(config)
  const previous = normalizeDiaryState(state)
  const day = localDayKey(now)
  if (!day) throw new Error('当前时间无效，无法写日记。')
  const skip = (message) => ({ message, skipped: true, failed: false, day, state: previous, stateChanged: false })
  if (!diaryConfig.enabled) return skip('日记总开关已关闭，本轮未写。')
  if (!diaryConfig.publicEnabled && !diaryConfig.privateEnabled) return skip('两本日记都未启用，本轮未写。')
  if (!hasApiKey) return skip('模型服务未配置，日记已跳过。')
  if (typeof generate !== 'function') throw new Error('缺少日记生成器。')

  let publicText = ''
  let privateText = ''
  try {
    publicText = String((await readDiary('public')) || '')
    privateText = String((await readDiary('private')) || '')
  } catch (error) {
    log('error', 'diary-read-failed', error)
    throw error
  }

  const publicSections = parseDiarySections(publicText)
  const privateSections = parseDiarySections(privateText)
  const publicHistory = diaryHistoryForPrompt(pruneDiarySections(publicSections, diaryConfig.retentionDays, now).kept)
  const privateHistory = diaryHistoryForPrompt(pruneDiarySections(privateSections, diaryConfig.retentionDays, now).kept)

  let activity = {}
  try {
    activity = (await collectActivity()) || {}
  } catch (error) {
    log('warn', 'diary-activity-failed', error)
  }

  const entries = {}
  try {
    const generated = await generate({ day, activity, publicHistory, privateHistory, retentionDays: diaryConfig.retentionDays })
    for (const kind of DIARY_KINDS) {
      const enabled = kind === 'public' ? diaryConfig.publicEnabled : diaryConfig.privateEnabled
      if (enabled) entries[kind] = normalizeDiaryEntry(generated?.[kind], DIARY_KIND_LABELS[kind])
    }
  } catch (error) {
    const message = `写日记失败：${safeErrorMessage(error)}`
    log('error', 'diary-generation-failed', error)
    return {
      message,
      skipped: false,
      failed: true,
      day,
      state: normalizeDiaryState({
        lastRunAt: now.toISOString(),
        lastRunDate: trigger === 'auto' ? day : previous.lastRunDate,
        lastResult: message,
      }),
      stateChanged: true,
    }
  }

  const written = []
  const removed = []
  for (const kind of DIARY_KINDS) {
    const enabled = kind === 'public' ? diaryConfig.publicEnabled : diaryConfig.privateEnabled
    const originalText = kind === 'public' ? publicText : privateText
    if (enabled) {
      const result = upsertDiaryText({
        text: originalText,
        title: DIARY_KIND_LABELS[kind],
        date: day,
        content: entries[kind],
        retentionDays: diaryConfig.retentionDays,
        now,
      })
      await writeDiary(kind, result.text)
      written.push(kind)
      removed.push(...result.removed)
    } else {
      // 某一本关闭时仍然清理它的旧条目，避免保留期形同虚设。
      const result = pruneDiaryText({
        text: originalText,
        title: DIARY_KIND_LABELS[kind],
        retentionDays: diaryConfig.retentionDays,
        now,
      })
      if (result.removed.length) await writeDiary(kind, result.text)
      removed.push(...result.removed)
    }
  }

  const uniqueRemoved = [...new Set(removed)]
  const booksText = written.map((kind) => DIARY_KIND_LABELS[kind]).join('和')
  const message = `已写好${booksText}（${day}）${removed.length ? `，并删除 ${removed.length} 篇超出 ${diaryConfig.retentionDays} 天保留期的旧日记` : ''}。`
  return {
    message,
    skipped: false,
    failed: false,
    day,
    written,
    removed: uniqueRemoved,
    state: normalizeDiaryState({
      lastRunAt: now.toISOString(),
      lastRunDate: day,
      lastResult: message,
    }),
    stateChanged: true,
  }
}
