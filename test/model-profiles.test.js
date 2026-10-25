import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LEGACY_MODEL_ID,
  MAX_MODELS,
  createModelId,
  normalizeChainSelection,
  normalizeModelProfile,
  profileIsReady,
  profileLabel,
  readModelProfiles,
  resolveModelChain,
} from '../src/main/model-profiles.js'

const NOW = new Date('2026-10-24T10:00:00.000Z')

test('模型档案规范化出稳定的 id、默认温度和视觉设置', () => {
  const profile = normalizeModelProfile({
    providerName: '  DeepSeek  ',
    baseUrl: 'https://api.example.com/v1/',
    model: 'deepseek-v4.1-flash',
    temperature: '1.3',
    visionMode: 'image',
  }, { now: NOW })
  assert.match(profile.id, /^[A-Za-z0-9_-]{1,64}$/)
  assert.equal(profile.providerName, 'DeepSeek')
  assert.equal(profile.baseUrl, 'https://api.example.com/v1')
  assert.equal(profile.requestFormat, 'openai')
  assert.equal(profile.model, 'deepseek-v4.1-flash')
  assert.equal(profile.temperature, 1.3)
  assert.equal(profile.visionMode, 'image')
  assert.equal(profile.createdAt, NOW.toISOString())
  assert.equal(profile.updatedAt, NOW.toISOString())
})

test('模型档案拒绝明文 http 地址并限制字段长度', () => {
  assert.throws(() => normalizeModelProfile({ baseUrl: 'http://api.example.com/v1' }, { now: NOW }), /HTTPS|加密|http/i)
  assert.throws(() => normalizeModelProfile({ providerName: 'x'.repeat(200) }, { now: NOW }), /供应商名称最多 60/)
  assert.throws(() => normalizeModelProfile({ model: 'y'.repeat(300) }, { now: NOW }), /模型名称最多 128/)
  // 从磁盘读取时则退化为截断，保证坏数据不会让设置页整体读不出来。
  const saved = readModelProfiles({ models: [{ providerName: 'x'.repeat(200), model: 'y'.repeat(300) }] })
  assert.equal(saved.models[0].providerName.length, 60)
  assert.equal(saved.models[0].model.length, 128)
})

test('模型档案允许地址和模型名留空，方便先保存再补全', () => {
  const profile = normalizeModelProfile({}, { now: NOW })
  assert.equal(profile.baseUrl, '')
  assert.equal(profile.model, '')
  assert.equal(profile.temperature, 0.7)
  assert.equal(profileIsReady(profile), false)
})

test('可用模型必须同时具备地址、模型名和已保存的 API Key', () => {
  const base = { baseUrl: 'https://api.example.com/v1', model: 'm' }
  assert.equal(profileIsReady({ ...base, hasApiKey: true }), true)
  assert.equal(profileIsReady({ ...base, hasApiKey: false }), false)
  assert.equal(profileIsReady({ model: 'm', hasApiKey: true }), false)
  assert.equal(profileIsReady({ baseUrl: 'https://api.example.com/v1', hasApiKey: true }), false)
})

test('模型标签优先用供应商名称，其次模型名，最后给占位文案', () => {
  assert.equal(profileLabel({ providerName: 'DeepSeek', model: 'm' }), 'DeepSeek（m）')
  assert.equal(profileLabel({ providerName: 'DeepSeek' }), 'DeepSeek')
  assert.equal(profileLabel({ model: 'm' }), 'm')
  assert.equal(profileLabel({}), '未命名模型')
})

test('0.7.0 的扁平设置会迁移成一个模型档案', () => {
  const result = readModelProfiles({
    providerName: '旧供应商',
    baseUrl: 'https://api.example.com/v1',
    model: 'old-model',
    temperature: 0.4,
    visionMode: 'text',
  })
  assert.equal(result.models.length, 1)
  assert.equal(result.models[0].id, LEGACY_MODEL_ID)
  assert.equal(result.models[0].model, 'old-model')
  assert.equal(result.models[0].temperature, 0.4)
  assert.equal(result.primaryModelId, LEGACY_MODEL_ID)
  assert.equal(result.fallbackModelId, '')
})

test('完全没有模型配置时不伪造档案', () => {
  const result = readModelProfiles({})
  assert.deepEqual(result.models, [])
  assert.equal(result.primaryModelId, '')
  assert.equal(result.fallbackModelId, '')
})

test('读取模型列表时去重、丢弃坏数据并限制数量', () => {
  const many = Array.from({ length: MAX_MODELS + 4 }, (_, index) => ({ id: `m${index}`, model: `model-${index}` }))
  const result = readModelProfiles({ models: [...many, { id: 'm0', model: 'dup' }, { nope: true }] })
  assert.equal(result.models.length, MAX_MODELS)
  assert.equal(new Set(result.models.map((item) => item.id)).size, MAX_MODELS)
  assert.equal(result.primaryModelId, 'm0')
})

test('首选默认落在第一个模型，备用必须存在且不能与首选相同', () => {
  const models = [{ id: 'a' }, { id: 'b' }]
  assert.deepEqual(normalizeChainSelection(models, '', ''), { primaryModelId: 'a', fallbackModelId: '' })
  assert.deepEqual(normalizeChainSelection(models, 'b', 'a'), { primaryModelId: 'b', fallbackModelId: 'a' })
  assert.deepEqual(normalizeChainSelection(models, 'a', 'a'), { primaryModelId: 'a', fallbackModelId: '' })
  assert.deepEqual(normalizeChainSelection(models, 'a', 'missing'), { primaryModelId: 'a', fallbackModelId: '' })
  assert.deepEqual(normalizeChainSelection([], 'a', 'b'), { primaryModelId: '', fallbackModelId: '' })
})

test('调用链按首选、备用排序，只有一个模型时只有一项', () => {
  const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const chain = resolveModelChain({ models, primaryModelId: 'c', fallbackModelId: 'a' })
  assert.deepEqual(chain.map((item) => item.id), ['c', 'a'])
  assert.deepEqual(resolveModelChain({ models: [models[0]], primaryModelId: 'a', fallbackModelId: '' }).map((item) => item.id), ['a'])
  assert.deepEqual(resolveModelChain({ models: [], primaryModelId: '', fallbackModelId: '' }), [])
})

test('新生成的模型 id 长度固定且互不相同', () => {
  const a = createModelId()
  const b = createModelId()
  assert.match(a, /^[A-Za-z0-9_-]{1,64}$/)
  assert.notEqual(a, b)
})
