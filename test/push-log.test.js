import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildPushedVideoPayload,
  describePushLog,
  normalizePushLog,
  readPushLog,
  recentPushedVideos,
  recordPush,
  recordPushAction,
  resolvePushedVideo,
} from '../src/main/push-log.js'

const now = new Date('2026-10-25T12:00:00Z')
const bvid = (index) => `BV${String(index).padStart(10, '0')}`
const item = (index, extra = {}) => ({ bvid: bvid(index), title: `视频${index}`, score: 8, ...extra })

// 每个用例建一个临时目录，用完删掉：测试跑几百次也不会在 %TEMP% 里堆垃圾。
const tempDirs = []
test.after(async () => {
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true })
})

async function tempLogPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whaleagent-push-'))
  tempDirs.push(dir)
  return path.join(dir, 'pushed-videos.json')
}

test('records a push and reads it back newest first', async () => {
  const logPath = await tempLogPath()
  await recordPush(logPath, { report: 'r1', items: [item(1), item(2), item(3)], now })
  await recordPush(logPath, { report: 'r2', items: [item(4)], now: new Date('2026-10-25T13:00:00Z') })
  const log = await readPushLog(logPath)
  assert.equal(log.pushes.length, 2)
  assert.equal(log.pushes[0].report, 'r2')
  assert.deepEqual(log.pushes[0].items.map((entry) => entry.bvid), [bvid(4)])
  assert.deepEqual(log.pushes[1].items.map((entry) => entry.bvid), [bvid(1), bvid(2), bvid(3)])
})

test('drops items without a valid BV and caps each push at three videos', async () => {
  const logPath = await tempLogPath()
  const outcome = await recordPush(logPath, {
    report: 'r',
    items: [{ title: '没有 BV' }, item(1), item(1), item(2), item(3), item(4)],
    now,
  })
  assert.equal(outcome.count, 3)
  assert.deepEqual(outcome.log.pushes[0].items.map((entry) => entry.bvid), [bvid(1), bvid(2), bvid(3)])
})

test('a push without any usable video writes nothing', async () => {
  const logPath = await tempLogPath()
  const outcome = await recordPush(logPath, { report: 'r', items: [{ title: '无 BV' }], now })
  assert.equal(outcome.recorded, false)
  assert.equal(outcome.log.pushes.length, 0)
})

test('a missing or corrupt log is treated as empty instead of breaking polling', async () => {
  const logPath = await tempLogPath()
  assert.deepEqual((await readPushLog(logPath)).pushes, [])
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  await fs.writeFile(logPath, '{ not json', 'utf8')
  assert.deepEqual((await readPushLog(logPath)).pushes, [])
})

test('records a like once and keeps the first timestamp', async () => {
  const logPath = await tempLogPath()
  await recordPush(logPath, { report: 'r', items: [item(1), item(2)], now })
  const first = await recordPushAction(logPath, { bvid: bvid(1), action: 'like', now })
  assert.equal(first.recorded, true)
  const later = await recordPushAction(logPath, { bvid: bvid(1), action: 'like', now: new Date('2026-10-25T18:00:00Z') })
  const entry = later.log.pushes[0].items.find((entry) => entry.bvid === bvid(1))
  assert.equal(entry.actions.like, first.log.pushes[0].items[0].actions.like)
  // 另一个动作互不影响。
  const favorite = await recordPushAction(logPath, { bvid: bvid(2), action: 'favorite', now })
  assert.ok(favorite.log.pushes[0].items[1].actions.favorite)
  assert.equal(favorite.log.pushes[0].items[1].actions.like, undefined)
})

test('records nothing for an action on a video that was never pushed', async () => {
  const logPath = await tempLogPath()
  await recordPush(logPath, { report: 'r', items: [item(1)], now })
  const outcome = await recordPushAction(logPath, { bvid: bvid(9), action: 'like', now })
  assert.equal(outcome.recorded, false)
})

test('rejects invalid action input', async () => {
  const logPath = await tempLogPath()
  await assert.rejects(recordPushAction(logPath, { bvid: 'nope', action: 'like', now }), /BV 号无效/)
  await assert.rejects(recordPushAction(logPath, { bvid: bvid(1), action: 'coin', now }), /动作类型无效/)
})

test('exposes only recent videos to the model and flattens across pushes', async () => {
  const logPath = await tempLogPath()
  await recordPush(logPath, { report: 'old', items: [item(1), item(2)], now: new Date('2026-10-24T12:00:00Z') })
  await recordPush(logPath, { report: 'new', items: [item(3), item(4)], now })
  const log = await readPushLog(logPath)
  const payload = buildPushedVideoPayload(log)
  // 新推送在前，且默认只给最近几条。
  assert.deepEqual(payload.map((entry) => entry.bvid), [bvid(3), bvid(4), bvid(1), bvid(2)])
  assert.equal(payload[0].index, 1)
  assert.equal(payload[0].liked, false)
  assert.match(payload[0].pushedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  const limited = buildPushedVideoPayload(log, { limit: 2 })
  assert.deepEqual(limited.map((entry) => entry.bvid), [bvid(3), bvid(4)])
  assert.equal(recentPushedVideos(log).length, 4)
  // limit 为 0 或非法时给空列表，而不是把全部旧推送都放出去。
  assert.deepEqual(buildPushedVideoPayload(log, { limit: 0 }), [])
})

test('resolves a pushed video for action validation and rejects anything else', async () => {
  const logPath = await tempLogPath()
  await recordPush(logPath, { report: 'r', items: [item(1)], now })
  const log = await readPushLog(logPath)
  assert.equal(resolvePushedVideo(log, bvid(1)).bvid, bvid(1))
  // 没推送过的视频、格式错误的 BV、以及超出 limit 的旧推送都不能被操作。
  assert.equal(resolvePushedVideo(log, bvid(2)), null)
  assert.equal(resolvePushedVideo(log, 'BV-not-a-bv'), null)
  assert.equal(resolvePushedVideo(log, bvid(1), { limit: 0 }), null)
})

test('prunes pushes outside the retention window', () => {
  const log = normalizePushLog({
    pushes: [
      { report: 'old', pushedAt: '2026-01-01T00:00:00Z', items: [item(1)] },
      { report: 'new', pushedAt: '2026-10-25T00:00:00Z', items: [item(2)] },
    ],
  }, { retentionDays: 30, now })
  assert.deepEqual(log.pushes.map((entry) => entry.report), ['new'])
})

test('describes the log with counts only, never titles', async () => {
  const logPath = await tempLogPath()
  assert.equal(describePushLog({ pushes: [] }), '无推送记录')
  await recordPush(logPath, { report: 'r', items: [item(1), item(2)], now })
  const described = describePushLog(await readPushLog(logPath))
  assert.match(described, /1 次推送 \/ 2 条视频/)
  assert.doesNotMatch(described, /视频1|视频2/)
})
