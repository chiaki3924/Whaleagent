import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ACTIONS_PER_REPLY, describeActionOutcome, executeRequestedActions, normalizeRequestedActions } from '../src/main/interaction-actions.js'

const now = new Date('2026-10-25T12:00:00Z')
const bvid = (index) => `BV${String(index).padStart(10, '0')}`
const pushLog = (items) => ({
  version: 1,
  pushes: [{ report: 'r', pushedAt: now.toISOString(), items }],
})
const pushed = (index, actions = {}) => ({ bvid: bvid(index), title: `视频${index}`, score: 8, actions })

test('normalizes both action shapes and dedupes them', () => {
  assert.deepEqual(normalizeRequestedActions([
    { bvid: bvid(1), like: 1, favorite: 1 },
    { bvid: bvid(2), type: 'like' },
  ]), [
    { bvid: bvid(1), type: 'like' },
    { bvid: bvid(1), type: 'favorite' },
    { bvid: bvid(2), type: 'like' },
  ])
  // 重复项只留一条，非法 BV 与非 0/1 的值都被丢掉。
  assert.deepEqual(normalizeRequestedActions([
    { bvid: bvid(1), like: 1 },
    { bvid: bvid(1), like: 1 },
    { bvid: 'bad', like: 1 },
    { bvid: bvid(3), like: 0 },
  ]), [{ bvid: bvid(1), type: 'like' }])
  assert.deepEqual(normalizeRequestedActions(undefined), [])
})

test('caps the number of actions per reply', () => {
  const many = Array.from({ length: 10 }, (_, index) => ({ bvid: bvid(index), like: 1 }))
  assert.equal(normalizeRequestedActions(many).length, MAX_ACTIONS_PER_REPLY)
})

test('executes a like and a favorite only for videos in the push log', async () => {
  const liked = []
  const favorited = []
  const recorded = []
  const outcome = await executeRequestedActions({
    actions: [{ bvid: bvid(1), type: 'like' }, { bvid: bvid(2), type: 'favorite' }],
    pushLog: pushLog([pushed(1), pushed(2)]),
    like: async (id) => { liked.push(id) },
    favorite: async (id) => { favorited.push(id) },
    recordAction: async (entry) => { recorded.push(`${entry.action}:${entry.bvid}`) },
    now,
  })
  assert.deepEqual(liked, [bvid(1)])
  assert.deepEqual(favorited, [bvid(2)])
  assert.deepEqual(recorded, [`like:${bvid(1)}`, `favorite:${bvid(2)}`])
  assert.equal(outcome.done.length, 2)
  assert.equal(outcome.skipped.length, 0)
  assert.match(describeActionOutcome(outcome), /已点赞、收藏 2 条/)
})

test('refuses to act on a video the owner was never sent', async () => {
  let calls = 0
  const logs = []
  const outcome = await executeRequestedActions({
    actions: [{ bvid: bvid(9), type: 'like' }],
    pushLog: pushLog([pushed(1)]),
    like: async () => { calls += 1 },
    log: (...entry) => logs.push(entry),
  })
  assert.equal(calls, 0)
  assert.deepEqual(outcome.skipped, [{ bvid: bvid(9), type: 'like', reason: 'not-pushed' }])
  assert.ok(logs.some(([level, event]) => level === 'warn' && event === 'interaction-action-skipped'))
  assert.match(describeActionOutcome(outcome), /不在最近推送里/)
})

test('skips an action that was already done instead of repeating it', async () => {
  let calls = 0
  const outcome = await executeRequestedActions({
    actions: [{ bvid: bvid(1), type: 'like' }],
    pushLog: pushLog([pushed(1, { like: now.toISOString() })]),
    like: async () => { calls += 1 },
  })
  assert.equal(calls, 0)
  assert.deepEqual(outcome.skipped, [{ bvid: bvid(1), type: 'like', reason: 'already-done' }])
})

test('a failed action does not block the others and is reported', async () => {
  const outcome = await executeRequestedActions({
    actions: [
      { bvid: bvid(1), type: 'like' },
      { bvid: bvid(2), type: 'like' },
    ],
    pushLog: pushLog([pushed(1), pushed(2)]),
    like: async (id) => { if (id === bvid(1)) throw new Error('点赞接口风控') },
  })
  assert.deepEqual(outcome.done.map((entry) => entry.bvid), [bvid(2)])
  assert.equal(outcome.failed.length, 1)
  assert.match(outcome.failed[0].reason, /风控/)
  assert.match(describeActionOutcome(outcome), /1 条操作失败/)
})

test('a failing log write never undoes a completed action', async () => {
  let liked = 0
  const logs = []
  const outcome = await executeRequestedActions({
    actions: [{ bvid: bvid(1), type: 'like' }],
    pushLog: pushLog([pushed(1)]),
    like: async () => { liked += 1 },
    recordAction: async () => { throw new Error('disk full') },
    log: (...entry) => logs.push(entry),
  })
  assert.equal(liked, 1)
  assert.equal(outcome.done.length, 1)
  assert.ok(logs.some(([, event]) => event === 'interaction-action-log-failed'))
})

test('skips unsupported action types when no runner is injected', async () => {
  const outcome = await executeRequestedActions({
    actions: [{ bvid: bvid(1), type: 'favorite' }],
    pushLog: pushLog([pushed(1)]),
    like: async () => {},
  })
  assert.deepEqual(outcome.skipped, [{ bvid: bvid(1), type: 'favorite', reason: 'unsupported' }])
  assert.equal(describeActionOutcome(outcome), '')
})
