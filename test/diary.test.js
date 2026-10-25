import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_DIARY_RETENTION_DAYS,
  DIARY_KIND_LABELS,
  MAX_DIARY_ENTRY_CHARS,
  diaryDue,
  diaryHistoryForPrompt,
  diaryTimeReached,
  executeDiaryGeneration,
  formatDiaryFile,
  isValidDayKey,
  localDayKey,
  nextDiaryRunAt,
  normalizeDiaryConfig,
  normalizeDiaryEntry,
  normalizeDiaryState,
  parseDiarySections,
  pruneDiarySections,
  pruneDiaryText,
  readDiaryState,
  retentionCutoffDay,
  retentionWindow,
  upsertDiaryText,
  writeDiaryState,
} from '../src/main/diary.js'

const day = (year, month, date, hours = 12, minutes = 0) => new Date(year, month - 1, date, hours, minutes)

function bookText(dates) {
  return formatDiaryFile('测试日记', dates.map((date) => ({ date, content: `${date} 的正文` })))
}

function createHarness({
  publicText = '',
  privateText = '',
  config = {},
  state = {},
  hasApiKey = true,
  activity = { reports: [] },
  generate,
  readDiary,
  now = day(2026, 10, 8, 23, 5),
  trigger = 'auto',
} = {}) {
  const writes = []
  const logs = []
  const files = { public: publicText, private: privateText }
  const run = () => executeDiaryGeneration({
    config: { enabled: true, autoEnabled: true, publicEnabled: true, privateEnabled: true, time: '23:00', retentionDays: DEFAULT_DIARY_RETENTION_DAYS, ...config },
    state,
    hasApiKey,
    readDiary: readDiary || (async (kind) => files[kind]),
    writeDiary: async (kind, text) => {
      files[kind] = text
      writes.push({ kind, text })
    },
    collectActivity: async () => activity,
    generate: generate || (async () => ({ public: '今天给主人的日记。', private: '今天给自己的日记。' })),
    log: (level, event, error) => logs.push({ level, event, error }),
    now,
    trigger,
  })
  return { run, writes, logs, files }
}

test('diary config normalizes defaults and rejects invalid values', () => {
  assert.deepEqual(normalizeDiaryConfig({}), {
    enabled: true,
    autoEnabled: false,
    publicEnabled: true,
    privateEnabled: true,
    time: '23:00',
    retentionDays: DEFAULT_DIARY_RETENTION_DAYS,
  })
  assert.deepEqual(normalizeDiaryConfig({
    enabled: false,
    autoEnabled: true,
    publicEnabled: false,
    privateEnabled: true,
    time: '7:05',
    retentionDays: '30',
  }), {
    enabled: false,
    autoEnabled: true,
    publicEnabled: false,
    privateEnabled: true,
    time: '07:05',
    retentionDays: 30,
  })
  // 手改设置文件时允许省略前导零，但保存后统一补零。
  assert.equal(normalizeDiaryConfig({ time: '9:00' }).time, '09:00')
  assert.throws(() => normalizeDiaryConfig({ time: '9:0' }), /时间无效/)
  assert.throws(() => normalizeDiaryConfig({ time: '24:00' }), /时间无效/)
  assert.throws(() => normalizeDiaryConfig({ retentionDays: 0 }), /保留天数/)
  assert.throws(() => normalizeDiaryConfig({ retentionDays: 366 }), /保留天数/)
  assert.throws(() => normalizeDiaryConfig({ retentionDays: 1.5 }), /保留天数/)
  assert.throws(() => normalizeDiaryConfig({ retentionDays: 'abc' }), /保留天数/)
})

test('local day keys and the retention window keep the newest N days', () => {
  assert.equal(localDayKey(day(2026, 10, 8, 0, 5)), '2026-10-08')
  assert.equal(localDayKey('2026-10-08T23:00:00+08:00'), '2026-10-08')
  assert.equal(localDayKey('not a date'), '')
  assert.equal(isValidDayKey('2026-10-08'), true)
  assert.equal(isValidDayKey('2026-02-30'), false)
  assert.equal(isValidDayKey(''), false)
  assert.equal(retentionCutoffDay(7, day(2026, 10, 8)), '2026-10-02')
  assert.equal(retentionCutoffDay(1, day(2026, 10, 8)), '2026-10-08')
  assert.deepEqual(retentionWindow(7, day(2026, 10, 8)), { from: '2026-10-02', to: '2026-10-08' })
})

