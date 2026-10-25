// 多模型档案：每个模型有自己的连接信息、温度和 API Key（Key 单独加密保存）。
// 调用顺序固定为“首选 → 备用”，只有首选请求失败时才会调用备用。

import { randomUUID } from 'node:crypto'
import { cleanBaseUrl } from './validation.js'
import {
  DEFAULT_TEMPERATURE,
  normalizeModelName,
  normalizeProviderName,
  normalizeRequestFormat,
  normalizeTemperature,
  normalizeVisionMode,
  readModelName,
  readProviderName,
  readTemperature,
} from './model-settings.js'

export const MAX_MODELS = 8
// 0.7.0 及更早版本只有一个模型，升级时用它作为稳定 id，避免每次读取都生成新 id。
export const LEGACY_MODEL_ID = 'legacy-default'

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function normalizeModelId(value) {
  const id = String(value ?? '').trim()
  return ID_PATTERN.test(id) ? id : ''
}

export function createModelId() {
  return randomUUID().replace(/-/g, '').slice(0, 24)
}

export function normalizeProfileBaseUrl(value) {
  const raw = String(value ?? '').trim()
  return raw ? cleanBaseUrl(raw) : ''
}

// 读取磁盘上的旧数据时不抛错：地址写坏了只影响该模型的请求，不应让整个设置页读不出来。
export function readProfileBaseUrl(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  try { return cleanBaseUrl(raw) } catch { return raw.slice(0, 300) }
}

function readTimestamp(value) {
  const time = new Date(value ?? '')
  return Number.isFinite(time.getTime()) ? time.toISOString() : ''
}

export function normalizeModelProfile(value, { now = new Date() } = {}) {
  const createdAt = readTimestamp(value?.createdAt) || now.toISOString()
  return {
    id: normalizeModelId(value?.id) || createModelId(),
    providerName: normalizeProviderName(value?.providerName),
    baseUrl: normalizeProfileBaseUrl(value?.baseUrl),
    requestFormat: normalizeRequestFormat(value?.requestFormat),
    model: normalizeModelName(value?.model),
    temperature: normalizeTemperature(value?.temperature),
    visionMode: normalizeVisionMode(value?.visionMode),
    createdAt,
    updatedAt: readTimestamp(value?.updatedAt) || createdAt,
  }
}

export function readModelProfile(value, { now = new Date() } = {}) {
  const createdAt = readTimestamp(value?.createdAt) || now.toISOString()
  return {
    id: normalizeModelId(value?.id) || createModelId(),
    providerName: readProviderName(value?.providerName),
    baseUrl: readProfileBaseUrl(value?.baseUrl),
    requestFormat: normalizeRequestFormat(value?.requestFormat),
    model: readModelName(value?.model),
    temperature: readTemperature(value?.temperature),
    visionMode: normalizeVisionMode(value?.visionMode),
    createdAt,
    updatedAt: readTimestamp(value?.updatedAt) || createdAt,
  }
}

// settings.json 里没有 models 字段时按 0.7.0 的单模型字段迁移成一条档案。
export function readModelProfiles(data) {
  const raw = Array.isArray(data?.models) ? data.models : null
  if (!raw) {
    const legacy = readModelProfile({
      id: LEGACY_MODEL_ID,
      providerName: data?.providerName,
      baseUrl: data?.baseUrl,
      requestFormat: data?.requestFormat,
      model: data?.model,
      temperature: data?.temperature,
      visionMode: data?.visionMode,
    })
    if (!legacy.baseUrl && !legacy.model) return { models: [], primaryModelId: '', fallbackModelId: '' }
    return { models: [legacy], primaryModelId: legacy.id, fallbackModelId: '' }
  }
  const models = []
  const seen = new Set()
  for (const entry of raw.slice(0, MAX_MODELS)) {
    const profile = readModelProfile(entry)
    if (seen.has(profile.id)) continue
    seen.add(profile.id)
    models.push(profile)
  }
  return { models, ...normalizeChainSelection(models, data?.primaryModelId, data?.fallbackModelId) }
}

export function normalizeChainSelection(models, primaryModelId, fallbackModelId) {
  const list = Array.isArray(models) ? models : []
  const ids = new Set(list.map((profile) => profile.id))
  const requestedPrimary = normalizeModelId(primaryModelId)
  const primary = ids.has(requestedPrimary) ? requestedPrimary : (list[0]?.id || '')
  const requestedFallback = normalizeModelId(fallbackModelId)
  const fallback = ids.has(requestedFallback) && requestedFallback !== primary ? requestedFallback : ''
  return { primaryModelId: primary, fallbackModelId: fallback }
}

// 首选在前、备用在后；备用只在首选请求失败时使用。
export function resolveModelChain({ models = [], primaryModelId = '', fallbackModelId = '' } = {}) {
  const list = Array.isArray(models) ? models : []
  const primary = list.find((profile) => profile.id === primaryModelId) || list[0] || null
  const chain = primary ? [primary] : []
  if (fallbackModelId && fallbackModelId !== primary?.id) {
    const fallback = list.find((profile) => profile.id === fallbackModelId)
    if (fallback) chain.push(fallback)
  }
  return chain
}

export function profileIsReady(profile) {
  return Boolean(String(profile?.baseUrl || '').trim() && String(profile?.model || '').trim() && profile?.hasApiKey === true)
}

export function profileLabel(profile) {
  const provider = String(profile?.providerName || '').trim()
  const model = String(profile?.model || '').trim()
  if (provider && model) return `${provider}（${model}）`
  return provider || model || '未命名模型'
}

export { DEFAULT_TEMPERATURE }
