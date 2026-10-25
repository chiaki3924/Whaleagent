import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultProfileLabel, runModelChain, summarizeAttempts } from '../src/main/model-chain.js'

const PRIMARY = { id: 'a', providerName: '主模型', model: 'primary-model', baseUrl: 'https://a.example.com/v1', apiKey: 'key-a' }
const FALLBACK = { id: 'b', providerName: '备用模型', model: 'fallback-model', baseUrl: 'https://b.example.com/v1', apiKey: 'key-b' }

function recorder() {
  const entries = []
  return { entries, log: (level, event, detail) => entries.push({ level, event, detail }) }
}

test('首选模型成功时不会调用备用模型', async () => {
  const calls = []
  const { entries, log } = recorder()
  const outcome = await runModelChain({
    chain: [PRIMARY, FALLBACK],
    run: async (profile) => { calls.push(profile.id); return `ok-${profile.id}` },
    log,
  })
  assert.deepEqual(calls, ['a'])
  assert.equal(outcome.result, 'ok-a')
  assert.equal(outcome.profile.id, 'a')
  assert.equal(outcome.fallbackUsed, false)
  assert.deepEqual(outcome.attempts, [])
  assert.deepEqual(entries, [])
})

test('首选请求失败后自动改用备用模型，并记录失败原因', async () => {
  const calls = []
  const { entries, log } = recorder()
  const outcome = await runModelChain({
    chain: [PRIMARY, FALLBACK],
    run: async (profile) => {
      calls.push(profile.id)
      if (profile.id === 'a') throw new Error('HTTP 500')
      return `ok-${profile.id}`
    },
    log,
  })
  assert.deepEqual(calls, ['a', 'b'])
  assert.equal(outcome.result, 'ok-b')
  assert.equal(outcome.profile.id, 'b')
  assert.equal(outcome.fallbackUsed, true)
  assert.equal(outcome.attempts.length, 1)
  assert.equal(outcome.attempts[0].label, '主模型（primary-model）')
  assert.match(outcome.attempts[0].message, /HTTP 500/)
  assert.deepEqual(entries.map((entry) => entry.event), ['model-attempt-failed', 'model-fallback-used'])
  assert.equal(entries[0].level, 'warn')
  assert.equal(entries[1].level, 'info')
})

test('只有首选时保持原始错误信息，便于界面直接提示', async () => {
  const { log } = recorder()
  await assert.rejects(
    () => runModelChain({ chain: [PRIMARY], run: async () => { throw new Error('连接超时（15 秒）。') }, log }),
    (error) => {
      assert.equal(error.message, '连接超时（15 秒）。')
      assert.equal(error.attempts.length, 1)
      assert.equal(error.attempts[0].label, '主模型（primary-model）')
      return true
    },
  )
})

test('首选和备用都失败时给出包含双方原因的合并错误', async () => {
  const { log } = recorder()
  await assert.rejects(
    () => runModelChain({
      chain: [PRIMARY, FALLBACK],
      run: async (profile) => { throw new Error(profile.id === 'a' ? 'HTTP 401' : 'HTTP 503') },
      log,
    }),
    (error) => {
      assert.match(error.message, /^首选模型和备用模型都调用失败/)
      assert.match(error.message, /主模型（primary-model）：HTTP 401/)
      assert.match(error.message, /备用模型（fallback-model）：HTTP 503/)
      assert.equal(error.attempts.length, 2)
      return true
    },
  )
})

test('没有可用模型时明确报错，不发起任何请求', async () => {
  let called = 0
  const { log } = recorder()
  await assert.rejects(
    () => runModelChain({ chain: [], run: async () => { called += 1 }, log }),
    /没有可用的模型/,
  )
  assert.equal(called, 0)
})

test('三个模型时只尝试首选和备用两个位置', async () => {
  const calls = []
  const { log } = recorder()
  const third = { id: 'c', providerName: '第三个', model: 'third', baseUrl: 'https://c.example.com/v1', apiKey: 'key-c' }
  await assert.rejects(
    () => runModelChain({
      chain: [PRIMARY, FALLBACK, third],
      run: async (profile) => { calls.push(profile.id); throw new Error('boom') },
      log,
    }),
    /都调用失败/,
  )
  assert.deepEqual(calls, ['a', 'b'])
})

test('标签优先供应商名称，其次模型名，最后占位文案', () => {
  assert.equal(defaultProfileLabel({ providerName: 'DeepSeek' }), 'DeepSeek')
  assert.equal(defaultProfileLabel({ providerName: 'DeepSeek', model: 'm' }), 'DeepSeek（m）')
  assert.equal(defaultProfileLabel({ model: 'm' }), 'm')
  assert.equal(defaultProfileLabel({}), '未命名模型')
})

test('失败摘要保留每个模型的原因且不超过展示长度', () => {
  const summary = summarizeAttempts([
    { label: '主模型', message: 'HTTP 401' },
    { label: '备用模型', message: 'x'.repeat(300) },
  ])
  assert.match(summary, /主模型：HTTP 401/)
  assert.ok(summary.length <= 600, `摘要过长：${summary.length}`)
})