test('the eighth day removes the first day under a seven day window', () => {
  const dates = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']
  const { kept, removed } = pruneDiarySections(parseDiarySections(bookText(dates)), 7, day(2026, 10, 8))
  assert.deepEqual(removed, ['2026-10-01'])
  assert.deepEqual(kept.map((section) => section.date), [
    '2026-10-07', '2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02',
  ])
})

test('due and next run honour the clock, the daily run flag and the switches', () => {
  const auto = { enabled: true, autoEnabled: true, time: '23:00', retentionDays: 7 }
  assert.equal(diaryTimeReached('23:00', day(2026, 10, 8, 22, 59)), false)
  assert.equal(diaryTimeReached('23:00', day(2026, 10, 8, 23, 0)), true)
  assert.equal(diaryDue(auto, {}, day(2026, 10, 8, 22, 59)), false)
  assert.equal(diaryDue(auto, {}, day(2026, 10, 8, 23, 0)), true)
  assert.equal(diaryDue(auto, { lastRunDate: '2026-10-08' }, day(2026, 10, 8, 23, 30)), false)
  assert.equal(diaryDue(auto, { lastRunDate: '2026-10-07' }, day(2026, 10, 8, 23, 30)), true)
  assert.equal(diaryDue({ ...auto, autoEnabled: false }, {}, day(2026, 10, 8, 23, 30)), false)
  assert.equal(diaryDue({ ...auto, enabled: false }, {}, day(2026, 10, 8, 23, 30)), false)
  assert.equal(diaryDue({ ...auto, privateEnabled: false, publicEnabled: false }, {}, day(2026, 10, 8, 23, 30)), false)

  const before = nextDiaryRunAt(auto, {}, day(2026, 10, 8, 22, 0))
  assert.equal(before.getHours(), 23)
  assert.equal(before.getDate(), 8)
  const afterTime = nextDiaryRunAt(auto, {}, day(2026, 10, 8, 23, 30))
  assert.equal(afterTime.getTime(), day(2026, 10, 8, 23, 30).getTime())
  const nextDay = nextDiaryRunAt(auto, { lastRunDate: '2026-10-08' }, day(2026, 10, 8, 23, 30))
  assert.equal(nextDay.getDate(), 9)
  assert.equal(nextDay.getHours(), 23)
  assert.equal(nextDiaryRunAt({ ...auto, autoEnabled: false }, {}, day(2026, 10, 8, 23, 30)), null)
})

test('parses, deduplicates and formats dated diary sections', () => {
  const text = [
    '# 给主人看的日记',
    '',
    '## 2026-10-07',
    '',
    '第一次内容',
    '',
    '## 2026-10-06',
    '',
    '昨天',
    '',
    '## 2026-10-07',
    '',
    '第二次内容',
    '',
    '## 2026-02-30',
    '',
    '无效日期',
  ].join('\n')
  const sections = parseDiarySections(text)
  assert.deepEqual(sections.map((section) => section.date), ['2026-10-07', '2026-10-06'])
  assert.equal(sections[0].content, '第二次内容')
  assert.equal(sections[1].content, '昨天')
  assert.deepEqual(parseDiarySections(''), [])
  assert.deepEqual(parseDiarySections('# 空日记\n'), [])

  assert.equal(
    formatDiaryFile('标题', [{ date: '2026-10-06', content: 'B' }, { date: '2026-10-07', content: 'A' }]),
    '# 标题\n\n## 2026-10-07\n\nA\n\n## 2026-10-06\n\nB\n',
  )
})

test('pruning rewrites only when an entry falls outside the window', () => {
  const dates = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']
  const text = bookText(dates)
  const fresh = pruneDiaryText({ text, title: '测试日记', retentionDays: 7, now: day(2026, 10, 7) })
  assert.equal(fresh.removed.length, 0)
  assert.equal(fresh.text, text)

  const pruned = pruneDiaryText({ text, title: '测试日记', retentionDays: 7, now: day(2026, 10, 8) })
  assert.deepEqual(pruned.removed, ['2026-10-01'])
  assert.ok(!pruned.text.includes('2026-10-01'))
  assert.ok(pruned.text.includes('2026-10-02'))
})

