import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  autoEnabled,
  autoReportTitle,
  autoSourceList,
  executeReadingAuto,
  normalizeReadingConfig,
  normalizeReadingLastRead,
  normalizeReadingState,
  nextAutoRunAt,
  readReadingState,
  selectAutoCandidates,
  shouldAutoRun,
  writeReadingState,
} from '../src/main/reading-auto.js'

const localTime = (hour, minute = 0, day = 23) => new Date(2026, 9, day, hour, minute, 0)
const windows = [{ start: '09:00', end: '12:00' }]

test('reading config defaults to a 60 minute interval and normalizes windows', () => {
  assert.deepEqual(normalizeReadingConfig({}), { windows: [], autoIntervalMinutes: 60 })
  assert.deepEqual(normalizeReadingConfig({ windows, autoIntervalMinutes: '30' }), { windows, autoIntervalMinutes: 30 })
  assert.deepEqual(normalizeReadingConfig({ windows, autoIntervalMinutes: '' }), { windows, autoIntervalMinutes: 0 })
  for (const value of [-1, 1.5, 1441, 'abc']) {
    assert.throws(() => normalizeReadingConfig({ windows, autoIntervalMinutes: value }), /自动读取间隔/)
  }
  assert.throws(() => normalizeReadingConfig({ windows: [{ start: '09:00', end: '09:00' }] }), /读取时间窗/)
})

test('automatic reading needs both a window and a positive interval', () => {
  assert.equal(autoEnabled({ windows, autoIntervalMinutes: 60 }), true)
  assert.equal(autoEnabled({ windows: [], autoIntervalMinutes: 60 }), false)
  assert.equal(autoEnabled({ windows, autoIntervalMinutes: 0 }), false)
  assert.equal(autoEnabled({ windows, autoIntervalMinutes: '' }), false)
})

test('last read configuration keeps valid sources and drops unknown keys', () => {
  assert.deepEqual(normalizeReadingLastRead({}), { keyword: '', sources: ['keyword', 'following', 'homepage'] })
  assert.deepEqual(normalizeReadingLastRead({ keyword: '  AI 工具  ', sources: ['following', 'following', 'bogus'] }), { keyword: 'AI 工具', sources: ['following'] })
  assert.deepEqual(normalizeReadingLastRead({ keyword: 'x'.repeat(120) }).keyword.length, 80)
  assert.deepEqual(normalizeReadingLastRead({ sources: [] }), { keyword: '', sources: ['keyword', 'following', 'homepage'] })
})

test('automatic reading skips keyword when no keyword was searched', () => {
  assert.deepEqual(autoSourceList({ keyword: '', sources: ['keyword', 'following'] }), ['following'])
  assert.deepEqual(autoSourceList({ keyword: '猫', sources: ['keyword', 'homepage'] }), ['keyword', 'homepage'])
  assert.deepEqual(autoSourceList({ keyword: '', sources: ['keyword'] }), ['following', 'homepage'])
})

test('shouldAutoRun honors windows, interval and the previous run', () => {
  assert.equal(shouldAutoRun({ windows, autoIntervalMinutes: 60 }, '', localTime(10)), true)
  assert.equal(shouldAutoRun({ windows, autoIntervalMinutes: 60 }, '', localTime(13)), false)
  assert.equal(shouldAutoRun({ windows: [], autoIntervalMinutes: 60 }, '', localTime(10)), false)
  assert.equal(shouldAutoRun({ windows, autoIntervalMinutes: 0 }, '', localTime(10)), false)
  const lastRunAt = localTime(10).toISOString()
  assert.equal(shouldAutoRun({ windows, autoIntervalMinutes: 60 }, lastRunAt, localTime(10, 30)), false)
  assert.equal(shouldAutoRun({ windows, autoIntervalMinutes: 60 }, lastRunAt, localTime(11, 0)), true)
  assert.equal(shouldAutoRun({ windows, autoIntervalMinutes: 60 }, localTime(14).toISOString(), localTime(10)), true)
})

