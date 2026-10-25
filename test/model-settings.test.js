import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TEMPERATURE,
  MAX_MODEL_NAME_LENGTH,
  MAX_PROVIDER_NAME_LENGTH,
  inferVisionSupport,
  normalizeModelName,
  normalizeProviderName,
  normalizeRequestFormat,
  normalizeTemperature,
  normalizeVisionMode,
  parseProviderModelPayload,
  readModelName,
  readProviderName,
  readTemperature,
  resolveTemperature,
  resolveVisionEnabled,
  shouldAttemptImages,
} from '../src/main/model-settings.js'

test('normalizes optional provider and model names without inventing defaults', () => {
  assert.equal(normalizeProviderName('  DeepSeek   TEAPI  '), 'DeepSeek TEAPI')
  assert.equal(normalizeProviderName(''), '')
  assert.equal(normalizeModelName('  deepseek-v4.1-flash  '), 'deepseek-v4.1-flash')
  assert.equal(normalizeModelName(''), '')
  assert.throws(() => normalizeProviderName('x'.repeat(MAX_PROVIDER_NAME_LENGTH + 1)), /供应商名称最多/)
  assert.throws(() => normalizeModelName('x'.repeat(MAX_MODEL_NAME_LENGTH + 1)), /模型名称最多/)
})

test('falls back safely when a hand-edited settings file exceeds field limits', () => {
  assert.equal(readProviderName('x'.repeat(100)).length, MAX_PROVIDER_NAME_LENGTH)
  assert.equal(readModelName('x'.repeat(200)).length, MAX_MODEL_NAME_LENGTH)
  assert.equal(readModelName('  m  '), 'm')
})

test('only OpenAI-compatible request format is implemented', () => {
  assert.equal(normalizeRequestFormat('openai'), 'openai')
  assert.equal(normalizeRequestFormat('OPENAI'), 'openai')
  assert.equal(normalizeRequestFormat('anthropic'), 'openai')
  assert.equal(normalizeRequestFormat(undefined), 'openai')
})

test('temperature stays inside 0 to 2.0 and rounds to 0.1', () => {
  assert.equal(normalizeTemperature('0'), 0)
  assert.equal(normalizeTemperature('2'), 2)
  assert.equal(normalizeTemperature('0.74'), 0.7)
  assert.equal(normalizeTemperature('0.75'), 0.8)
  assert.equal(normalizeTemperature(''), DEFAULT_TEMPERATURE)
  assert.throws(() => normalizeTemperature('-0.1'), /0 到 2\.0/)
  assert.throws(() => normalizeTemperature('2.1'), /0 到 2\.0/)
  assert.throws(() => normalizeTemperature('abc'), /0 到 2\.0/)
  assert.equal(readTemperature('9'), DEFAULT_TEMPERATURE)
  assert.equal(readTemperature(undefined), DEFAULT_TEMPERATURE)
  assert.equal(resolveTemperature(undefined, 0.2), 0.2)
  assert.equal(resolveTemperature('1.3', 0.2), 1.3)
})

test('vision mode only accepts auto, image or text', () => {
  assert.equal(normalizeVisionMode('auto'), 'auto')
  assert.equal(normalizeVisionMode('image'), 'image')
  assert.equal(normalizeVisionMode('TEXT'), 'text')
  assert.equal(normalizeVisionMode('unknown'), 'auto')
  assert.equal(normalizeVisionMode(''), 'auto')
})

test('resolves whether this request may carry images', () => {
  // 明确禁用最优先：发给纯文本模型的 image_url 片段会让整条请求失败。
  assert.equal(resolveVisionEnabled('text', 'gpt-4o'), false)
  assert.equal(resolveVisionEnabled('image', 'deepseek-chat'), true)
  assert.equal(resolveVisionEnabled('auto', 'gpt-4o'), true)
  assert.equal(resolveVisionEnabled('auto', 'qwen2.5-vl-72b'), true)
  // auto 不再因为“模型名不认识”就静默丢图——自定义中转名全被判成纯文本，
  // 正是“对方发图，模型回附件没加载出来”的根因。认不出来时先尝试，服务端拒绝再降级。
  assert.equal(resolveVisionEnabled('auto', 'deepseek-chat'), true)
  assert.equal(resolveVisionEnabled('auto', ''), true)
  assert.equal(resolveVisionEnabled(undefined, 'glm-4v'), true)
  // 明确判定为纯文本（供应商元数据说 only text）时仍然不带图。
  assert.equal(resolveVisionEnabled('auto', 'x'), true)
  assert.equal(shouldAttemptImages('text'), false)
  assert.equal(shouldAttemptImages('auto'), true)
  assert.equal(shouldAttemptImages('image'), true)
})

test('infers vision support from provider metadata first, then model names', () => {
  assert.equal(inferVisionSupport('anything', { architecture: { input_modalities: ['text', 'image'] } }), true)
  assert.equal(inferVisionSupport('anything', { architecture: { input_modalities: ['text'] } }), false)
  assert.equal(inferVisionSupport('anything', { capabilities: { vision: true } }), true)
  assert.equal(inferVisionSupport('anything', { supports_vision: false }), false)
  assert.equal(inferVisionSupport('qwen2.5-vl-72b'), true)
  assert.equal(inferVisionSupport('gpt-4o-mini'), true)
  assert.equal(inferVisionSupport('deepseek-chat'), null)
})

test('parses and sorts OpenAI-compatible model lists without trusting raw payloads', () => {
  const models = parseProviderModelPayload({
    data: [
      { id: 'b-model', owned_by: 'vendor' },
      { id: 'a-model', architecture: { input_modalities: ['text', 'image'] } },
      'c-model',
      { id: 'a-model', owned_by: 'duplicate' },
      { id: '' },
      { name: 'd-model' },
      null,
    ],
  })
  assert.deepEqual(models.map((model) => model.id), ['a-model', 'b-model', 'c-model', 'd-model'])
  assert.equal(models[0].vision, true)
  assert.equal(models[1].ownedBy, 'vendor')
  assert.equal(models[2].vision, null)
  assert.deepEqual(parseProviderModelPayload({ data: 'bad' }), [])
  assert.deepEqual(parseProviderModelPayload(null), [])
})
