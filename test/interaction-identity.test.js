import test from 'node:test'
import assert from 'node:assert/strict'
import {
  IDENTITY_MAX_BATCH,
  cleanDisplayName,
  createIdentityDirectory,
  describeIdentityLookup,
  normalizeMids,
  parseUserCards,
} from '../src/main/interaction-identity.js'

const headers = { Cookie: 'SESSDATA=session' }

test('keeps only numeric unique mids and drops everything else', () => {
  assert.deepEqual(normalizeMids(['42', 43, ' 44 ', '42', '', null, 'abc', '1'.repeat(21), '-1']), ['42', '43', '44'])
  assert.deepEqual(normalizeMids(null), [])
  assert.deepEqual(normalizeMids(['1', '2', '3'], { limit: 2 }), ['1', '2'])
})

test('cleans HTML and control characters out of a nickname', () => {
  assert.equal(cleanDisplayName('<b>小鲸</b>'), '小鲸')
  assert.equal(cleanDisplayName('A&amp;B'), 'A&B')
  assert.equal(cleanDisplayName('  多\n行   空格  '), '多 行 空格')
  assert.equal(cleanDisplayName('x'.repeat(60)).length, 40)
  assert.equal(cleanDisplayName(null), '')
})

test('parses the user card payload and skips nameless or invalid entries', () => {
  const names = parseUserCards({ code: 0, data: [
    { mid: 42, name: '小鲸' },
    { mid: 43, name: '   ' },
    { mid: 'bad', name: '无效' },
    { mid: 44, name: '<i>阿鲸</i>' },
  ] })
  assert.deepEqual([...names.entries()], [['42', '小鲸'], ['44', '阿鲸']])
  // 不存在的 mid 不会报错，只是不出现在数组里；空数组是正常响应。
  assert.equal(parseUserCards({ code: 0, data: [] }).size, 0)
  assert.equal(parseUserCards({ code: 0, data: null }).size, 0)
})

test('looks up nicknames in one batched request and caches them', async () => {
  const requests = []
  let calls = 0
  const directory = createIdentityDirectory({
    fetchImpl: async (url) => {
      requests.push(String(url))
      calls += 1
      return new Response(JSON.stringify({ code: 0, data: [{ mid: 42, name: '小鲸' }, { mid: 44, name: '阿鲸' }] }), { status: 200 })
    },
  })
  const first = await directory.lookup(headers, ['42', '43', '44'])
  assert.deepEqual([...first.entries()], [['42', '小鲸'], ['44', '阿鲸']])
  assert.equal(requests.length, 1)
  assert.match(requests[0], /\/account\/v1\/user\/cards\?uids=42,43,44$/)
  // 43 查不到：负缓存，短时间内不再请求。
  const second = await directory.lookup(headers, ['42', '43', '44'])
  assert.deepEqual([...second.entries()], [['42', '小鲸'], ['44', '阿鲸']])
  assert.equal(calls, 1)
})

test('splits large lookups into batches of the verified limit', async () => {
  const batches = []
  const directory = createIdentityDirectory({
    fetchImpl: async (url) => {
      const uids = new URL(url).searchParams.get('uids').split(',')
      batches.push(uids.length)
      return new Response(JSON.stringify({ code: 0, data: uids.map((mid) => ({ mid: Number(mid), name: `n${mid}` })) }), { status: 200 })
    },
  })
  const mids = Array.from({ length: IDENTITY_MAX_BATCH + 10 }, (_, index) => String(1000 + index))
  const names = await directory.lookup(headers, mids)
  assert.equal(names.size, mids.length)
  // 实测超过 50 个 mid 会返回空数组，所以必须分批。
  assert.deepEqual(batches, [IDENTITY_MAX_BATCH, 10])
})

test('a failed lookup degrades to no nickname without caching the miss', async () => {
  let fail = true
  let calls = 0
  const directory = createIdentityDirectory({
    fetchImpl: async () => {
      calls += 1
      if (fail) return new Response(JSON.stringify({ code: -509, message: '请求过于频繁' }), { status: 200 })
      return new Response(JSON.stringify({ code: 0, data: [{ mid: 42, name: '小鲸' }] }), { status: 200 })
    },
  })
  assert.equal((await directory.lookup(headers, ['42'])).size, 0)
  // 网络/风控失败不写负缓存：下一轮应当真的再试一次。
  fail = false
  const names = await directory.lookup(headers, ['42'])
  assert.deepEqual([...names.entries()], [['42', '小鲸']])
  assert.equal(calls, 2)
})

test('a non-JSON or HTTP error response also degrades quietly', async () => {
  const directory = createIdentityDirectory({
    fetchImpl: async () => new Response('<html>502</html>', { status: 502 }),
  })
  assert.equal((await directory.lookup(headers, ['42'])).size, 0)
})

test('cached names expire so a renamed account is picked up', async () => {
  let now = 1_000_000
  let calls = 0
  const directory = createIdentityDirectory({
    now: () => now,
    ttlMs: 1000,
    fetchImpl: async () => {
      calls += 1
      return new Response(JSON.stringify({ code: 0, data: [{ mid: 42, name: calls === 1 ? '旧名' : '新名' }] }), { status: 200 })
    },
  })
  assert.equal((await directory.lookup(headers, ['42'])).get('42'), '旧名')
  assert.equal((await directory.lookup(headers, ['42'])).get('42'), '旧名')
  assert.equal(calls, 1)
  now += 1500
  assert.equal((await directory.lookup(headers, ['42'])).get('42'), '新名')
  assert.equal(calls, 2)
})

test('the cache is bounded and never grows without limit', async () => {
  const directory = createIdentityDirectory({
    maxEntries: 2,
    fetchImpl: async (url) => {
      const uids = new URL(url).searchParams.get('uids').split(',')
      return new Response(JSON.stringify({ code: 0, data: uids.map((mid) => ({ mid: Number(mid), name: `n${mid}` })) }), { status: 200 })
    },
  })
  await directory.lookup(headers, ['1'])
  await directory.lookup(headers, ['2'])
  await directory.lookup(headers, ['3'])
  assert.ok(directory.size <= 2)
})

test('describeIdentityLookup reports counts only, never the nicknames', () => {
  assert.equal(describeIdentityLookup(new Map([['42', '小鲸']]), ['42', '43']), '昵称 1/2')
  assert.equal(describeIdentityLookup(new Map(), 3), '昵称 0/3')
})
