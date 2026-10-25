import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTEXT_MAX_CHARS,
  CONTEXT_MAX_ITEMS,
  CONTEXT_MAX_ITEM_CHARS,
  CONTEXT_SPEAKER_OTHER,
  CONTEXT_SPEAKER_SELF,
  describeInteractionContext,
  normalizeContextEntry,
  normalizeInteractionContext,
} from '../src/main/interaction-context.js'

test('normalizes a context entry and drops empty text', () => {
  assert.deepEqual(normalizeContextEntry({ speaker: 'self', text: '  我之前说的  ', timestamp: 5 }), {
    speaker: CONTEXT_SPEAKER_SELF, speakerId: '', name: '', text: '我之前说的', images: [], timestamp: 5,
  })
  assert.equal(normalizeContextEntry({ speaker: 'self', text: '   ' }), null)
  assert.equal(normalizeContextEntry(null), null)
  assert.equal(normalizeContextEntry({ text: 'x'.repeat(CONTEXT_MAX_ITEM_CHARS + 50) }).text.length, CONTEXT_MAX_ITEM_CHARS)
})

test('defaults an unknown or missing speaker to the other party', () => {
  assert.equal(normalizeContextEntry({ text: '你好' }).speaker, CONTEXT_SPEAKER_OTHER)
  assert.equal(normalizeContextEntry({ speaker: 'robot', text: '你好' }).speaker, CONTEXT_SPEAKER_OTHER)
})

test('keeps context in chronological order regardless of input order', () => {
  const context = normalizeInteractionContext([
    { speaker: 'other', text: '第三句', timestamp: 30 },
    { speaker: 'self', text: '第一句', timestamp: 10 },
    { speaker: 'other', text: '第二句', timestamp: 20 },
  ])
  assert.deepEqual(context.map((entry) => entry.text), ['第一句', '第二句', '第三句'])
  assert.deepEqual(context.map((entry) => entry.speaker), ['self', 'other', 'other'])
})

test('caps the context at the newest entries', () => {
  const items = Array.from({ length: CONTEXT_MAX_ITEMS + 5 }, (_, index) => ({ speaker: 'other', text: `第${index}句`, timestamp: index }))
  const context = normalizeInteractionContext(items)
  assert.equal(context.length, CONTEXT_MAX_ITEMS)
  assert.equal(context.at(-1).text, `第${CONTEXT_MAX_ITEMS + 4}句`)
  assert.equal(context[0].text, '第5句')
})

test('drops the oldest messages when the character budget is exceeded', () => {
  const chunk = 'x'.repeat(CONTEXT_MAX_ITEM_CHARS)
  const items = Array.from({ length: 12 }, (_, index) => ({ speaker: 'other', text: chunk, timestamp: index }))
  const context = normalizeInteractionContext(items)
  const total = context.reduce((sum, entry) => sum + entry.text.length, 0)
  assert.ok(total <= CONTEXT_MAX_CHARS)
  assert.ok(context.length > 0 && context.length < 12)
  // 保留的是最新的那几条，最旧的一定被丢掉。
  assert.equal(context.at(-1).text, chunk)
  assert.equal(normalizeInteractionContext(items)[0].timestamp, 12 - context.length)
})

test('keeps repeated identical messages unless they are exact duplicates', () => {
  const context = normalizeInteractionContext([
    { speaker: 'other', text: '在吗', timestamp: 10 },
    { speaker: 'self', text: '在的', timestamp: 20 },
    { speaker: 'other', text: '在吗', timestamp: 30 },
    // 同一时间戳同一个人同内容的重复返回只保留一条。
    { speaker: 'other', text: '在吗', timestamp: 30 },
  ])
  assert.deepEqual(context.map((entry) => `${entry.label}:${entry.text}`), ['对方:在吗', '我:在的', '对方:在吗'])
})

test('labels multiple other speakers so a mixed comment floor stays readable', () => {
  const context = normalizeInteractionContext([
    { speaker: 'other', speakerId: '11', name: '甲', text: '第一楼', timestamp: 10 },
    { speaker: 'self', speakerId: '7', text: '我的回复', timestamp: 20 },
    { speaker: 'other', speakerId: '22', name: '乙', text: '第二楼', timestamp: 30 },
    { speaker: 'other', speakerId: '11', name: '甲', text: '再说一句', timestamp: 40 },
  ])
  assert.deepEqual(context.map((entry) => entry.label), ['对方1', '我', '对方2', '对方1'])
  // 只有一个对方时不加编号，保持自然。
  const single = normalizeInteractionContext([
    { speaker: 'other', speakerId: '11', text: '你好', timestamp: 10 },
    { speaker: 'other', speakerId: '11', text: '在吗', timestamp: 20 },
  ])
  assert.deepEqual(single.map((entry) => entry.label), ['对方', '对方'])
  assert.equal(describeInteractionContext(context), '4 条（自己 1 条，对方 3 条，2 人）')
})

test('keeps an image-only entry even when it has no text', () => {
  const context = normalizeInteractionContext([
    { speaker: 'other', speakerId: '11', text: '', images: [{ url: 'https://i0.hdslb.com/a.jpg' }], timestamp: 10 },
  ])
  assert.equal(context.length, 1)
  assert.equal(context[0].text, '')
  assert.equal(context[0].images.length, 1)
  assert.match(describeInteractionContext(context), /图片 1 张/)
})

test('returns an empty context for missing or unusable input', () => {
  assert.deepEqual(normalizeInteractionContext(undefined), [])
  assert.deepEqual(normalizeInteractionContext([]), [])
  assert.deepEqual(normalizeInteractionContext([{ text: '' }, null]), [])
})

test('describes context size without leaking message text', () => {
  assert.equal(describeInteractionContext([]), '无')
  assert.equal(describeInteractionContext(undefined), '无')
  const described = describeInteractionContext([
    { speaker: 'self', text: '机密内容甲' },
    { speaker: 'other', text: '机密内容乙' },
    { speaker: 'other', text: '机密内容丙' },
  ])
  assert.equal(described, '3 条（自己 1 条，对方 2 条）')
  assert.doesNotMatch(described, /机密内容/)
})
