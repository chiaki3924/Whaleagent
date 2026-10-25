// 筛选规则：完全由代码执行的硬规则（无字幕、标题排除词、发布时间窗）。
// 模型只看通过硬规则后的视频；口味类判断仍交给「筛选偏好」和模型。
// 这里不涉及任何网络或磁盘操作，便于单独测试。

export const TITLE_EXCLUDE_MAX_CHARS = 100
export const MAX_TITLE_EXCLUDE_TERMS = 20
// 只看最近 N 天发布的视频。0 = 不限（等于关闭这条规则）。
export const MAX_VIDEO_AGE_DAYS = 30
export const DEFAULT_VIDEO_AGE_DAYS = 7
// 已推荐记录必须比发布时间窗活得更久，否则会出现“窗口还没过、记录已经被删，
// 同一条视频又被推荐一次”。多留 1 天作为安全余量，由代码自动推导，不让用户填两个数。
export const HISTORY_RETENTION_BUFFER_DAYS = 1
const DAY_MS = 86_400_000
// 内置一套常见标题党/情绪化词作为默认排除规则；用户可以在此基础上自由增删改。
// 注意：只有“字段缺失”才回退到默认值，显式保存的空列表/空字符串表示用户主动关闭标题排除。
export const DEFAULT_TITLE_EXCLUDE = ['666', '炸裂', '外网', '热议', '为什么', '为何', '？']

function titleExcludeSource(value) {
  if (value === undefined || value === null) return DEFAULT_TITLE_EXCLUDE.join('，')
  return Array.isArray(value) ? value.join('，') : String(value)
}

// 用户输入用中文或英文逗号分隔；保存前拒绝超长，读取旧配置时容错截断。
export function normalizeTitleExclude(value) {
  const raw = titleExcludeSource(value)
  const text = raw.trim()
  if (text.length > TITLE_EXCLUDE_MAX_CHARS) {
    throw new Error(`标题排除词最多 ${TITLE_EXCLUDE_MAX_CHARS} 个字符。`)
  }
  const terms = []
  const seen = new Set()
  for (const part of text.split(/[,，]/)) {
    const term = part.trim()
    if (!term) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
    if (terms.length >= MAX_TITLE_EXCLUDE_TERMS) break
  }
  return terms
}

// 读到损坏或超长的旧设置时按词截断，避免把半个词当成排除规则。
export function readTitleExclude(value) {
  const raw = titleExcludeSource(value)
  const terms = []
  const seen = new Set()
  let total = 0
  for (const part of raw.split(/[,，]/)) {
    const term = part.trim()
    if (!term) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    const extra = (terms.length ? 1 : 0) + term.length
    if (terms.length >= MAX_TITLE_EXCLUDE_TERMS || total + extra > TITLE_EXCLUDE_MAX_CHARS) break
    seen.add(key)
    terms.push(term)
    total += extra
  }
  return terms
}

// 发布时间窗：只推荐最近 N 天发布的视频。0 表示不限（关闭这条规则）。
// 界面上只有这一个数字，已推荐记录的保留期由 historyRetentionDays 推导，避免用户把两个数填反。
export function normalizeVideoAgeDays(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_VIDEO_AGE_DAYS
  const days = Number(value)
  if (!Number.isInteger(days) || days < 0 || days > MAX_VIDEO_AGE_DAYS) {
    throw new Error(`发布时间窗必须为 0 到 ${MAX_VIDEO_AGE_DAYS} 之间的整数天（0 = 不限）。`)
  }
  return days
}

// 读到损坏的旧值时退回默认，不让整个读取流程失败。
export function readVideoAgeDays(value) {
  try { return normalizeVideoAgeDays(value) } catch { return DEFAULT_VIDEO_AGE_DAYS }
}

// 已推荐记录要活过整个发布时间窗，再多留 1 天余量。
// 返回 0 表示“不按时间清理”（发布时间窗关闭时不能删记录，否则同一条视频会被再次推荐）。
export function historyRetentionDays(maxAgeDays) {
  const days = readVideoAgeDays(maxAgeDays)
  return days > 0 ? days + HISTORY_RETENTION_BUFFER_DAYS : 0
}

// 默认跳过没有可读字幕的视频；只有显式存成 false 才会关闭。
export function normalizeScreenConfig(value = {}) {
  return {
    skipNoSubtitle: value?.skipNoSubtitle !== false,
    titleExclude: normalizeTitleExclude(value?.titleExclude),
    titleExcludeCustomized: value?.titleExcludeCustomized === true,
    maxAgeDays: normalizeVideoAgeDays(value?.maxAgeDays),
  }
}

