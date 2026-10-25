import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TITLE_EXCLUDE,
  DEFAULT_VIDEO_AGE_DAYS,
  HISTORY_RETENTION_BUFFER_DAYS,
  MAX_VIDEO_AGE_DAYS,
  TITLE_EXCLUDE_MAX_CHARS,
  countAgeExcluded,
  countTitleExcluded,
  describeScreening,
  describeVideoAgeWindow,
  historyRetentionDays,
  normalizeScreenConfig,
  normalizeTitleExclude,
  normalizeVideoAgeDays,
  publishedTimestamp,
  publishedTooOld,
  readScreenConfig,
  readVideoAgeDays,
  titleExcludeText,
  titleExcluded,
} from '../src/main/screening.js'

test('title exclude words split on Chinese and English commas', () => {
  assert.deepEqual(normalizeTitleExclude('广告, 恰饭，搬运 ,, 广告'), ['广告', '恰饭', '搬运'])
  assert.deepEqual(normalizeTitleExclude('  '), [])
  assert.deepEqual(normalizeTitleExclude(null), DEFAULT_TITLE_EXCLUDE)
  assert.deepEqual(normalizeTitleExclude(['广告', '恰饭']), ['广告', '恰饭'])
  assert.equal(titleExcludeText(['广告', '恰饭']), '广告，恰饭')
})

test('title excludes default to the built-in clickbait list unless explicitly cleared', () => {
  assert.deepEqual(DEFAULT_TITLE_EXCLUDE, ['666', '炸裂', '外网', '热议', '为什么', '为何', '？'])
  assert.deepEqual(normalizeTitleExclude(undefined), DEFAULT_TITLE_EXCLUDE)
  assert.deepEqual(normalizeScreenConfig({}).titleExclude, DEFAULT_TITLE_EXCLUDE)
  assert.deepEqual(normalizeScreenConfig({ titleExclude: [] }).titleExclude, [])
  assert.deepEqual(normalizeScreenConfig({ titleExclude: '' }).titleExclude, [])
  assert.deepEqual(readScreenConfig({}).titleExclude, DEFAULT_TITLE_EXCLUDE)
  // 旧版 0.6.0 曾把空列表写进配置，没有“用户主动改过”标记时迁移回默认词。
  assert.deepEqual(readScreenConfig({ titleExclude: [] }).titleExclude, DEFAULT_TITLE_EXCLUDE)
  assert.deepEqual(readScreenConfig({ titleExclude: '' }).titleExclude, DEFAULT_TITLE_EXCLUDE)
  assert.deepEqual(readScreenConfig({ titleExclude: [], titleExcludeCustomized: true }).titleExclude, [])
  assert.deepEqual(readScreenConfig({ titleExclude: '', titleExcludeCustomized: true }).titleExclude, [])
  assert.deepEqual(readScreenConfig({ titleExclude: ['广告'], titleExcludeCustomized: false }).titleExclude, ['广告'])
})

test('title exclude words are case-insensitive and bounded', () => {
  assert.deepEqual(normalizeTitleExclude('AD，ad，Ad'), ['AD'])
  assert.equal(normalizeTitleExclude('a'.repeat(TITLE_EXCLUDE_MAX_CHARS)).length, 1)
  assert.throws(() => normalizeTitleExclude('a'.repeat(TITLE_EXCLUDE_MAX_CHARS + 1)), /标题排除词最多 100 个字符/)
  const many = Array.from({ length: 25 }, (_, index) => `词${index}`).join('，')
  assert.equal(normalizeTitleExclude(many).length, 20)
})

test('screening defaults to skipping videos without readable subtitles', () => {
  assert.deepEqual(normalizeScreenConfig({}), { skipNoSubtitle: true, titleExclude: DEFAULT_TITLE_EXCLUDE, titleExcludeCustomized: false, maxAgeDays: 7 })
  assert.deepEqual(normalizeScreenConfig({ skipNoSubtitle: false }), { skipNoSubtitle: false, titleExclude: DEFAULT_TITLE_EXCLUDE, titleExcludeCustomized: false, maxAgeDays: 7 })
  assert.deepEqual(normalizeScreenConfig({ skipNoSubtitle: 'false' }), { skipNoSubtitle: true, titleExclude: DEFAULT_TITLE_EXCLUDE, titleExcludeCustomized: false, maxAgeDays: 7 })
})

test('reading an overlong saved list truncates whole words instead of failing', () => {
  const long = `${'甲'.repeat(60)}，${'乙'.repeat(60)}`
  const terms = readScreenConfig({ titleExclude: long }).titleExclude
  assert.deepEqual(terms, ['甲'.repeat(60)])
  assert.doesNotThrow(() => readScreenConfig({ titleExclude: 'x'.repeat(500) }))
})

test('title matching is a plain case-insensitive substring check', () => {
  assert.equal(titleExcluded('【广告】别点', ['广告']), true)
  assert.equal(titleExcluded('ai 工具推荐', ['AI']), true)
  assert.equal(titleExcluded('普通视频', ['广告']), false)
  assert.equal(titleExcluded('', ['广告']), false)
  assert.equal(titleExcluded('普通视频', []), false)
})