test('upserting a new day prunes the oldest day and strips heading injection', () => {
  const dates = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']
  const result = upsertDiaryText({
    text: bookText(dates),
    title: '测试日记',
    date: '2026-10-08',
    content: '第一行\n## 2026-10-01\n注入的标题\n最后一行',
    retentionDays: 7,
    now: day(2026, 10, 8),
  })
  assert.deepEqual(result.removed, ['2026-10-01'])
  assert.deepEqual(result.sections.map((section) => section.date), [
    '2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02',
  ])
  const today = parseDiarySections(result.text)[0]
  assert.equal(today.content, '第一行\n注入的标题\n最后一行')

  const replaced = upsertDiaryText({
    text: result.text,
    title: '测试日记',
    date: '2026-10-08',
    content: '改过的正文',
    retentionDays: 7,
    now: day(2026, 10, 8),
  })
  assert.equal(parseDiarySections(replaced.text).length, 7)
  assert.equal(parseDiarySections(replaced.text)[0].content, '改过的正文')
  assert.throws(() => upsertDiaryText({ text: '', title: 't', date: 'bad-date', content: 'x', retentionDays: 7 }), /日期无效/)
  assert.throws(() => upsertDiaryText({ text: '', title: 't', date: '2026-10-08', content: '   ', retentionDays: 7 }), /内容为空/)
})

test('diary entries are normalized and bounded before they touch the file', () => {
  assert.equal(normalizeDiaryEntry('  正文\r\n第二行  ', '日记'), '正文\n第二行')
  assert.equal(normalizeDiaryEntry('正文\u0000带控制字符', '日记'), '正文带控制字符')
  assert.equal(normalizeDiaryEntry('正文\n## 2026-10-01\n下一段', '日记'), '正文\n下一段')
  assert.throws(() => normalizeDiaryEntry(undefined, '给主人看的日记'), /给主人看的日记内容缺失/)
  assert.throws(() => normalizeDiaryEntry('   ', '给主人看的日记'), /给主人看的日记内容为空/)
  const long = normalizeDiaryEntry('x'.repeat(MAX_DIARY_ENTRY_CHARS + 50), '日记')
  assert.equal(long.length, MAX_DIARY_ENTRY_CHARS)
  assert.ok(long.endsWith('…'))
})

test('history for the prompt stays inside the character budget', () => {
  const sections = [
    { date: '2026-10-07', content: 'a'.repeat(50) },
    { date: '2026-10-06', content: 'b'.repeat(50) },
    { date: '2026-10-05', content: 'c' },
  ]
  const history = diaryHistoryForPrompt(sections, { maxChars: 45, perEntryChars: 30 })
  assert.deepEqual(history.map((entry) => entry.date), ['2026-10-07'])
  assert.equal(history[0].content.length, 30)
  assert.ok(history[0].content.endsWith('…'))
  assert.deepEqual(diaryHistoryForPrompt([], {}), [])
  assert.deepEqual(diaryHistoryForPrompt([{ date: '2026-10-07', content: '   ' }]), [])
})

