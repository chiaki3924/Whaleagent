import test from 'node:test'
import assert from 'node:assert/strict'
import { isModelReady, canAnalyze, personaDirty, personaIsEmpty, resolveSearchRequest, profileIsReady, profileLabel, orderedModels } from '../src/renderer/state.js'

test('model readiness requires a non-empty endpoint, model name and saved API key', () => {
  assert.equal(isModelReady({ baseUrl: '', model: 'm', hasApiKey: true }), false)
  assert.equal(isModelReady({ baseUrl: 'https://api.example.com/v1', model: '', hasApiKey: true }), false)
  assert.equal(isModelReady({ baseUrl: 'https://api.example.com/v1', model: 'm', hasApiKey: false }), false)
  assert.equal(isModelReady({ baseUrl: '   ', model: 'm', hasApiKey: true }), false)
  assert.equal(isModelReady({ baseUrl: 'https://api.example.com/v1', model: '   ', hasApiKey: true }), false)
  assert.equal(isModelReady({ baseUrl: 'https://api.example.com/v1', model: 'deepseek-v4.1-flash', hasApiKey: true }), true)
})

test('multi-model readiness is true when any saved profile is usable', () => {
  const ready = { id: 'a', baseUrl: 'https://api.example.com/v1', model: 'm', hasApiKey: true }
  const incomplete = { id: 'b', baseUrl: '', model: 'm', hasApiKey: true }
  assert.equal(isModelReady({ models: [incomplete, ready] }), true)
  assert.equal(isModelReady({ models: [incomplete] }), false)
  assert.equal(isModelReady({ models: [], modelReady: false }), false)
  // 主进程算好的 modelReady 优先，避免渲染层重复判断口径。
  assert.equal(isModelReady({ modelReady: true, models: [] }), true)
})

test('profile helpers match the main process semantics', () => {
  assert.equal(profileIsReady({ baseUrl: 'https://api.example.com/v1', model: 'm', hasApiKey: true }), true)
  assert.equal(profileIsReady({ baseUrl: 'https://api.example.com/v1', model: 'm', hasApiKey: false }), false)
  assert.equal(profileLabel({ providerName: 'DeepSeek', model: 'm' }), 'DeepSeek（m）')
  assert.equal(profileLabel({}), '未命名模型')
})

test('ordered models put the primary first and the fallback second', () => {
  const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const ordered = orderedModels(models, 'c', 'a')
  assert.deepEqual(ordered.ordered.map((item) => item.id), ['c', 'a'])
  assert.equal(ordered.primary.id, 'c')
  assert.equal(ordered.fallback.id, 'a')
  // 首选等于备用时只有一个位置；没有首选时退回第一个模型。
  assert.deepEqual(orderedModels(models, 'a', 'a').ordered.map((item) => item.id), ['a'])
  assert.equal(orderedModels(models, '', '').primary.id, 'a')
  assert.deepEqual(orderedModels([], '', ''), { ordered: [], primary: null, fallback: null })
})

test('AI analysis only enables with a ready model, logged-in account and one to three selections', () => {
  assert.equal(canAnalyze({ modelReady: false, biliLoggedIn: true, selectedCount: 1 }), false)
  assert.equal(canAnalyze({ modelReady: true, biliLoggedIn: false, selectedCount: 1 }), false)
  assert.equal(canAnalyze({ modelReady: true, biliLoggedIn: true, selectedCount: 0 }), false)
  assert.equal(canAnalyze({ modelReady: true, biliLoggedIn: true, selectedCount: 4 }), false)
  assert.equal(canAnalyze({ modelReady: true, biliLoggedIn: true, selectedCount: 1 }), true)
  assert.equal(canAnalyze({ modelReady: true, biliLoggedIn: true, selectedCount: 3 }), true)
})

test('AI analysis is still available regardless of the reading windows', () => {
  const ready = { modelReady: true, biliLoggedIn: true, selectedCount: 2 }
  assert.equal(canAnalyze(ready), true)
  assert.equal(canAnalyze({ ...ready, selectedCount: 0 }), false)
})

test('search requests keep selected sources and skip an empty keyword only when another source is chosen', () => {
  assert.deepEqual(resolveSearchRequest({ keywordChecked: true, keyword: 'AI 工具', followingChecked: false, homepageChecked: false }), { sources: ['keyword'], keyword: 'AI 工具', note: '' })
  assert.deepEqual(resolveSearchRequest({ keywordChecked: true, keyword: '  ', followingChecked: false, homepageChecked: false }), { error: '关键词搜索已启用，请输入关键词；或取消关键词来源。' })
  assert.deepEqual(resolveSearchRequest({ keywordChecked: false, keyword: '', followingChecked: false, homepageChecked: false }), { error: '请至少选择一个视频来源。' })
  assert.deepEqual(resolveSearchRequest({ keywordChecked: true, keyword: '', followingChecked: true, homepageChecked: true }), { sources: ['following', 'homepage'], keyword: '', note: '关键词为空，已跳过关键词搜索。' })
  assert.deepEqual(resolveSearchRequest({ keywordChecked: true, keyword: '猫', followingChecked: true, homepageChecked: false }), { sources: ['keyword', 'following'], keyword: '猫', note: '' })
  assert.deepEqual(resolveSearchRequest({ keywordChecked: false, keyword: 'cat', followingChecked: false, homepageChecked: true }), { sources: ['homepage'], keyword: '', note: '' })
})

test('persona edits only count as dirty when saved content changes', () => {
  const saved = {
    ownerUid: '1',
    ownerNickname: '阿鲸',
    selfUid: '2',
    selfNickname: '小鲸',
    realName: '鲸',
    ownerTitle: '主人',
    selfClaim: '人家',
    custom: '语气简短。',
  }
  assert.equal(personaDirty(saved, saved), false)
  assert.equal(personaDirty({ ...saved, custom: ' 语气简短。 ' }, saved), false)
  assert.equal(personaDirty({ ...saved, ownerUid: '9' }, saved), true)
  assert.equal(personaDirty({ ...saved, custom: '' }, saved), true)
  assert.equal(personaDirty('称呼我为老板', '称呼我为老板'), false)
  assert.equal(personaDirty('新的自称', '称呼我为老板'), true)
})

test('persona emptiness accounts for both modules and custom content', () => {
  assert.equal(personaIsEmpty({}), true)
  assert.equal(personaIsEmpty({ ownerUid: '  ' }), true)
  assert.equal(personaIsEmpty({ ownerNickname: '阿鲸' }), false)
  assert.equal(personaIsEmpty({ custom: '语气简短。' }), false)
  assert.equal(personaIsEmpty('旧人设'), false)
})
