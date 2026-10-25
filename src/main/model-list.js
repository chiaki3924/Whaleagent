import { cleanBaseUrl } from './validation.js'
import { parseProviderModelPayload } from './model-settings.js'

export const MAX_MODEL_LIST_BYTES = 1024 * 1024
export const MODEL_LIST_TIMEOUT_MS = 15_000

async function readLimitedText(response) {
  const announced = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(announced) && announced > MAX_MODEL_LIST_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new Error('模型列表响应超过 1 MB 限制。')
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength > MAX_MODEL_LIST_BYTES) throw new Error('模型列表响应超过 1 MB 限制。')
  return bytes.toString('utf8')
}

// 只读取供应商的 /models 列表，供“检查模型”快捷选择；不发送任何本地数据。
export async function fetchProviderModels({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = MODEL_LIST_TIMEOUT_MS } = {}) {
  const endpoint = `${cleanBaseUrl(baseUrl)}/models`
  const key = String(apiKey ?? '').trim()
  if (!key) throw new Error('请先填写 API Key，或先保存 API Key 再检查模型。')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      if (response.status === 404) throw new Error('该服务没有提供 /models 接口（HTTP 404），请手动填写模型名称。')
      throw new Error(`模型列表接口返回 HTTP ${response.status}。`)
    }
    let data
    try { data = JSON.parse(await readLimitedText(response)) }
    catch (error) {
      if (error.message === '模型列表响应超过 1 MB 限制。') throw error
      throw new Error('模型列表不是有效的 JSON。')
    }
    const models = parseProviderModelPayload(data)
    if (!models.length) throw new Error('服务没有返回可用模型列表，请手动填写模型名称。')
    return { models, count: models.length }
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('读取模型列表超时（15 秒）。')
    throw error
  } finally {
    clearTimeout(timer)
  }
}
