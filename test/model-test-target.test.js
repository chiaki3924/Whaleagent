import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveTestTarget, resolveListTarget, testConnectionMessage } from '../src/main/model-test-target.js'

const savedProfile = {
  id: 'p1',
  providerName: 'TE中转',
  baseUrl: 'https://te-relay.example.com/v1',
  model: 'relay-model',
}

test('新增模型时使用表单里的地址和 Key，绝不回退到已保存的首选模型', () => {
  const target = resolveTestTarget({
    profile: null,
    input: { providerName: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-deepseek' },
    savedKey: 'sk-relay',
  })
  assert.equal(target.baseUrl, 'https://api.deepseek.com/v1')
  assert.equal(target.apiKey, 'sk-deepseek')
  assert.equal(target.label, 'DeepSeek')
  assert.equal(target.unsaved, true)
})

test('编辑已有模型时表单值优先，能覆盖已保存的地址与 Key', () => {
  const target = resolveTestTarget({
    profile: savedProfile,
    input: { providerName: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-new' },
    savedKey: 'sk-old',
  })
  assert.equal(target.baseUrl, 'https://api.deepseek.com/v1')
  assert.equal(target.apiKey, 'sk-new')
  assert.equal(target.unsaved, true)
})

test('表单留空时回退到该模型自己已保存的地址与 Key', () => {
  const target = resolveTestTarget({ profile: savedProfile, input: { baseUrl: '', apiKey: '' }, savedKey: 'sk-saved' })
  assert.equal(target.baseUrl, 'https://te-relay.example.com/v1')
  assert.equal(target.apiKey, 'sk-saved')
  assert.equal(target.label, 'TE中转')
  assert.equal(target.unsaved, false)
})

test('表单与已保存内容一致时不算未保存', () => {
  const target = resolveTestTarget({
    profile: savedProfile,
    input: { providerName: 'TE中转', baseUrl: 'https://te-relay.example.com/v1', apiKey: '' },
    savedKey: 'sk-saved',
  })
  assert.equal(target.unsaved, false)
})

test('供应商名称为空时用模型名称，再空则用域名', () => {
  assert.equal(resolveTestTarget({ input: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'k' } }).label, 'deepseek-chat')
  assert.equal(resolveTestTarget({ input: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k' } }).label, 'api.deepseek.com')
})

test('缺少地址或 Key 时报出明确错误', () => {
  assert.throws(() => resolveTestTarget({ input: { apiKey: 'k' } }), /请先填写模型服务 API 地址/)
  assert.throws(() => resolveTestTarget({ input: { baseUrl: 'https://api.deepseek.com/v1' } }), /请先填写 API Key/)
  assert.throws(
    () => resolveTestTarget({ profile: savedProfile, input: { baseUrl: 'https://api.deepseek.com/v1' }, savedKey: '' }),
    /请先填写 API Key，或先保存这个模型的 API Key 再测试/,
  )
})

test('地址仍走 HTTPS 校验', () => {
  assert.throws(() => resolveTestTarget({ input: { baseUrl: 'http://api.deepseek.com/v1', apiKey: 'k' } }), /非本机服务必须使用 HTTPS/)
  assert.equal(resolveTestTarget({ input: { baseUrl: 'http://127.0.0.1:9123/v1', apiKey: 'k' } }).baseUrl, 'http://127.0.0.1:9123/v1')
})

test('检查模型同样只用该模型自己的 Key，不回退到首选模型', () => {
  assert.throws(() => resolveListTarget({ profile: null, input: { baseUrl: 'https://api.deepseek.com/v1' } }), /请先填写 API Key，再检查模型/)
  const target = resolveListTarget({ profile: savedProfile, input: { baseUrl: '' }, savedKey: 'sk-saved' })
  assert.equal(target.baseUrl, 'https://te-relay.example.com/v1')
  assert.equal(target.apiKey, 'sk-saved')
})

test('成功提示带上被测模型的名字，未保存时额外提醒', () => {
  assert.equal(testConnectionMessage({ label: 'DeepSeek', unsaved: false }), '连接成功（DeepSeek）。')
  assert.match(testConnectionMessage({ label: 'DeepSeek', unsaved: true }), /^连接成功（DeepSeek）。.*保存模型/)
  assert.equal(testConnectionMessage({}), '连接成功（当前模型）。')
})
