import test from 'node:test'
import assert from 'node:assert/strict'
import { processInteractionCycle, runInteractionCycle } from '../src/main/interaction-worker.js'
import { normalizeInteractionSettings } from '../src/main/interaction-state.js'

const now = new Date('2026-10-19T10:00:00')
const settings = { commentsEnabled: true, dmEnabled: true, intervalMinutes: 5, dailyLimit: 5, scheduleWindows: [{ start: '09:00', end: '18:00' }] }
const baseState = () => ({ version: 1, initialized: true, seenIds: [], enabledSources: ['comments', 'dm'], daily: { date: '2026-10-19', count: 0 }, pausedReason: '' })
const makeEvent = (id = 'event-1') => ({ id, source: 'comments', kind: 'reply', senderId: '42', timestamp: 1, text: '你好' })
const deps = (overrides = {}) => ({
  settings,
  previousState: baseState(),
  events: [makeEvent()],
  now,
  getNow: () => now,
  generateReply: async () => '谢谢提醒',
  sendComment: async () => ({ sent: true }),
  sendDm: async () => ({ sent: true }),
  saveState: async () => {},
  ...overrides,
})

test('fetches only independently enabled sources and keeps received messages read-only during polling', async () => {
  const calls = []
  const result = await runInteractionCycle({
    settings: { ...settings, commentsEnabled: false, dmEnabled: true },
    previousState: { ...baseState(), initialized: false },
    fetchCommentTriggers: async () => { calls.push('comments'); return { events: [] } },
    fetchDmTriggers: async () => { calls.push('dm'); return { events: [], diagnostics: { listedSessions: 2, interceptedSessions: 1 } } },
    generateReply: async () => { throw new Error('baseline must not generate') },
    sendComment: async () => { throw new Error('baseline must not send') },
    sendDm: async () => { throw new Error('baseline must not send') },
    saveState: async () => {},
    now,
  })
  assert.deepEqual(calls, ['dm'])
  assert.equal(result.baseline, true)
  assert.equal(result.sent, 0)
  assert.deepEqual(result.diagnostics, { listedSessions: 2, interceptedSessions: 1 })
})
test('establishes first-run baseline without sending any old event', async () => {
  let sends = 0
  const result = await processInteractionCycle(deps({ previousState: { ...baseState(), initialized: false }, sendComment: async () => { sends += 1 } }))
  assert.equal(result.baseline, true)
  assert.equal(sends, 0)
  assert.deepEqual(result.state.seenIds, ['event-1'])
})

test('honours disabled switch, empty schedule, zero interval and zero daily quota', async () => {
  const variants = [
    { ...settings, commentsEnabled: false, dmEnabled: false },
    { ...settings, scheduleWindows: [] },
    { ...settings, intervalMinutes: 0 },
    { ...settings, dailyLimit: 0 },
  ]
  for (const variant of variants) {
    let sends = 0
    const result = await processInteractionCycle(deps({ settings: variant, sendComment: async () => { sends += 1 } }))
    assert.equal(result.sent, 0)
    assert.equal(sends, 0)
  }
})

test('sends at most one queued reply per poll and reserves one global quota slot', async () => {
  let sends = 0
  let stored = baseState()
  const result = await processInteractionCycle(deps({
    events: [makeEvent('event-1'), makeEvent('event-2')],
    saveState: async (state) => { stored = state },
    sendComment: async () => { sends += 1 },
  }))
  assert.equal(result.sent, 1)
  assert.equal(sends, 1)
  assert.equal(stored.daily.count, 1)
  assert.ok(stored.seenIds.includes('event-1'))
})

test('prioritizes unread DMs over comments and reports the actual sent source', async () => {
  let sent = ''
  const result = await processInteractionCycle(deps({
    events: [{ ...makeEvent('comment-old'), timestamp: 1 }, { ...makeEvent('dm-new'), source: 'dm', kind: 'message', timestamp: 999 }],
    sendDm: async () => { sent = 'dm' },
    sendComment: async () => { sent = 'comments' },
  }))
  assert.equal(sent, 'dm')
  assert.equal(result.sent, 1)
  assert.deepEqual(result.sentSources, ['dm'])
})
test('does not count a rejected send as sent and records a send-stage failure', async () => {
  let stored = baseState()
  const logs = []
  const result = await processInteractionCycle(deps({
    saveState: async (state) => { stored = structuredClone(state) },
    sendComment: async () => { throw new Error('B站发送失败（code -403）') },
    log: (...entry) => logs.push(entry),
  }))
  assert.equal(result.sent, 0)
  assert.equal(result.skipped, 1)
  assert.equal(stored.daily.count, 0)
  assert.ok(stored.seenIds.includes('event-1'))
  assert.ok(logs.some(([event]) => event === 'interaction-send-failed'))
})
test('re-checks enabled generation after model response before sending', async () => {
  let current = true
  let sends = 0
  await processInteractionCycle(deps({
    isCurrent: () => current,
    generateReply: async () => { current = false; return '回复' },
    sendComment: async () => { sends += 1 },
  }))
  assert.equal(sends, 0)
})

