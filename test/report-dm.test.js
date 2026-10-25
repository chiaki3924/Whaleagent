import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  REPORT_DM_DAILY_LIMIT,
  REPORT_DM_MAX_CHARS,
  buildReportDmText,
  executeReportDm,
  localDay,
  normalizeReportDmConfig,
  normalizeReportDmState,
  parseReportItems,
  readReportDmState,
  reportDmRemainingToday,
  writeReportDmState,
} from '../src/main/report-dm.js'

const now = new Date(2026, 9, 23, 21, 30, 5)

const sampleReport = `# Whaleagent 视频筛选

生成时间：2026-10-23 21:30:05

## \\#标题一

- BV号：BV0000000001
- UP主：某个UP
- 评分：8/10
- 字幕：已读取
- 值得关注：讲得很清楚
- 内容概述：概述一
- 视频：https://www.bilibili.com/video/BV0000000001/

## 标题二

- BV号：BV0000000002
- UP主：另一个UP
- 评分：6/10
- 字幕：无可用字幕（判断置信度较低）
- 值得关注：可以一看
- 内容概述：概述二
- 视频：https://www.bilibili.com/video/BV0000000002/
`

test('report DM config is off unless explicitly enabled', () => {
  assert.deepEqual(normalizeReportDmConfig({}), { enabled: false })
  assert.deepEqual(normalizeReportDmConfig({ enabled: 'true' }), { enabled: false })
  assert.deepEqual(normalizeReportDmConfig({ enabled: true }), { enabled: true })
})

