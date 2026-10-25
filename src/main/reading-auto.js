import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isWithinReadingWindows, nextReadingWindowStart, normalizeReadingWindows } from './reading-window.js'
import { normalizeHistory } from './history.js'
import { countAgeExcluded, countTitleExcluded, describeScreening, historyRetentionDays, normalizeScreenConfig, publishedTooOld, readVideoAgeDays, titleExcluded } from './screening.js'

export const MAX_AUTO_INTERVAL_MINUTES = 1440
export const DEFAULT_AUTO_INTERVAL_MINUTES = 60
// 代码层先筛出最多 10 条候选交给模型；模型再从这 10 条里挑出最多 3 条推荐给主人。
export const AUTO_CANDIDATE_LIMIT = 10
export const AUTO_RECOMMEND_LIMIT = 3
const SOURCE_KEYS = ['keyword', 'following', 'homepage']

export function normalizeReadingConfig(value = {}) {
  const windows = normalizeReadingWindows(value?.windows)
  const raw = value?.autoIntervalMinutes
  const autoIntervalMinutes = raw === null || raw === undefined
    ? DEFAULT_AUTO_INTERVAL_MINUTES
    : raw === ''
      ? 0
      : Number(raw)
  if (!Number.isInteger(autoIntervalMinutes) || autoIntervalMinutes < 0 || autoIntervalMinutes > MAX_AUTO_INTERVAL_MINUTES) {
    throw new Error(`自动读取间隔必须为 0 到 ${MAX_AUTO_INTERVAL_MINUTES} 之间的整数分钟。`)
  }
  return { windows, autoIntervalMinutes }
}

export function autoEnabled(readingInput = {}) {
  const reading = normalizeReadingConfig(readingInput)
  return reading.windows.length > 0 && reading.autoIntervalMinutes > 0
}

// 记住上一次手动“获取候选”使用的关键词和来源，自动读取沿用这份配置。
export function normalizeReadingLastRead(value = {}) {
  const keyword = String(value?.keyword || '').trim().slice(0, 80)
  const raw = Array.isArray(value?.sources) ? value.sources : []
  const sources = [...new Set(raw.map((source) => String(source)).filter((source) => SOURCE_KEYS.includes(source)))]
  return { keyword, sources: sources.length ? sources : [...SOURCE_KEYS] }
}

export function autoSourceList(lastReadInput = {}) {
  const lastRead = normalizeReadingLastRead(lastReadInput)
  const usable = lastRead.sources.filter((source) => source !== 'keyword' || lastRead.keyword)
  return usable.length ? usable : ['following', 'homepage']
}

export function shouldAutoRun(readingInput = {}, lastRunAt = '', now = new Date()) {
  const reading = normalizeReadingConfig(readingInput)
  if (!reading.windows.length || reading.autoIntervalMinutes <= 0) return false
  if (!isWithinReadingWindows(reading.windows, now)) return false
  if (!lastRunAt) return true
  const last = new Date(lastRunAt)
  if (!Number.isFinite(last.getTime())) return true
  const elapsed = now.getTime() - last.getTime()
  return elapsed < 0 || elapsed >= reading.autoIntervalMinutes * 60_000
}

export function nextAutoRunAt(readingInput, lastRunAt = '', now = new Date()) {
  const reading = normalizeReadingConfig(readingInput)
  if (!reading.windows.length || reading.autoIntervalMinutes <= 0) return null
  if (!isWithinReadingWindows(reading.windows, now)) {
    const nextWindow = nextReadingWindowStart(reading.windows, now)
    return nextWindow ? nextWindow.at : null
  }
  const last = lastRunAt ? new Date(lastRunAt) : null
  const dueAt = last && Number.isFinite(last.getTime())
    ? last.getTime() + reading.autoIntervalMinutes * 60_000
    : now.getTime()
  return new Date(Math.max(dueAt, now.getTime()))
}