test('pauses all future interaction after a risk challenge', async () => {
  let stored = baseState()
  const result = await processInteractionCycle(deps({
    saveState: async (state) => { stored = state },
    sendComment: async () => { throw new Error('验证码验证要求') },
  }))
  assert.equal(result.paused, true)
  assert.match(stored.pausedReason, /风控或验证码/)
})

test('sends the picture after the text and counts it as a second send', async () => {
  const order = []
  let stored = baseState()
  const dmEvent = { id: 'dm-1', source: 'dm', kind: 'message', senderId: '42', timestamp: 1, text: '晚安', target: { talkerId: '42' } }
  const result = await processInteractionCycle(deps({
    events: [dmEvent],
    generateReply: async () => ({ reply: '晚安好梦', image: { id: '2', fileName: '晚安.jpg', path: '/images/晚安.jpg', description: '晚安' } }),
    sendDm: async () => { order.push('text'); return { sent: true, id: 'k1' } },
    sendDmImage: async (event, image) => { order.push(`image:${image.id}`); return { sent: true, id: 'k2' } },
    saveState: async (state) => { stored = state },
  }))
  assert.deepEqual(order, ['text', 'image:2'])
  // 文字 + 图片是两条消息，额度必须算两次。
  assert.equal(result.sent, 2)
  assert.equal(stored.daily.count, 2)
  assert.deepEqual(result.sentSources, ['dm', 'dm:image'])
})

test('keeps the text delivery when the picture fails to send', async () => {
  const dmEvent = { id: 'dm-1', source: 'dm', kind: 'message', senderId: '42', timestamp: 1, text: '晚安', target: { talkerId: '42' } }
  const result = await processInteractionCycle(deps({
    events: [dmEvent],
    generateReply: async () => ({ reply: '晚安好梦', image: { id: '1', fileName: '晚安.jpg', path: '/images/晚安.jpg', description: '晚安' } }),
    sendDm: async () => ({ sent: true, id: 'k1' }),
    sendDmImage: async () => { throw new Error('B站不接受这张图片（code 21037）') },
  }))
  // 文字已经送达，不能因为图片失败就报成完全失败。
  assert.equal(result.sent, 1)
  assert.deepEqual(result.sentSources, ['dm'])
  assert.equal(result.skipped, 0)
  assert.match(result.failureReasons.join(' '), /配图发送：.*21037/)
})

test('does not send a picture when the daily quota is already used up', async () => {
  let imageSends = 0
  const dmEvent = { id: 'dm-1', source: 'dm', kind: 'message', senderId: '42', timestamp: 1, text: '晚安', target: { talkerId: '42' } }
  const result = await processInteractionCycle(deps({
    settings: { ...settings, dailyLimit: 1 },
    events: [dmEvent],
    generateReply: async () => ({ reply: '晚安好梦', image: { id: '1', fileName: 'a.jpg', path: '/i/a.jpg', description: 'a' } }),
    sendDm: async () => ({ sent: true }),
    sendDmImage: async () => { imageSends += 1; return { sent: true } },
  }))
  // 上限是 1：文字用掉了唯一名额，图片必须放弃。
  assert.equal(result.sent, 1)
  assert.equal(imageSends, 0)
})

test('never sends a picture for a comment reply', async () => {
  let imageSends = 0
  const result = await processInteractionCycle(deps({
    generateReply: async () => ({ reply: '谢谢', image: { id: '1', fileName: 'a.jpg', path: '/i/a.jpg', description: 'a' } }),
    sendDmImage: async () => { imageSends += 1; return { sent: true } },
  }))
  assert.equal(result.sent, 1)
  assert.equal(imageSends, 0)
})

test('pauses the whole cycle when the picture send hits a risk challenge', async () => {
  const dmEvent = { id: 'dm-1', source: 'dm', kind: 'message', senderId: '42', timestamp: 1, text: '晚安', target: { talkerId: '42' } }
  const result = await processInteractionCycle(deps({
    events: [dmEvent],
    generateReply: async () => ({ reply: '晚安好梦', image: { id: '1', fileName: 'a.jpg', path: '/i/a.jpg', description: 'a' } }),
    sendDm: async () => ({ sent: true }),
    sendDmImage: async () => { throw new Error('B站触发风控或验证（code -509），互动已暂停。') },
  }))
  assert.equal(result.paused, true)
  assert.match(result.state.pausedReason, /风控/)
})

test('still accepts a plain string reply from the model', async () => {
  const result = await processInteractionCycle(deps({ generateReply: async () => '谢谢提醒' }))
  assert.equal(result.sent, 1)
})

test('retains safe defaults with both listeners and sending disabled', () => {
  assert.deepEqual(normalizeInteractionSettings({}), {
    commentsEnabled: false,
    dmEnabled: false,
    intervalMinutes: 0,
    dailyLimit: 0,
    scheduleWindows: [],
  })
})
