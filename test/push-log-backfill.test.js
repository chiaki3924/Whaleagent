import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPushLogFromReports, isAutoReportName, parseReportAsPush } from '../src/main/push-log.js'

const report = (name, entries) => ({
  name,
  content: `# Whaleagent 视频筛选\n\n生成时间：2026-10-25 13:55:43\n\n${entries.map(([title, bvid, score]) => `## ${title}\n\n- BV号：${bvid}\n- UP主：某UP\n- 评分：${score}/10\n- 字幕：已读取\n- 值得关注：理由\n- 视频：https://www.bilibili.com/video/${bvid}/\n`).join('\n')}`,
})

test('rebuilds one push from an automatic report using the timestamp in its name', () => {
  const parsed = parseReportAsPush(
    report('r', [['标题甲', 'BV0000000001', 8.5], ['标题乙', 'BV0000000002', 2]]).content,
    'Whaleagent-自动-20261025-135543.md',
  )
  assert.equal(parsed.report, 'Whaleagent-自动-20261025-135543.md')
  assert.deepEqual(parsed.items.map((item) => item.bvid), ['BV0000000001', 'BV0000000002'])
  assert.deepEqual(parsed.items.map((item) => item.score), [8.5, 2])
  assert.equal(parsed.items[0].title, '标题甲')
  // 文件名里的时间是本机时间，不是 UTC。
  const local = new Date(parsed.pushedAt)
  assert.equal(local.getFullYear(), 2026)
  assert.equal(local.getMonth(), 9)
  assert.equal(local.getDate(), 25)
  assert.equal(local.getHours(), 13)
  assert.equal(local.getMinutes(), 55)
  assert.equal(local.getSeconds(), 43)
})

test('ignores reports that were not produced by automatic reading', () => {
  const content = report('r', [['标题甲', 'BV0000000001', 8]]).content
  // 手动另存的报告不一定私信过主人，不能混进台账。
  assert.equal(parseReportAsPush(content, '我的报告.md'), null)
  assert.equal(parseReportAsPush(content, 'Whaleagent-自动-坏名字.md'), null)
  // 重名后缀是合法的。
  assert.ok(parseReportAsPush(content, 'Whaleagent-自动-20261025-135543-2.md'))
})

test('recognises an automatic report name with or without the .md suffix', () => {
  // listReports() 返回的是去掉后缀的名字；这里必须两种都认，
  // 否则启动回填会静默地一条都匹配不上（打包版实测踩到过）。
  assert.equal(isAutoReportName('Whaleagent-自动-20261025-135543'), true)
  assert.equal(isAutoReportName('Whaleagent-自动-20261025-135543.md'), true)
  assert.equal(isAutoReportName('Whaleagent-自动-20261025-135543-2'), true)
  assert.equal(isAutoReportName('我的手动报告'), false)
  assert.equal(isAutoReportName('Whaleagent-自动-坏名字'), false)
  assert.equal(isAutoReportName(''), false)
  assert.equal(isAutoReportName(undefined), false)
})

test('skips report blocks without a usable BV', () => {
  const content = '# Whaleagent 视频筛选\n\n## 只有标题\n\n- 评分：9/10\n'
  assert.equal(parseReportAsPush(content, 'Whaleagent-自动-20261025-135543.md'), null)
})

test('caps a rebuilt push at three videos and sorts newest first', () => {
  const log = buildPushLogFromReports([
    report('Whaleagent-自动-20261025-100000.md', [['甲', 'BV0000000001', 9], ['乙', 'BV0000000002', 8], ['丙', 'BV0000000003', 7], ['丁', 'BV0000000004', 6]]),
    report('Whaleagent-自动-20261025-120000.md', [['戊', 'BV0000000005', 9]]),
  ])
  assert.deepEqual(log.pushes.map((entry) => entry.report), [
    'Whaleagent-自动-20261025-120000.md',
    'Whaleagent-自动-20261025-100000.md',
  ])
  assert.equal(log.pushes[1].items.length, 3)
  assert.deepEqual(log.pushes[1].items.map((item) => item.bvid), ['BV0000000001', 'BV0000000002', 'BV0000000003'])
})

test('backfill works with the extension-less names listReports returns', () => {
  const log = buildPushLogFromReports([
    { name: 'Whaleagent-自动-20261025-120000', content: report('x', [['甲', 'BV0000000001', 9]]).content },
  ])
  assert.equal(log.pushes.length, 1)
  assert.equal(log.pushes[0].items[0].bvid, 'BV0000000001')
})

test('an empty or unusable report list produces an empty log', () => {
  assert.deepEqual(buildPushLogFromReports([]).pushes, [])
  assert.deepEqual(buildPushLogFromReports([{ name: 'x.md', content: '' }]).pushes, [])
  assert.deepEqual(buildPushLogFromReports(undefined).pushes, [])
})
