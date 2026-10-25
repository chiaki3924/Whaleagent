import test from 'node:test'
import assert from 'node:assert/strict'
import { PUSHED_DM_PATTERN, buildReportDmText, compactPushedDmText, isPushedDmText, parseReportItems, parsePushedDmText } from '../src/main/report-dm.js'

// 用真实模板生成一条推送私信，再验证它能不能被认出来、能不能被压缩成一行。
const report = `# Whaleagent 视频筛选

## 标题甲

- BV号：BV0000000001
- UP主：某UP
- 评分：8.5/10
- 字幕：已读取
- 值得关注：讲得很清楚
- 内容概述：概述一
- 视频：https://www.bilibili.com/video/BV0000000001/

## 标题乙

- BV号：BV0000000002
- UP主：另一个UP
- 评分：2/10
- 字幕：已读取
- 值得关注：一般
- 内容概述：概述二
- 视频：https://www.bilibili.com/video/BV0000000002/
`

const pushedText = buildReportDmText({
  reportName: 'Whaleagent-自动-20261025-135543.md',
  items: parseReportItems(report),
  extraLine: '这两条先看第一条。',
})

test('recognises only the template header as a push', () => {
  assert.equal(isPushedDmText(pushedText), true)
  assert.equal(isPushedDmText('主人，今天的报告好了：\n\n报告：r.md'), true)
  assert.equal(isPushedDmText('主人，今天筛出 3 条：\n\n1. 甲'), true)
  // 主人自己说的话、别人的转发，都不能被误判成推送。
  assert.equal(isPushedDmText('主人，今天我看到一个视频挺有意思'), false)
  assert.equal(isPushedDmText('今天的报告好了'), false)
  assert.equal(isPushedDmText(''), false)
  assert.match(PUSHED_DM_PATTERN.source, /主人/)
})

test('parses a pushed DM back into report name, titles, scores and BV ids', () => {
  const parsed = parsePushedDmText(pushedText)
  assert.equal(parsed.report, 'Whaleagent-自动-20261025-135543.md')
  assert.deepEqual(parsed.items.map((item) => item.bvid), ['BV0000000001', 'BV0000000002'])
  assert.deepEqual(parsed.items.map((item) => item.score), [8.5, 2])
  assert.match(parsed.items[0].title, /标题甲/)
})

test('returns null for anything that is not a push', () => {
  assert.equal(parsePushedDmText('随便一句话'), null)
  assert.equal(parsePushedDmText(''), null)
  assert.equal(parsePushedDmText(undefined), null)
})

test('compacts a 200+ character push into one short line', () => {
  const line = compactPushedDmText(pushedText)
  assert.ok(line.length < pushedText.length / 2, `line=${line.length} text=${pushedText.length}`)
  assert.match(line, /^\[推送 Whaleagent-自动-20261025-135543\.md\]/)
  assert.match(line, /标题甲/)
  assert.match(line, /8\.5分/)
  assert.match(line, /标题乙/)
  // 压缩后不再包含模板里的理由、链接和“报告：”这类流程话。
  assert.doesNotMatch(line, /https:\/\//)
  assert.doesNotMatch(line, /值得关注|讲得很清楚/)
  assert.equal(compactPushedDmText('不是推送'), '')
})

test('compaction respects the character budget', () => {
  const longTitle = '很长的标题'.repeat(60)
  const text = `主人，今天筛出 1 条：\n\n1. ${longTitle}\n9/10 · 理由\nhttps://www.bilibili.com/video/BV0000000001/\n\n报告：r.md`
  const line = compactPushedDmText(text, { maxChars: 60 })
  assert.ok(line.length <= 60, `length=${line.length}`)
  assert.match(line, /…$/)
})

test('handles a push whose items were truncated by the length limit', () => {
  // 超长时模板会丢掉理由甚至只留标题；认得出、解析得出 BV 就行。
  const text = `主人，今天筛出 1 条：\n\n1. 只有标题\n\n报告：r.md`
  const parsed = parsePushedDmText(text)
  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0].bvid, '')
  assert.equal(parsed.items[0].score, null)
  const line = compactPushedDmText(text)
  assert.match(line, /只有标题/)
})