export function readScreenConfig(value = {}) {
  const titleExcludeCustomized = value?.titleExcludeCustomized === true
  let titleExclude = readTitleExclude(value?.titleExclude)
  // 0.6.0 早期版本把“空列表”当作默认值写进过配置；没有“用户主动改过”标记时补回内置默认词，
  // 避免升级后输入框看起来是空的、默认规则实际也没有生效。用户主动清空后该标记为 true，不再补回。
  if (!titleExcludeCustomized && titleExclude.length === 0) titleExclude = [...DEFAULT_TITLE_EXCLUDE]
  return {
    skipNoSubtitle: value?.skipNoSubtitle !== false,
    titleExclude,
    titleExcludeCustomized,
    maxAgeDays: readVideoAgeDays(value?.maxAgeDays),
  }
}

export function titleExcludeText(terms) {
  return (Array.isArray(terms) ? terms : []).join('，')
}

export function titleExcluded(title, terms = []) {
  const text = String(title || '').toLowerCase()
  if (!text) return false
  return (Array.isArray(terms) ? terms : []).some((term) => {
    const needle = String(term || '').toLowerCase()
    return needle.length > 0 && text.includes(needle)
  })
}

// 统计“本来是新候选、但标题命中排除词”的条数，用于报告和状态栏说明。
export function countTitleExcluded(items, history = [], terms = []) {
  const selected = Array.isArray(terms) ? terms : []
  if (!selected.length) return 0
  const analyzed = new Set((Array.isArray(history) ? history : []).map((record) => String(record?.bvid || '')))
  const seen = new Set()
  let count = 0
  for (const item of Array.isArray(items) ? items : []) {
    const bvid = String(item?.bvid || '')
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid) || seen.has(bvid) || analyzed.has(bvid)) continue
    seen.add(bvid)
    if (titleExcluded(item?.title, selected)) count += 1
  }
  return count
}

export function describeScreening({ titleSkipped = 0, subtitleSkipped = 0, ageSkipped = 0 } = {}) {
  const parts = []
  if (Number(subtitleSkipped) > 0) parts.push(`因无字幕跳过 ${Number(subtitleSkipped)} 条`)
  if (Number(titleSkipped) > 0) parts.push(`因标题排除跳过 ${Number(titleSkipped)} 条`)
  if (Number(ageSkipped) > 0) parts.push(`因超出发布时间窗跳过 ${Number(ageSkipped)} 条`)
  return parts.length ? `筛选说明：${parts.join('；')}。` : ''
}

// 解析候选视频的发布时间。返回毫秒时间戳，取不到或非法时返回 NaN。
export function publishedTimestamp(item) {
  const raw = item?.publishedAt
  if (!raw) return Number.NaN
  const time = new Date(raw).getTime()
  return Number.isFinite(time) ? time : Number.NaN
}

// 发布时间超出窗口 ⇒ true。**取不到发布时间时不算超窗**：宁可多看一条，
// 也不要因为接口少给一个字段就把所有候选都丢掉（去重仍由已推荐记录负责）。
export function publishedTooOld(item, maxAgeDays, now = new Date()) {
  const days = readVideoAgeDays(maxAgeDays)
  if (days <= 0) return false
  const published = publishedTimestamp(item)
  if (!Number.isFinite(published)) return false
  const current = new Date(now).getTime()
  if (!Number.isFinite(current)) return false
  return current - published > days * DAY_MS
}

// 统计“本来是新候选、但发布时间太早”的条数，用于报告和状态栏说明。
export function countAgeExcluded(items, history = [], maxAgeDays, now = new Date()) {
  if (readVideoAgeDays(maxAgeDays) <= 0) return 0
  const analyzed = new Set((Array.isArray(history) ? history : []).map((record) => String(record?.bvid || '')))
  const seen = new Set()
  let count = 0
  for (const item of Array.isArray(items) ? items : []) {
    const bvid = String(item?.bvid || '')
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid) || seen.has(bvid) || analyzed.has(bvid)) continue
    seen.add(bvid)
    if (publishedTooOld(item, maxAgeDays, now)) count += 1
  }
  return count
}

// 给界面和日志用的一句话说明。
export function describeVideoAgeWindow(maxAgeDays) {
  const days = readVideoAgeDays(maxAgeDays)
  return days > 0 ? `只看最近 ${days} 天发布的视频` : '不限发布时间'
}