test('nextAutoRunAt reports when the agent will run again', () => {
  assert.equal(nextAutoRunAt({ windows: [], autoIntervalMinutes: 60 }, '', localTime(10)), null)
  assert.equal(nextAutoRunAt({ windows, autoIntervalMinutes: 0 }, '', localTime(10)), null)
  assert.equal(nextAutoRunAt({ windows, autoIntervalMinutes: 60 }, '', localTime(10)).getHours(), 10)
  assert.equal(nextAutoRunAt({ windows, autoIntervalMinutes: 60 }, localTime(10).toISOString(), localTime(10, 30)).getHours(), 11)
  assert.equal(nextAutoRunAt({ windows, autoIntervalMinutes: 60 }, '', localTime(13)).getDate(), 24)
})

test('automatic report names are safe local timestamps', () => {
  assert.equal(autoReportTitle(new Date(2026, 9, 23, 21, 30, 5)), 'Whaleagent-自动-20261023-213005')
  assert.match(autoReportTitle(), /^Whaleagent-自动-\d{8}-\d{6}$/)
})

test('automatic candidate selection skips analyzed and duplicate videos', () => {
  const items = [
    { bvid: 'BV1234567890', title: '旧视频' },
    { bvid: 'BV1234567890', title: '重复' },
    { bvid: 'invalid', title: '无效' },
    { bvid: 'BVabcdefghij', title: '新视频一' },
    { bvid: 'BV0987654321', title: '新视频二' },
    { bvid: 'BVzzzzzzzzzz', title: '新视频三' },
    { bvid: 'BVyyyyyyyyyy', title: '新视频四' },
  ]
  const history = [{ bvid: 'BV1234567890', seenAt: localTime(9).toISOString(), reports: ['旧报告.md'] }]
  assert.deepEqual(selectAutoCandidates(items, history).map((item) => item.title), ['新视频一', '新视频二', '新视频三', '新视频四'])
  assert.deepEqual(selectAutoCandidates(items, history, 1).map((item) => item.title), ['新视频一'])
  assert.deepEqual(selectAutoCandidates([], history), [])
})

test('关注动态优先进入候选，并把来源带进分析', async () => {
  const items = [
    { bvid: 'BV0000000001', title: '关键词', source: '关键词' },
    { bvid: 'BV0000000002', title: '关注一', source: '关注动态', followed: true },
    { bvid: 'BV0000000003', title: '关注二', source: '关注动态', followed: true },
    { bvid: 'BV0000000004', title: '首页', source: '首页推荐' },
  ]
  assert.deepEqual(selectAutoCandidates(items, [], 2).map((item) => item.title), ['关注一', '关注二'])
  assert.deepEqual(selectAutoCandidates(items, [], 4).map((item) => item.title), ['关注一', '关注二', '关键词', '首页'])

  const analyzeInputs = []
  const { dependencies } = autoHarness({
    discover: async () => ({ items }),
    analyze: async (details) => {
      analyzeInputs.push(details)
      return { report: '# 报告', count: details.length, analyzedBvids: details.map((detail) => detail.bvid) }
    },
  })
  await executeReadingAuto(dependencies)
  // 代码层一次取 10 条（本用例只有 4 条），关注动态排在最前面。
  assert.deepEqual(analyzeInputs[0].map((detail) => detail.bvid), ['BV0000000002', 'BV0000000003', 'BV0000000001', 'BV0000000004'])
  assert.deepEqual(analyzeInputs[0].map((detail) => detail.followed), [true, true, false, false])
  assert.deepEqual(analyzeInputs[0].map((detail) => detail.source), ['关注动态', '关注动态', '关键词', '首页推荐'])
})

