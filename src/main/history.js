import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const MAX_RECORDS = 5000
const MAX_REPORT_REFS = 20
const BV_PATTERN = /^BV[0-9A-Za-z]{10}$/
const DAY_MS = 86_400_000

// 记录过期只按“推荐时间”算，不看视频发布时间：
// 保留期由发布时间窗推导（窗 + 1 天），因此一条视频在被推荐后、直到它离开发布时间窗之后
// 都还在记录里 ⇒ 同一条视频不会被推荐第二次。
// retentionDays <= 0 表示不按时间清理（发布时间窗关闭时）。
export function pruneHistoryByAge(records, retentionDays, now = new Date()) {
  const list = Array.isArray(records) ? records : []
  const days = Number(retentionDays)
  if (!Number.isFinite(days) || days <= 0) return list
  const current = new Date(now).getTime()
  if (!Number.isFinite(current)) return list
  const cutoff = current - days * DAY_MS
  return list.filter((record) => {
    const seen = new Date(record?.seenAt).getTime()
    // 时间坏了就保留：宁可多留一条记录，也不要误删后重复推荐。
    if (!Number.isFinite(seen)) return true
    return seen >= cutoff
  })
}

export function normalizeHistory(data, { retentionDays = 0, now = new Date() } = {}) {
  const records = Array.isArray(data) ? data : Array.isArray(data?.records) ? data.records : []
  const normalized = new Map()
  for (const record of records) {
    const bvid = String(record?.bvid || '')
    const seenAt = new Date(record?.seenAt)
    if (!BV_PATTERN.test(bvid) || !Number.isFinite(seenAt.getTime())) continue
    const reports = Array.isArray(record.reports)
      ? [...new Set(record.reports.map((name) => String(name).slice(0, 100)).filter(Boolean))].slice(-MAX_REPORT_REFS)
      : []
    const previous = normalized.get(bvid)
    if (!previous || seenAt > new Date(previous.seenAt)) normalized.set(bvid, { bvid, seenAt: seenAt.toISOString(), reports })
  }
  const kept = pruneHistoryByAge([...normalized.values()], retentionDays, now)
  return kept.sort((a, b) => a.seenAt.localeCompare(b.seenAt)).slice(-MAX_RECORDS)
}

export function decorateWithHistory(items, history, options = {}) {
  const byId = new Map(normalizeHistory(history, options).map((record) => [record.bvid, record]))
  return items.map((item) => {
    const record = byId.get(item.bvid)
    return record
      ? { ...item, seenBefore: true, lastAnalyzedAt: record.seenAt }
      : { ...item, seenBefore: false, lastAnalyzedAt: '' }
  })
}

export async function readHistory(historyPath, options = {}) {
  try { return normalizeHistory(JSON.parse(await fs.readFile(historyPath, 'utf8')), options) }
  catch (error) { if (error.code === 'ENOENT') return []; throw new Error('本地已分析记录损坏或无法读取；为避免覆盖，未写入历史。') }
}

async function writeHistoryFile(historyPath, records) {
  await fs.mkdir(path.dirname(historyPath), { recursive: true })
  const tempPath = `${historyPath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tempPath, JSON.stringify({ version: 1, records }, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await fs.rename(tempPath, historyPath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
  return records
}

// 按保留期真正删掉过期记录并落盘（readHistory 只过滤不写盘）。
// 返回 { kept, removed }；文件不存在时什么也不做。
export async function pruneHistoryFile(historyPath, { retentionDays = 0, now = new Date() } = {}) {
  let raw
  try { raw = JSON.parse(await fs.readFile(historyPath, 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return { kept: 0, removed: 0 }
    // 记录损坏时不要覆盖它：保留原文件，交给人工处理。
    throw new Error('本地已分析记录损坏或无法读取；为避免覆盖，未写入历史。')
  }
  const before = normalizeHistory(raw, { now })
  const after = normalizeHistory(raw, { retentionDays, now })
  if (after.length === before.length) return { kept: after.length, removed: 0 }
  await writeHistoryFile(historyPath, after)
  return { kept: after.length, removed: before.length - after.length }
}

export async function recordAnalyzed(historyPath, bvids, reportName, now = new Date(), options = {}) {
  if (!Array.isArray(bvids) || bvids.some((bvid) => !BV_PATTERN.test(String(bvid)))) throw new Error('已分析记录包含无效 BV 号。')
  const seenAt = new Date(now)
  if (!Number.isFinite(seenAt.getTime())) throw new Error('已分析记录时间无效。')
  const history = await readHistory(historyPath, { ...options, now: seenAt })
  const records = new Map(history.map((record) => [record.bvid, record]))
  for (const bvid of new Set(bvids.map(String))) {
    const previous = records.get(bvid)
    const reports = previous?.reports ?? []
    const cleanReport = String(reportName || '').slice(0, 100)
    records.set(bvid, {
      bvid,
      seenAt: seenAt.toISOString(),
      reports: cleanReport ? [...new Set([...reports, cleanReport])].slice(-MAX_REPORT_REFS) : reports,
    })
  }
  // 写入时就顺手删掉过期记录，文件不会无限增长。
  const normalized = normalizeHistory({ records: [...records.values()] }, { ...options, now: seenAt })
  return writeHistoryFile(historyPath, normalized)
}