test('title-excluded counting ignores broken, duplicate and already analyzed ids', () => {
  const items = [
    { bvid: 'BV0000000001', title: '【广告】一' },
    { bvid: 'BV0000000001', title: '【广告】重复' },
    { bvid: 'BV0000000002', title: '【广告】已分析' },
    { bvid: 'bad-id', title: '【广告】坏编号' },
    { bvid: 'BV0000000003', title: '普通视频' },
  ]
  assert.equal(countTitleExcluded(items, [{ bvid: 'BV0000000002' }], ['广告']), 1)
  assert.equal(countTitleExcluded(items, [], ['广告']), 2)
  assert.equal(countTitleExcluded(items, [], []), 0)
})

test('screening notes describe both skip reasons', () => {
  assert.equal(describeScreening({}), '')
  assert.equal(describeScreening({ subtitleSkipped: 2 }), '筛选说明：因无字幕跳过 2 条。')
  assert.equal(describeScreening({ titleSkipped: 1, subtitleSkipped: 2 }), '筛选说明：因无字幕跳过 2 条；因标题排除跳过 1 条。')
  assert.equal(describeScreening({ ageSkipped: 3 }), '筛选说明：因超出发布时间窗跳过 3 条。')
  assert.equal(describeScreening({ titleSkipped: 1, subtitleSkipped: 2, ageSkipped: 3 }), '筛选说明：因无字幕跳过 2 条；因标题排除跳过 1 条；因超出发布时间窗跳过 3 条。')
})

const ageNow = new Date('2026-10-25T12:00:00Z')
const daysAgo = (days) => new Date(ageNow.getTime() - days * 86_400_000).toISOString()

test('video age window defaults to 7 days and accepts 0 as unlimited', () => {
  assert.equal(DEFAULT_VIDEO_AGE_DAYS, 7)
  assert.equal(normalizeVideoAgeDays(undefined), 7)
  assert.equal(normalizeVideoAgeDays(''), 7)
  assert.equal(normalizeVideoAgeDays(0), 0)
  assert.equal(normalizeVideoAgeDays('3'), 3)
  assert.equal(normalizeVideoAgeDays(MAX_VIDEO_AGE_DAYS), MAX_VIDEO_AGE_DAYS)
  for (const value of [-1, 1.5, MAX_VIDEO_AGE_DAYS + 1, 'abc']) {
    assert.throws(() => normalizeVideoAgeDays(value), /发布时间窗/)
    // 读旧配置时坏值退回默认，不让整个读取失败。
    assert.equal(readVideoAgeDays(value), DEFAULT_VIDEO_AGE_DAYS)
  }
  assert.equal(normalizeScreenConfig({}).maxAgeDays, 7)
  assert.equal(normalizeScreenConfig({ maxAgeDays: 0 }).maxAgeDays, 0)
  assert.equal(readScreenConfig({ maxAgeDays: 2 }).maxAgeDays, 2)
})

test('history retention always outlives the publish window', () => {
  // 记录必须比窗口多活一天，否则窗口还没过、记录已被删，同一条视频会被再推一次。
  assert.equal(HISTORY_RETENTION_BUFFER_DAYS, 1)
  assert.equal(historyRetentionDays(7), 8)
  assert.equal(historyRetentionDays(1), 2)
  assert.equal(historyRetentionDays(30), 31)
  // 关闭发布时间窗时不能按时间删记录，否则去重就失效了。
  assert.equal(historyRetentionDays(0), 0)
  for (const days of [1, 3, 7, 14, 30]) assert.ok(historyRetentionDays(days) > days)
})

test('publish window keeps recent videos and drops older ones', () => {
  assert.equal(publishedTimestamp({ publishedAt: daysAgo(1) }), ageNow.getTime() - 86_400_000)
  assert.ok(Number.isNaN(publishedTimestamp({})))
  assert.ok(Number.isNaN(publishedTimestamp({ publishedAt: 'not-a-date' })))
  assert.equal(publishedTooOld({ publishedAt: daysAgo(3) }, 7, ageNow), false)
  assert.equal(publishedTooOld({ publishedAt: daysAgo(8) }, 7, ageNow), true)
  assert.equal(publishedTooOld({ publishedAt: daysAgo(8) }, 0, ageNow), false)
  // 取不到发布时间时不拦：宁可多看一条，也不要因为缺字段把所有候选都丢掉。
  assert.equal(publishedTooOld({}, 7, ageNow), false)
  assert.equal(publishedTooOld({ publishedAt: 'not-a-date' }, 7, ageNow), false)
})

test('age-excluded counting ignores broken, duplicate and already handled ids', () => {
  const items = [
    { bvid: 'BV0000000001', title: '旧一', publishedAt: daysAgo(20) },
    { bvid: 'BV0000000001', title: '旧一重复', publishedAt: daysAgo(20) },
    { bvid: 'BV0000000002', title: '旧二但已推荐', publishedAt: daysAgo(20) },
    { bvid: 'bad-id', title: '坏编号', publishedAt: daysAgo(20) },
    { bvid: 'BV0000000003', title: '新', publishedAt: daysAgo(1) },
  ]
  assert.equal(countAgeExcluded(items, [{ bvid: 'BV0000000002' }], 7, ageNow), 1)
  assert.equal(countAgeExcluded(items, [], 7, ageNow), 2)
  assert.equal(countAgeExcluded(items, [], 0, ageNow), 0)
  assert.equal(describeVideoAgeWindow(7), '只看最近 7 天发布的视频')
  assert.equal(describeVideoAgeWindow(0), '不限发布时间')
})