test('reading state round-trips and tolerates invalid stored values', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'whaleagent-reading-'))
  try {
    const statePath = path.join(directory, 'reading-state.json')
    assert.deepEqual(await readReadingState(statePath), { version: 1, lastRunAt: '', lastReport: '', lastResult: '' })
    await writeReadingState(statePath, { lastRunAt: localTime(10).toISOString(), lastReport: 'x.md', lastResult: 'ok' })
    const stored = await readReadingState(statePath)
    assert.equal(stored.lastReport, 'x.md')
    assert.equal(stored.lastResult, 'ok')
    assert.equal(stored.lastRunAt, localTime(10).toISOString())
    assert.deepEqual(normalizeReadingState({ lastRunAt: 'not-a-date', lastReport: 42 }), { version: 1, lastRunAt: '', lastReport: '42', lastResult: '' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const autoNow = new Date(2026, 9, 23, 21, 30, 5)

function autoHarness(overrides = {}) {
  const savedReports = []
  const logs = []
  const dependencies = {
    lastRead: { keyword: '', sources: ['following', 'homepage'] },
    hasApiKey: true,
    credential: { sessdata: 'test' },
    account: { loggedIn: true, mid: '1' },
    // 既有用例关注的是读取主流程；硬筛选规则由各自的用例显式打开。
    screen: { skipNoSubtitle: false, titleExclude: [] },
    discover: async () => ({ items: [] }),
    readHistory: async () => [],
    fetchVideo: async (bvid) => ({ bvid, title: bvid, subtitle: '' }),
    analyze: async (details) => ({ report: '# 报告', count: details.length, analyzedBvids: details.map((detail) => detail.bvid) }),
    saveReport: async (title, result) => {
      savedReports.push({ title, result })
      return { name: `${title}.md` }
    },
    log: (level, event, error) => logs.push({ level, event, message: error?.message || String(error) }),
    now: autoNow,
    previousState: { lastReport: '旧报告.md' },
    ...overrides,
  }
  return { dependencies, savedReports, logs }
}

test('automatic reading stops early when prerequisites are missing', async () => {
  const cases = [
    [{ credential: null }, /B站未登录/],
    [{ account: { loggedIn: false } }, /B站登录态无效/],
    [{ hasApiKey: false }, /模型服务未配置/],
  ]
  for (const [overrides, pattern] of cases) {
    const { dependencies, savedReports } = autoHarness(overrides)
    const outcome = await executeReadingAuto(dependencies)
    assert.match(outcome.message, pattern)
    assert.equal(outcome.state.lastRunAt, autoNow.toISOString())
    assert.equal(outcome.state.lastReport, '旧报告.md')
    assert.equal(savedReports.length, 0)
  }
})

test('automatic reading reports when there is nothing new to analyze', async () => {
  const { dependencies, savedReports } = autoHarness({ discover: async () => ({ items: [{ bvid: 'BV0000000001' }] }), readHistory: async () => [{ bvid: 'BV0000000001', seenAt: autoNow.toISOString(), reports: ['x.md'] }] })
  const outcome = await executeReadingAuto(dependencies)
  assert.equal(outcome.message, '没有新的未分析候选。')
  assert.equal(outcome.state.lastReport, '旧报告.md')
  assert.equal(savedReports.length, 0)
})

test('automatic reading analyzes new candidates and saves a named report', async () => {
  const items = [{ bvid: 'BV0000000001' }, { bvid: 'BV0000000002' }, { bvid: 'BV0000000003' }]
  let discoveredWith = null
  const analyzeInputs = []
  const { dependencies, savedReports, logs } = autoHarness({
    lastRead: { keyword: ' 猫 ', sources: ['keyword', 'following'] },
    discover: async (keyword, sources) => { discoveredWith = { keyword, sources }; return { items } },
    fetchVideo: async (bvid) => {
      if (bvid === 'BV0000000002') throw new Error('视频不可用')
      return { bvid, title: bvid, subtitle: '' }
    },
    analyze: async (details) => { analyzeInputs.push(details); return { report: '# 报告', count: details.length, analyzedBvids: details.map((detail) => detail.bvid) } },
  })
  const outcome = await executeReadingAuto(dependencies)
  assert.deepEqual(discoveredWith, { keyword: '猫', sources: ['keyword', 'following'] })
  assert.deepEqual(analyzeInputs[0].map((detail) => detail.bvid), ['BV0000000001', 'BV0000000003'])
  assert.equal(savedReports.length, 1)
  assert.equal(savedReports[0].title, 'Whaleagent-自动-20261023-213005')
  assert.equal(outcome.report, 'Whaleagent-自动-20261023-213005.md')
  assert.equal(outcome.state.lastReport, 'Whaleagent-自动-20261023-213005.md')
  assert.match(outcome.message, /已自动生成报告 Whaleagent-自动-20261023-213005\.md（2 条）/)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].event, 'reading-auto-video-unavailable')
})

test('automatic reading retries the report name when it already exists', async () => {
  let attempts = 0
  const { dependencies, savedReports } = autoHarness({
    discover: async () => ({ items: [{ bvid: 'BV0000000001' }] }),
    saveReport: async (title) => {
      attempts += 1
      if (attempts === 1) throw new Error('同名报告已存在，请修改报告名称后再保存。')
      savedReports.push({ title })
      return { name: `${title}.md` }
    },
  })
  const outcome = await executeReadingAuto(dependencies)
  assert.equal(attempts, 2)
  assert.equal(savedReports[0].title, 'Whaleagent-自动-20261023-213005-2')
  assert.equal(outcome.report, 'Whaleagent-自动-20261023-213005-2.md')
})

test('automatic reading surfaces unexpected failures to the caller', async () => {
  const { dependencies } = autoHarness({
    discover: async () => ({ items: [{ bvid: 'BV0000000001' }] }),
    analyze: async () => { throw new Error('模型返回格式错误') },
  })
  await assert.rejects(() => executeReadingAuto(dependencies), /模型返回格式错误/)
})

test('candidate selection applies title exclusions before the limit', () => {
  const items = [
    { bvid: 'BV0000000001', title: '【广告】某工具' },
    { bvid: 'BV0000000002', title: '正经教程' },
    { bvid: 'BV0000000003', title: '恰饭推荐' },
  ]
  assert.deepEqual(selectAutoCandidates(items, [], 3, ['广告', '恰饭']).map((item) => item.bvid), ['BV0000000002'])
  assert.deepEqual(selectAutoCandidates(items, [], 1, []).map((item) => item.bvid), ['BV0000000001'])
})

const ageNow = new Date('2026-10-25T12:00:00Z')
const publishedDaysAgo = (days) => new Date(ageNow.getTime() - days * 86_400_000).toISOString()

test('candidate selection drops videos published outside the age window', () => {
  const items = [
    { bvid: 'BV0000000001', title: '太旧', publishedAt: publishedDaysAgo(20) },
    { bvid: 'BV0000000002', title: '刚发', publishedAt: publishedDaysAgo(1) },
    { bvid: 'BV0000000003', title: '没有发布时间' },
    { bvid: 'BV0000000004', title: '边界内', publishedAt: publishedDaysAgo(6) },
  ]
  assert.deepEqual(
    selectAutoCandidates(items, [], 5, [], { maxAgeDays: 7, now: ageNow }).map((item) => item.bvid),
    ['BV0000000002', 'BV0000000003', 'BV0000000004'],
  )
  // 0 = 不限：太旧的也放行。
  assert.equal(selectAutoCandidates(items, [], 5, [], { maxAgeDays: 0, now: ageNow }).length, 4)
  // 不传 options 时保持旧行为（不按发布时间过滤）。
  assert.equal(selectAutoCandidates(items, [], 5, []).length, 4)
})

test('automatic reading passes the retention window to history and records only the agent-picked video', async () => {
  const items = [
    { bvid: 'BV0000000001', title: '刚发', publishedAt: publishedDaysAgo(1) },
    { bvid: 'BV0000000002', title: '太旧', publishedAt: publishedDaysAgo(30) },
  ]
  const historyCalls = []
  const savedReports = []
  const { dependencies } = autoHarness({
    screen: { skipNoSubtitle: false, titleExclude: [], maxAgeDays: 7 },
    now: ageNow,
    discover: async () => ({ items }),
    readHistory: async (options) => { historyCalls.push(options); return [] },
    // 模型只推荐其中一条；落选的那条不能进历史，否则“只看过一眼”也被当成已推荐。
    analyze: async (details) => ({ report: '# 报告', count: 1, selectedBvids: [details[0].bvid] }),
    saveReport: async (title, result) => { savedReports.push({ title, result }); return { name: `${title}.md` } },
  })
  const outcome = await executeReadingAuto(dependencies)
  assert.equal(historyCalls.length, 1)
  assert.deepEqual(historyCalls[0].retentionDays, 8)
  assert.equal(historyCalls[0].now, ageNow)
  assert.equal(savedReports.length, 1)
  assert.deepEqual(savedReports[0].result.recommendedBvids, ['BV0000000001'])
  assert.equal(savedReports[0].result.handledBvids, undefined)
  assert.match(savedReports[0].result.report, /因超出发布时间窗跳过 1 条/)
  assert.match(outcome.message, /（1 条）/)
})

test('automatic reading explains when every candidate is too old', async () => {
  const { dependencies, savedReports } = autoHarness({
    screen: { skipNoSubtitle: false, titleExclude: [], maxAgeDays: 3 },
    now: ageNow,
    discover: async () => ({ items: [
      { bvid: 'BV0000000001', title: '旧一', publishedAt: publishedDaysAgo(10) },
      { bvid: 'BV0000000002', title: '旧二', publishedAt: publishedDaysAgo(11) },
    ] }),
  })
  const outcome = await executeReadingAuto(dependencies)
  assert.equal(savedReports.length, 0)
  assert.equal(outcome.message, '候选视频都超出了发布时间窗（2 条）。')
})

test('automatic reading drops title-excluded videos before fetching them', async () => {
  const fetched = []
  const items = [
    { bvid: 'BV0000000001', title: '【广告】某工具' },
    { bvid: 'BV0000000002', title: '正经教程' },
    { bvid: 'BV0000000003', title: '恰饭推荐' },
  ]
  const { dependencies, savedReports } = autoHarness({
    screen: { skipNoSubtitle: false, titleExclude: ['广告', '恰饭'] },
    discover: async () => ({ items }),
    fetchVideo: async (bvid) => { fetched.push(bvid); return { bvid, title: bvid, subtitle: '有字幕' } },
  })
  const outcome = await executeReadingAuto(dependencies)
  assert.deepEqual(fetched, ['BV0000000002'])
  assert.equal(savedReports.length, 1)
  assert.match(savedReports[0].result.report, /筛选说明：因标题排除跳过 2 条。/)
  assert.match(outcome.message, /（1 条）/)
})

test('automatic reading skips videos without readable subtitles and keeps fetching', async () => {
  const items = ['BV0000000001', 'BV0000000002', 'BV0000000003', 'BV0000000004'].map((bvid) => ({ bvid, title: bvid }))
  const fetched = []
  const analyzeInputs = []
  const { dependencies, savedReports } = autoHarness({
    screen: { skipNoSubtitle: true, titleExclude: [] },
    discover: async () => ({ items }),
    fetchVideo: async (bvid) => {
      fetched.push(bvid)
      return { bvid, title: bvid, subtitle: bvid === 'BV0000000003' ? '' : '字幕原文' }
    },
    analyze: async (details) => {
      analyzeInputs.push(details.map((detail) => detail.bvid))
      return { report: '# 报告', count: details.length, analyzedBvids: details.map((detail) => detail.bvid) }
    },
  })
  const outcome = await executeReadingAuto(dependencies)
  assert.deepEqual(analyzeInputs[0], ['BV0000000001', 'BV0000000002', 'BV0000000004'])
  assert.equal(fetched.length, 4)
  assert.match(savedReports[0].result.report, /筛选说明：因无字幕跳过 1 条。/)
  assert.match(outcome.message, /（3 条）/)
})

test('automatic reading stops before the model when every candidate lacks subtitles', async () => {
  let analyzed = false
  const { dependencies, savedReports } = autoHarness({
    screen: { skipNoSubtitle: true, titleExclude: [] },
    discover: async () => ({ items: [{ bvid: 'BV0000000001' }, { bvid: 'BV0000000002' }] }),
    fetchVideo: async (bvid) => ({ bvid, title: bvid, subtitle: '' }),
    analyze: async () => { analyzed = true; return { report: '', count: 0, analyzedBvids: [] } },
  })
  const outcome = await executeReadingAuto(dependencies)
  assert.equal(analyzed, false)
  assert.equal(savedReports.length, 0)
  assert.match(outcome.message, /都没有可读字幕（已跳过 2 条）/)
})

test('automatic reading hands ten candidates to the agent, delivers the three picks, and never likes them', async () => {
  const items = Array.from({ length: 12 }, (_, index) => ({ bvid: `BV${String(index).padStart(10, '0')}`, title: `候选${index}` }))
  const fetched = []
  const analyzeInputs = []
  const liked = []
  const deliveries = []
  const { dependencies, savedReports } = autoHarness({
    discover: async () => ({ items }),
    fetchVideo: async (bvid) => { fetched.push(bvid); return { bvid, title: bvid, subtitle: '字幕原文' } },
    analyze: async (details) => {
      analyzeInputs.push(details.map((detail) => detail.bvid))
      // 故意打乱顺序，证明报告/历史都按 agent 返回的推荐顺序，且只取 3 条。
      return { report: '# 报告', count: 3, selectedBvids: [details[2].bvid, details[0].bvid, details[1].bvid] }
    },
    // 即使调用方还传了 likeVideo，推送阶段也不允许点赞（主人不喜欢也会被点赞的问题）。
    likeVideo: async (bvid) => { liked.push(bvid); return { liked: true, bvid } },
    deliverReport: async (payload) => { deliveries.push(payload); return { sent: true } },
  })
  const outcome = await executeReadingAuto(dependencies)
  assert.equal(fetched.length, 10)
  assert.equal(analyzeInputs[0].length, 10)
  assert.deepEqual(liked, [])
  assert.deepEqual(savedReports[0].result.recommendedBvids, ['BV0000000002', 'BV0000000000', 'BV0000000001'])
  assert.equal(savedReports[0].result.likedBvids, undefined)
  assert.equal(savedReports[0].result.count, 3)
  assert.doesNotMatch(outcome.message, /点赞/)
  assert.match(outcome.message, /已私信主人/)
  assert.deepEqual(outcome.recommendedBvids, ['BV0000000002', 'BV0000000000', 'BV0000000001'])
  assert.equal(outcome.delivered, true)
  // 投递时把 BV 一并交给调用方，供推送台账登记。
  assert.deepEqual(deliveries[0].bvids, ['BV0000000002', 'BV0000000000', 'BV0000000001'])
})

test('automatic reading still saves the report when delivery fails', async () => {
  const items = [{ bvid: 'BV0000000001' }, { bvid: 'BV0000000002' }, { bvid: 'BV0000000003' }]
  const { dependencies, savedReports, logs } = autoHarness({
    discover: async () => ({ items }),
    analyze: async (details) => ({ report: '# 报告', count: 3, selectedBvids: details.map((detail) => detail.bvid) }),
    deliverReport: async () => { throw new Error('私信接口风控') },
  })
  const outcome = await executeReadingAuto(dependencies)
  assert.equal(savedReports.length, 1)
  assert.equal(outcome.delivered, false)
  assert.doesNotMatch(outcome.message, /已私信主人/)
  assert.ok(logs.some((entry) => entry.event === 'reading-auto-deliver-failed'))
})

test('automatic reading stops before saving when the agent selects nothing', async () => {
  const { dependencies, savedReports } = autoHarness({
    discover: async () => ({ items: [{ bvid: 'BV0000000001' }] }),
    analyze: async () => ({ report: '# 报告', count: 0, selectedBvids: [] }),
  })
  await assert.rejects(() => executeReadingAuto(dependencies), /没有返回可用的推荐视频/)
  assert.equal(savedReports.length, 0)
})

test('automatic reading notifies the delivery hook after saving a report', async () => {
  const deliveries = []
  const { dependencies } = autoHarness({
    discover: async () => ({ items: [{ bvid: 'BV0000000001' }] }),
    deliverReport: async (payload) => { deliveries.push(payload); return { sent: true } },
  })
  const outcome = await executeReadingAuto(dependencies)
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].name, 'Whaleagent-自动-20261023-213005.md')
  assert.match(deliveries[0].content, /# 报告/)
  assert.match(outcome.message, /已私信主人/)
})

test('automatic reading keeps the saved report when delivery fails', async () => {
  const { dependencies, logs } = autoHarness({
    discover: async () => ({ items: [{ bvid: 'BV0000000001' }] }),
    deliverReport: async () => { throw new Error('私信接口失败') },
  })
  const outcome = await executeReadingAuto(dependencies)
  assert.match(outcome.message, /已自动生成报告/)
  assert.doesNotMatch(outcome.message, /已私信主人/)
  assert.ok(logs.some((entry) => entry.event === 'reading-auto-deliver-failed'))
})
