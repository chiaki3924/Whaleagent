import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { decorateWithHistory, normalizeHistory, pruneHistoryByAge, pruneHistoryFile, readHistory, recordAnalyzed } from '../src/main/history.js'

const BV1 = 'BV1234567890'
const BV2 = 'BVabcdefghij'

test('decorates search items without filtering previously analyzed items', () => {
  const decorated = decorateWithHistory([
    { bvid: BV1, title: 'seen' },
    { bvid: BV2, title: 'new' },
  ], [{ bvid: BV1, seenAt: '2026-01-01T00:00:00.000Z', reports: ['r1'] }])
  assert.equal(decorated.length, 2)
  assert.equal(decorated[0].seenBefore, true)
  assert.equal(decorated[1].seenBefore, false)
})

test('normalizes invalid entries and keeps history bounded to unique BV ids', () => {
  const normalized = normalizeHistory({ records: [
    { bvid: BV1, seenAt: '2026-01-01T00:00:00Z', reports: ['one'] },
    { bvid: BV1, seenAt: '2026-01-02T00:00:00Z', reports: ['two'] },
    { bvid: '../outside', seenAt: '2026-01-03T00:00:00Z' },
    { bvid: BV2, seenAt: 'invalid' },
  ] })
  assert.equal(normalized.length, 1)
  assert.equal(normalized[0].seenAt, '2026-01-02T00:00:00.000Z')
})

test('records analyzed BV ids locally with report references and can reload them', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whaleagent-history-'))
  const file = path.join(dir, 'analyzed-videos.json')
  try {
    await recordAnalyzed(file, [BV1, BV2, BV1], 'report-one', new Date('2026-02-01T00:00:00Z'))
    const history = await readHistory(file)
    assert.equal(history.length, 2)
    assert.deepEqual(history.find((entry) => entry.bvid === BV1).reports, ['report-one'])
    await recordAnalyzed(file, [BV1], 'report-two', new Date('2026-02-02T00:00:00Z'))
    const updated = await readHistory(file)
    assert.deepEqual(updated.find((entry) => entry.bvid === BV1).reports, ['report-one', 'report-two'])
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('does not overwrite corrupt history and rejects invalid BVIDs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whaleagent-history-'))
  const file = path.join(dir, 'analyzed-videos.json')
  try {
    await fs.writeFile(file, '{broken')
    await assert.rejects(recordAnalyzed(file, [BV1], 'report'), /已分析记录损坏或无法读取/)
    assert.equal(await fs.readFile(file, 'utf8'), '{broken')
    await assert.rejects(recordAnalyzed(path.join(dir, 'new.json'), ['../outside'], 'report'), /无效 BV 号/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

const now = new Date('2026-10-25T12:00:00Z')
const daysAgo = (days) => new Date(now.getTime() - days * 86_400_000).toISOString()

test('history records expire once they fall outside the retention window', () => {
  const records = [
    { bvid: BV1, seenAt: daysAgo(1), reports: [] },
    { bvid: BV2, seenAt: daysAgo(9), reports: [] },
  ]
  assert.deepEqual(pruneHistoryByAge(records, 8, now).map((record) => record.bvid), [BV1])
  assert.deepEqual(pruneHistoryByAge(records, 0, now).map((record) => record.bvid), [BV1, BV2])
  // 坏时间不删：宁可多留一条记录，也不要误删后重复推荐。
  assert.equal(pruneHistoryByAge([{ bvid: BV1, seenAt: 'bad' }], 1, now).length, 1)
})

test('reading history with a retention window hides expired records', () => {
  const normalized = normalizeHistory({ records: [
    { bvid: BV1, seenAt: daysAgo(2), reports: ['r1'] },
    { bvid: BV2, seenAt: daysAgo(30), reports: ['r2'] },
  ] }, { retentionDays: 8, now })
  assert.deepEqual(normalized.map((record) => record.bvid), [BV1])
  // 不传保留期时保持旧行为：全部保留。
  assert.equal(normalizeHistory({ records: [
    { bvid: BV1, seenAt: daysAgo(2) },
    { bvid: BV2, seenAt: daysAgo(30) },
  ] }).length, 2)
})

test('pruning the history file actually deletes expired records on disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whaleagent-history-'))
  const file = path.join(dir, 'analyzed-videos.json')
  try {
    await fs.writeFile(file, JSON.stringify({ version: 1, records: [
      { bvid: BV1, seenAt: daysAgo(1), reports: [] },
      { bvid: BV2, seenAt: daysAgo(20), reports: [] },
    ] }))
    assert.deepEqual(await pruneHistoryFile(file, { retentionDays: 8, now }), { kept: 1, removed: 1 })
    assert.deepEqual((await readHistory(file)).map((record) => record.bvid), [BV1])
    // 没有过期记录时不重复写盘。
    assert.deepEqual(await pruneHistoryFile(file, { retentionDays: 8, now }), { kept: 1, removed: 0 })
    // 文件不存在时安静返回。
    assert.deepEqual(await pruneHistoryFile(path.join(dir, 'missing.json'), { retentionDays: 8, now }), { kept: 0, removed: 0 })
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('recording an analysis also drops expired records in the same write', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whaleagent-history-'))
  const file = path.join(dir, 'analyzed-videos.json')
  try {
    await fs.writeFile(file, JSON.stringify({ version: 1, records: [{ bvid: BV1, seenAt: daysAgo(20), reports: ['old.md'] }] }))
    const saved = await recordAnalyzed(file, [BV2], 'new.md', now, { retentionDays: 8 })
    assert.deepEqual(saved.map((record) => record.bvid), [BV2])
    assert.deepEqual((await readHistory(file)).map((record) => record.bvid), [BV2])
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