test('diary state round-trips and tolerates invalid stored values', async () => {
  assert.deepEqual(normalizeDiaryState({}), { version: 1, lastRunAt: '', lastRunDate: '', lastResult: '' })
  assert.deepEqual(normalizeDiaryState({ lastRunAt: 'bad', lastRunDate: '2026-13-40', lastResult: 'x' }), {
    version: 1,
    lastRunAt: '',
    lastRunDate: '',
    lastResult: 'x',
  })
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'whaleagent-diary-'))
  try {
    const statePath = path.join(directory, 'diary-state.json')
    assert.deepEqual(await readDiaryState(statePath), { version: 1, lastRunAt: '', lastRunDate: '', lastResult: '' })
    const written = await writeDiaryState(statePath, { lastRunAt: '2026-10-08T15:05:00.000Z', lastRunDate: '2026-10-08', lastResult: '已写好' })
    assert.deepEqual(await readDiaryState(statePath), written)
    await fs.writeFile(statePath, '{not json', 'utf8')
    assert.deepEqual(await readDiaryState(statePath), { version: 1, lastRunAt: '', lastRunDate: '', lastResult: '' })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('generation writes both books, records the run and prunes day one on day eight', async () => {
  const dates = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']
  const harness = createHarness({ publicText: bookText(dates), privateText: bookText(dates) })
  const outcome = await harness.run()
  assert.equal(outcome.failed, false)
  assert.equal(outcome.skipped, false)
  assert.deepEqual(outcome.written, ['public', 'private'])
  assert.deepEqual(outcome.removed, ['2026-10-01'])
  assert.equal(outcome.state.lastRunDate, '2026-10-08')
  assert.equal(outcome.state.lastRunAt, day(2026, 10, 8, 23, 5).toISOString())
  assert.match(outcome.message, /已写好给主人看的日记和给自己看的日记/)
  assert.match(outcome.message, /删除 2 篇/)
  assert.equal(harness.writes.length, 2)
  for (const write of harness.writes) {
    const sections = parseDiarySections(write.text)
    assert.deepEqual(sections.map((section) => section.date), [
      '2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02',
    ])
  }
  assert.equal(parseDiarySections(harness.files.public)[0].content, '今天给主人的日记。')
  assert.equal(parseDiarySections(harness.files.private)[0].content, '今天给自己的日记。')
})

test('generation skips without model, without books or with the master switch off', async () => {
  const disabled = createHarness({ config: { enabled: false } })
  const disabledOutcome = await disabled.run()
  assert.equal(disabledOutcome.skipped, true)
  assert.equal(disabledOutcome.stateChanged, false)
  assert.equal(disabled.writes.length, 0)

  const noBooks = createHarness({ config: { publicEnabled: false, privateEnabled: false } })
  assert.equal((await noBooks.run()).skipped, true)
  assert.equal(noBooks.writes.length, 0)

  const noKey = createHarness({ hasApiKey: false })
  const noKeyOutcome = await noKey.run()
  assert.equal(noKeyOutcome.skipped, true)
  assert.equal(noKeyOutcome.stateChanged, false)
  assert.equal(noKey.writes.length, 0)
})

test('a disabled book is not written but is still pruned', async () => {
  const dates = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']
  const harness = createHarness({
    publicText: bookText(dates),
    privateText: bookText(dates),
    config: { publicEnabled: false },
  })
  const outcome = await harness.run()
  assert.deepEqual(outcome.written, ['private'])
  assert.deepEqual(outcome.removed, ['2026-10-01'])
  // 两本都按固定顺序处理：公开日记只因为清理旧条目而被重写，私人日记写入了新内容。
  assert.deepEqual(harness.writes.map((write) => write.kind), ['public', 'private'])
  assert.ok(!harness.files.public.includes('2026-10-01'))
  assert.ok(!harness.files.public.includes('2026-10-08'))
})

test('a model failure is recorded and does not write files', async () => {
  const auto = createHarness({ generate: async () => { throw new Error('模型超时') } })
  const autoOutcome = await auto.run()
  assert.equal(autoOutcome.failed, true)
  assert.equal(autoOutcome.stateChanged, true)
  assert.equal(autoOutcome.state.lastRunDate, '2026-10-08')
  assert.match(autoOutcome.message, /模型超时/)
  assert.equal(auto.writes.length, 0)
  assert.ok(auto.logs.some((entry) => entry.event === 'diary-generation-failed'))

  const manual = createHarness({
    generate: async () => { throw new Error('模型超时') },
    state: { lastRunDate: '2026-10-05' },
    trigger: 'manual',
  })
  const manualOutcome = await manual.run()
  assert.equal(manualOutcome.failed, true)
  assert.equal(manualOutcome.state.lastRunDate, '2026-10-05')
})

test('a malformed model response fails without touching the diary files', async () => {
  const harness = createHarness({ generate: async () => ({ public: '只有公开日记。' }) })
  const outcome = await harness.run()
  assert.equal(outcome.failed, true)
  assert.match(outcome.message, /给自己看的日记内容缺失/)
  assert.equal(harness.writes.length, 0)
})

test('activity collection failures do not block the diary', async () => {
  const logs = []
  const outcome = await executeDiaryGeneration({
    config: { enabled: true, autoEnabled: true, publicEnabled: true, privateEnabled: true, time: '23:00', retentionDays: 7 },
    state: {},
    hasApiKey: true,
    readDiary: async () => '',
    writeDiary: async () => {},
    collectActivity: async () => { throw new Error('报告目录不可读') },
    generate: async ({ activity }) => {
      assert.deepEqual(activity, {})
      return { public: '公开', private: '私人' }
    },
    log: (level, event) => logs.push({ level, event }),
    now: day(2026, 10, 8, 23, 5),
  })
  assert.equal(outcome.failed, false)
  assert.ok(logs.some((entry) => entry.event === 'diary-activity-failed'))
})

test('a read failure aborts the generation instead of overwriting the diary', async () => {
  const harness = createHarness({
    readDiary: async () => { throw new Error('读取失败') },
  })
  await assert.rejects(() => harness.run(), /读取失败/)
  assert.equal(harness.writes.length, 0)
  assert.ok(harness.logs.some((entry) => entry.event === 'diary-read-failed'))
})

test('diary labels stay stable for the renderer and the prompt', () => {
  assert.deepEqual(DIARY_KIND_LABELS, { public: '给主人看的日记', private: '给自己看的日记' })
})