export function autoReportTitle(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `Whaleagent-自动-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

export function selectAutoCandidates(items, history = [], limit = AUTO_CANDIDATE_LIMIT, titleExcludes = [], options = {}) {
  const excludes = Array.isArray(titleExcludes) ? titleExcludes : []
  const { maxAgeDays = 0, now = new Date() } = options
  const analyzed = new Set(normalizeHistory(history).map((record) => record.bvid))
  const seen = new Set()
  const picked = []
  for (const item of Array.isArray(items) ? items : []) {
    const bvid = String(item?.bvid || '')
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid) || seen.has(bvid) || analyzed.has(bvid)) continue
    seen.add(bvid)
    if (excludes.length && titleExcluded(item?.title, excludes)) continue
    // 发布时间窗：只推荐最近 N 天发布的视频。取不到发布时间时不拦（见 publishedTooOld）。
    if (publishedTooOld(item, maxAgeDays, now)) continue
    picked.push(item)
  }
  // 关注动态优先：主人已经订阅这些 UP 主，先保证它们进入分析；其余来源保持原有顺序。
  const followed = picked.filter((item) => item?.followed === true)
  const others = picked.filter((item) => item?.followed !== true)
  return [...followed, ...others].slice(0, limit)
}

export function normalizeReadingState(value = {}) {
  const timestamp = typeof value?.lastRunAt === 'string' ? new Date(value.lastRunAt) : null
  return {
    version: 1,
    lastRunAt: timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : '',
    lastReport: String(value?.lastReport || '').slice(0, 120),
    lastResult: String(value?.lastResult || '').slice(0, 240),
  }
}

export async function readReadingState(statePath) {
  try {
    return normalizeReadingState(JSON.parse(await fs.readFile(statePath, 'utf8')))
  } catch {
    return normalizeReadingState({})
  }
}

export async function writeReadingState(statePath, state) {
  const normalized = normalizeReadingState(state)
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

// 一次完整的自动读取：选 10 条候选 -> 代码筛选 -> 读取资料 -> 模型选 3 条 -> 保存报告 -> 投递私信。
// 依赖全部注入，便于在测试中替换网络与模型调用。
// readHistory({ retentionDays, now }) 返回的记录已经按保留期过滤：过期记录不再参与去重，
// 但那时它们也已经离开了发布时间窗，所以不会造成重复推荐。
//
// **不再点赞**：以前这里会在报告落盘后给选中的 3 条点赞，结果主人不喜欢的视频也被点了赞。
// 现在推送只负责“告诉主人”，写操作（点赞 / 收藏）等主人在私信里明确要求后，
// 由互动回复链路按推送台账执行（见 push-log.js / interaction-reply.js）。
export async function executeReadingAuto({
  lastRead = {},
  hasApiKey = false,
  credential = null,
  account = null,
  screen = {},
  discover,
  readHistory,
  fetchVideo,
  analyze,
  saveReport,
  deliverReport = null,
  log = () => {},
  now = new Date(),
  previousState = {},
} = {}) {
  const previous = normalizeReadingState(previousState)
  const finish = (message, reportName = '') => ({
    message,
    report: reportName || previous.lastReport,
    state: normalizeReadingState({
      lastRunAt: now.toISOString(),
      lastReport: reportName || previous.lastReport,
      lastResult: message.slice(0, 240),
    }),
  })

  if (!credential) return finish('B站未登录，自动读取已跳过。')
  if (!account?.loggedIn) return finish('B站登录态无效，自动读取已跳过。')
  if (!hasApiKey) return finish('模型服务未配置，自动读取已跳过。')

  const screening = normalizeScreenConfig(screen)
  const sources = autoSourceList(lastRead)
  const keyword = sources.includes('keyword') ? normalizeReadingLastRead(lastRead).keyword : ''
  const discovered = await discover(keyword, sources)
  const maxAgeDays = readVideoAgeDays(screening.maxAgeDays)
  // 已推荐记录要活过整个发布时间窗；两个数字由这一个设置推导，用户填不错。
  const retentionDays = historyRetentionDays(maxAgeDays)
  let history = []
  try { history = await readHistory({ retentionDays, now }) }
  catch (error) { log('warn', 'reading-auto-history-unreadable', error) }
  const titleSkipped = countTitleExcluded(discovered?.items, history, screening.titleExclude)
  const ageSkipped = countAgeExcluded(discovered?.items, history, maxAgeDays, now)
  // 先把代码层硬筛后的 10 条候选交给模型，让 agent 有足够的选择空间。
  const candidates = selectAutoCandidates(discovered?.items, history, AUTO_CANDIDATE_LIMIT, screening.titleExclude, { maxAgeDays, now })
  if (!candidates.length) {
    if (titleSkipped) return finish(`候选视频都被标题排除词跳过（${titleSkipped} 条）。`)
    if (ageSkipped) return finish(`候选视频都超出了发布时间窗（${ageSkipped} 条）。`)
    return finish('没有新的未分析候选。')
  }

  const details = []
  let subtitleSkipped = 0
  for (const item of candidates) {
    try {
      const detail = await fetchVideo(item.bvid)
      if (screening.skipNoSubtitle && !detail?.subtitle) {
        subtitleSkipped += 1
        continue
      }
      // 把来源带到分析提示词里：模型需要知道哪条来自已关注的 UP 主。
      details.push({ ...detail, source: item.source || '', followed: item.followed === true })
      if (details.length >= AUTO_CANDIDATE_LIMIT) break
    } catch (error) { log('warn', 'reading-auto-video-unavailable', error) }
  }
  if (!details.length) {
    return finish(subtitleSkipped
      ? `候选视频都没有可读字幕（已跳过 ${subtitleSkipped} 条）。`
      : '候选视频资料读取失败，自动读取已跳过。')
  }

  let result = await analyze(details)
  // 只有 agent 选进报告的 3 条才算“推荐给主人”：
  // 它们会进入已推荐历史和推送台账，下一轮代码筛选据此排除；落选的候选不记历史，仍可能再次被看到。
  // 推送阶段不再点赞——写操作等主人明确要求后由互动链路执行。
  const allowed = new Set(details.map((detail) => String(detail.bvid)))
  const modelSelection = Array.isArray(result?.selectedBvids)
    ? result.selectedBvids
    : Array.isArray(result?.recommendedBvids)
      ? result.recommendedBvids
      : Array.isArray(result?.analyzedBvids) ? result.analyzedBvids : []
  const recommendedBvids = [...new Set(modelSelection.map(String))]
    .filter((bvid) => allowed.has(bvid))
    .slice(0, AUTO_RECOMMEND_LIMIT)
  if (!recommendedBvids.length) throw new Error('模型没有返回可用的推荐视频。')

  result = {
    ...result,
    recommendedBvids,
    count: recommendedBvids.length,
  }
  const screenNote = describeScreening({ titleSkipped, subtitleSkipped, ageSkipped })
  if (screenNote) result = { ...result, report: `${result.report}\n\n---\n${screenNote}\n` }

  const title = autoReportTitle(now)
  let saved = null
  for (const suffix of ['', '-2', '-3']) {
    try {
      saved = await saveReport(`${title}${suffix}`, result)
      break
    } catch (error) {
      if (!/同名报告已存在/.test(error.message) || suffix === '-3') throw error
    }
  }

  // 报告落盘成功后才投递。**不点赞**：写操作等主人明确要求再做。
  let deliveryNote = ''
  let delivery = null
  if (deliverReport && saved) {
    try {
      delivery = await deliverReport({ name: saved.name, content: result.report, count: result.count, bvids: recommendedBvids })
      if (delivery?.sent) deliveryNote = ' 已私信主人。'
    } catch (error) {
      log('warn', 'reading-auto-deliver-failed', error)
    }
  }
  return {
    ...finish(`已自动生成报告 ${saved.name}（${result.count} 条）。${deliveryNote}`, saved.name),
    recommendedBvids,
    // 私信没发出去就没有“推送台账”，主人也就无从按条要求点赞；把这一点如实回传。
    delivered: Boolean(delivery?.sent),
  }
}