test('report DM state is normalized and persisted atomically', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'whaleagent-report-dm-'))
  const statePath = path.join(directory, 'report-dm-state.json')
  try {
    assert.deepEqual(normalizeReportDmState({}), { version: 1, lastSentAt: '', lastReport: '', lastResult: '', daily: { date: '', count: 0 } })
    assert.deepEqual(normalizeReportDmState({ lastSentAt: 'nope', daily: { date: '2026-13-40', count: -1 } }).daily, { date: '', count: 0 })
    assert.equal((await readReportDmState(statePath)).lastSentAt, '')

    await writeReportDmState(statePath, {
      lastSentAt: now.toISOString(),
      lastReport: 'r.md',
      lastResult: '已私信主人（10 字）。',
      daily: { date: '2026-10-23', count: 2 },
    })
    const stored = await readReportDmState(statePath)
    assert.equal(stored.lastSentAt, now.toISOString())
    assert.equal(stored.lastReport, 'r.md')
    assert.deepEqual(stored.daily, { date: '2026-10-23', count: 2 })

    await writeFile(statePath, '{', 'utf8')
    assert.deepEqual(await readReportDmState(statePath), normalizeReportDmState({}))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('report parsing extracts escaped titles, scores, reasons and links', () => {
  const items = parseReportItems(sampleReport)
  assert.equal(items.length, 2)
  assert.deepEqual(items[0], {
    title: '#标题一',
    score: 8,
    reason: '讲得很清楚',
    url: 'https://www.bilibili.com/video/BV0000000001/',
  })
  assert.equal(items[1].score, 6)
  assert.equal(parseReportItems('随便写的报告').length, 0)
})

test('report DM text keeps the template readable inside the length limit', () => {
  const items = parseReportItems(sampleReport)
  const text = buildReportDmText({ reportName: 'Whaleagent-自动-20261023-213005.md', items, extraLine: '这条我劝你先看第一个。' })
  assert.ok(text.length <= REPORT_DM_MAX_CHARS)
  assert.match(text, /^主人，今天筛出 2 条：/)
  assert.match(text, /报告：Whaleagent-自动-20261023-213005\.md/)
  assert.match(text, /https:\/\/www\.bilibili\.com\/video\/BV0000000001\//)
  assert.match(text, /这条我劝你先看第一个。/)

  const empty = buildReportDmText({ reportName: 'r.md', items: [], extraLine: '' })
  assert.equal(empty, '主人，今天的报告好了：\n\n报告：r.md')
})

test('report DM text trims items or reasons instead of overflowing', () => {
  const longItem = (index) => ({
    title: `第${index}条${'很长的标题'.repeat(20)}`,
    score: 9,
    reason: '理由'.repeat(100),
    url: `https://www.bilibili.com/video/BV000000000${index}/`,
  })
  const text = buildReportDmText({ reportName: `${'长'.repeat(100)}.md`, items: [longItem(1), longItem(2), longItem(3)], extraLine: '补一句。'.repeat(30) })
  assert.ok(text.length <= REPORT_DM_MAX_CHARS, `length=${text.length}`)
  assert.match(text, /^主人，今天筛出 3 条：/)
  assert.match(text, /报告：/)
  assert.match(text, /补一句。/)
})

test('report DM eligibility returns clear reasons without sending anything', async () => {
  const base = {
    reportName: 'r.md',
    content: sampleReport,
    persona: { ownerUid: '42' },
    config: { enabled: true },
    state: {},
    credential: { bili_jct: 'x' },
    account: { loggedIn: true, mid: '7' },
    now,
    sendMessage: async () => { throw new Error('不该被调用') },
  }
  const cases = [
    [{ config: { enabled: false } }, /未开启/],
    [{ persona: {} }, /主人UID/],
    [{ credential: null }, /未登录/],
    [{ account: { loggedIn: false } }, /登录态无效/],
    [{ persona: { ownerUid: '7' } }, /不能私信自己/],
    [{ state: { daily: { date: localDay(now), count: REPORT_DM_DAILY_LIMIT } } }, /每日上限/],
  ]
  for (const [overrides, pattern] of cases) {
    const outcome = await executeReportDm({ ...base, ...overrides })
    assert.equal(outcome.sent, false)
    assert.equal(outcome.skipped, true)
    assert.match(outcome.message, pattern)
    assert.equal(outcome.stateChanged, false)
  }
})

test('report DM sends the template plus the model line and counts the day', async () => {
  const sent = []
  const outcome = await executeReportDm({
    reportName: 'Whaleagent-自动-20261023-213005.md',
    content: sampleReport,
    persona: { ownerUid: '42', ownerTitle: '主人' },
    config: { enabled: true },
    state: { daily: { date: localDay(now), count: 1 }, lastReport: '旧.md' },
    credential: { bili_jct: 'x' },
    account: { loggedIn: true, mid: '7' },
    now,
    generateLine: async ({ items }) => { assert.equal(items.length, 2); return '第二条有点意思。' },
    sendMessage: async (uid, text) => { sent.push({ uid, text }); return { sent: true, id: 'msg-key' } },
  })
  assert.equal(outcome.sent, true)
  assert.equal(outcome.skipped, false)
  assert.equal(outcome.stateChanged, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].uid, '42')
  assert.match(sent[0].text, /第二条有点意思。/)
  assert.match(sent[0].text, /BV0000000001/)
  assert.equal(outcome.state.daily.count, 2)
  assert.equal(outcome.state.lastReport, 'Whaleagent-自动-20261023-213005.md')
  assert.equal(outcome.state.lastSentAt, now.toISOString())
  assert.equal(reportDmRemainingToday(outcome.state, now), REPORT_DM_DAILY_LIMIT - 2)
  // 推送台账要用：只带真正进了正文的条数，且标题是完整标题（不是私信里的截断版）。
  assert.deepEqual(outcome.pushItems.map((item) => item.bvid), ['BV0000000001', 'BV0000000002'])
  assert.deepEqual(outcome.pushItems.map((item) => item.score), [8, 6])
})

test('a push records only the videos that actually made it into the message', async () => {
  // 超长报告会被压缩到 1–2 条；台账不能把没发出去的条目标成“已推送”。
  const longItem = (index) => ({
    title: `第${index}条${'很长的标题'.repeat(20)}`,
    score: 9,
    reason: '理由'.repeat(100),
    url: `https://www.bilibili.com/video/BV000000000${index}/`,
  })
  const content = `# Whaleagent 视频筛选\n\n${[1, 2, 3].map((index) => `## 标题${index}\n\n- BV号：BV000000000${index}\n- 评分：9/10\n- 值得关注：理由\n- 视频：https://www.bilibili.com/video/BV000000000${index}/\n`).join('\n')}`
  let sentText = ''
  const outcome = await executeReportDm({
    reportName: 'r.md',
    content,
    persona: { ownerUid: '42' },
    config: { enabled: true },
    state: {},
    credential: { bili_jct: 'x' },
    account: { loggedIn: true, mid: '7' },
    now,
    sendMessage: async (uid, text) => { sentText = text; return { sent: true } },
  })
  assert.equal(outcome.sent, true)
  const sentCount = (sentText.match(/^\d+\. /gm) || []).length
  assert.equal(outcome.pushItems.length, sentCount)
  assert.ok(outcome.pushItems.length >= 1)
  // 每条台账条目都必须真出现在私信正文里。
  for (const item of outcome.pushItems) assert.match(sentText, new RegExp(item.bvid))
  // 长标题的工具函数仍在用（避免未使用告警式的无用导出）。
  assert.ok(longItem(1).title.length > 32)
})

test('a failed send records no push at all', async () => {
  const outcome = await executeReportDm({
    reportName: 'r.md',
    content: sampleReport,
    persona: { ownerUid: '42' },
    config: { enabled: true },
    state: {},
    credential: { bili_jct: 'x' },
    account: { loggedIn: true, mid: '7' },
    now,
    sendMessage: async () => { throw new Error('风控') },
  })
  assert.equal(outcome.sent, false)
  assert.equal(outcome.pushItems, undefined)
})

test('a failing model line never blocks the template DM', async () => {
  const logs = []
  let sentText = ''
  const outcome = await executeReportDm({
    reportName: 'r.md',
    content: sampleReport,
    persona: { ownerUid: '42' },
    config: { enabled: true },
    state: {},
    credential: { bili_jct: 'x' },
    account: { loggedIn: true, mid: '7' },
    now,
    generateLine: async () => { throw new Error('模型超时') },
    sendMessage: async (uid, text) => { sentText = text; return { sent: true, id: 'k' } },
    log: (level, event, error) => logs.push({ level, event, message: error?.message }),
  })
  assert.equal(outcome.sent, true)
  assert.match(sentText, /报告：r\.md/)
  assert.equal(logs[0].event, 'report-dm-line-failed')
})

test('a failed send is reported and remembered without counting the day', async () => {
  const outcome = await executeReportDm({
    reportName: 'r.md',
    content: sampleReport,
    persona: { ownerUid: '42' },
    config: { enabled: true },
    state: { daily: { date: localDay(now), count: 1 } },
    credential: { bili_jct: 'x' },
    account: { loggedIn: true, mid: '7' },
    now,
    sendMessage: async () => { throw new Error('B站私信超过长度限制（code 21007），已取消发送。') },
  })
  assert.equal(outcome.sent, false)
  assert.equal(outcome.skipped, false)
  assert.equal(outcome.state.daily.count, 1)
  assert.match(outcome.state.lastResult, /发送失败：B站私信超过长度限制/)
  assert.match(outcome.message, /报告已保存，但私信发送失败/)
})
