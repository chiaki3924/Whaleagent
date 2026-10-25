import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_API_KEY_LENGTH,
  MAX_STORED_KEYS,
  keyForProfile,
  normalizeKeyStore,
  pruneKeyStore,
  withProfileKey,
  withoutProfileKey,
} from '../src/main/model-keys.js'

test('密钥库只保留非空字符串，并裁掉首尾空白', () => {
  assert.deepEqual(normalizeKeyStore({ a: '  key-a  ', b: '', c: '   ', d: 42, e: null }), { a: 'key-a' })
  assert.deepEqual(normalizeKeyStore(null), {})
  assert.deepEqual(normalizeKeyStore('not-an-object'), {})
  assert.deepEqual(normalizeKeyStore(['x']), {})
})

test('密钥库丢弃非法 id 和超长 key，并限制条目数量', () => {
  const store = normalizeKeyStore({
    'bad id': 'key',
    '../escape': 'key',
    tooLong: 'k'.repeat(MAX_API_KEY_LENGTH + 10),
    good: 'key-good',
  })
  assert.deepEqual(store, { good: 'key-good' })

  const many = {}
  for (let index = 0; index < MAX_STORED_KEYS + 5; index += 1) many[`m${index}`] = `key-${index}`
  assert.equal(Object.keys(normalizeKeyStore(many)).length, MAX_STORED_KEYS)
})

test('读取单个模型的 key 不存在时返回空字符串', () => {
  const store = { a: 'key-a' }
  assert.equal(keyForProfile(store, 'a'), 'key-a')
  assert.equal(keyForProfile(store, 'b'), '')
  assert.equal(keyForProfile(store, ''), '')
  assert.equal(keyForProfile(null, 'a'), '')
})

test('写入和删除都返回新对象，不修改原密钥库', () => {
  const original = { a: 'key-a' }
  const added = withProfileKey(original, 'b', 'key-b')
  assert.deepEqual(original, { a: 'key-a' })
  assert.deepEqual(added, { a: 'key-a', b: 'key-b' })

  const removed = withoutProfileKey(added, 'a')
  assert.deepEqual(added, { a: 'key-a', b: 'key-b' })
  assert.deepEqual(removed, { b: 'key-b' })
  assert.deepEqual(withoutProfileKey(original, 'missing'), { a: 'key-a' })
})

test('留空的 key 表示保持原样，删除必须显式调用 withoutProfileKey', () => {
  assert.deepEqual(withProfileKey({ a: 'key-a' }, 'a', ''), { a: 'key-a' })
  assert.deepEqual(withProfileKey({ a: 'key-a' }, 'a', '   '), { a: 'key-a' })
  assert.deepEqual(withProfileKey({ a: 'key-a' }, 'a', 'key-new'), { a: 'key-new' })
  assert.deepEqual(withProfileKey({ a: 'key-a' }, '', 'key-x'), { a: 'key-a' })
  assert.throws(() => withProfileKey({}, 'a', 'k'.repeat(MAX_API_KEY_LENGTH + 1)), /长度/)
})

test('删除模型后密钥库只保留仍然存在的模型', () => {
  const store = { a: 'key-a', b: 'key-b', c: 'key-c' }
  const pruned = pruneKeyStore(store, [{ id: 'a' }, { id: 'c' }])
  assert.deepEqual(pruned, { a: 'key-a', c: 'key-c' })
  assert.deepEqual(pruneKeyStore(store, []), {})
})
