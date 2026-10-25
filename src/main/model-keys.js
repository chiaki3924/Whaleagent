// 多模型 API Key 的纯数据处理：真正读写文件与加解密由主进程负责。
// 磁盘格式是一个加密后的 JSON 对象：{ "<模型 id>": "<API Key>" }。

import { normalizeModelId } from './model-profiles.js'

export const MAX_API_KEY_LENGTH = 4096
export const MAX_STORED_KEYS = 32

export function normalizeKeyStore(value) {
  const store = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return store
  for (const [rawId, rawKey] of Object.entries(value)) {
    const id = normalizeModelId(rawId)
    const key = typeof rawKey === 'string' ? rawKey.trim() : ''
    if (!id || !key || key.length > MAX_API_KEY_LENGTH) continue
    store[id] = key
    if (Object.keys(store).length >= MAX_STORED_KEYS) break
  }
  return store
}

export function keyForProfile(store, id) {
  const key = normalizeKeyStore(store)[normalizeModelId(id)]
  return typeof key === 'string' ? key : ''
}

// 新增/替换一个模型的 Key；key 为空表示“保持原样”，由调用方决定是否删除。
export function withProfileKey(store, id, key) {
  const next = { ...normalizeKeyStore(store) }
  const modelId = normalizeModelId(id)
  const value = String(key ?? '').trim()
  if (!modelId) return next
  if (!value) return next
  if (value.length > MAX_API_KEY_LENGTH) throw new Error('API Key 长度超出限制。')
  next[modelId] = value
  return next
}

export function withoutProfileKey(store, id) {
  const next = { ...normalizeKeyStore(store) }
  delete next[normalizeModelId(id)]
  return next
}

// 只保留仍然存在的模型，避免删除模型后残留密钥。
export function pruneKeyStore(store, profiles) {
  const ids = new Set((Array.isArray(profiles) ? profiles : []).map((profile) => normalizeModelId(profile?.id)))
  const next = {}
  for (const [id, key] of Object.entries(normalizeKeyStore(store))) {
    if (ids.has(id)) next[id] = key
  }
  return next
}
