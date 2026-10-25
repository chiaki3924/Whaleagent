// 模型连接的本地配置：供应商展示名、请求格式、温度和视觉能力。
// 这些字段只影响请求参数与界面提示，不参与提示词，也不改变任何安全边界。

export const DEFAULT_TEMPERATURE = 0.7
export const MIN_TEMPERATURE = 0
export const MAX_TEMPERATURE = 2
export const MAX_PROVIDER_NAME_LENGTH = 60
export const MAX_MODEL_NAME_LENGTH = 128

export const REQUEST_FORMAT_OPENAI = 'openai'
const REQUEST_FORMATS = new Set([REQUEST_FORMAT_OPENAI])

export const VISION_MODE_AUTO = 'auto'
export const VISION_MODE_IMAGE = 'image'
export const VISION_MODE_TEXT = 'text'
const VISION_MODES = new Set([VISION_MODE_AUTO, VISION_MODE_IMAGE, VISION_MODE_TEXT])

function singleLine(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export function normalizeProviderName(value) {
  const name = singleLine(value, MAX_PROVIDER_NAME_LENGTH + 1)
  if (name.length > MAX_PROVIDER_NAME_LENGTH) throw new Error(`供应商名称最多 ${MAX_PROVIDER_NAME_LENGTH} 个字符。`)
  return name
}

export function readProviderName(value) {
  try { return normalizeProviderName(value) } catch { return singleLine(value, MAX_PROVIDER_NAME_LENGTH) }
}

// 模型名称允许留空（先保存连接信息，之后再补模型）；非空时最多 128 个字符。
export function normalizeModelName(value) {
  const name = singleLine(value, MAX_MODEL_NAME_LENGTH + 1)
  if (name.length > MAX_MODEL_NAME_LENGTH) throw new Error(`模型名称最多 ${MAX_MODEL_NAME_LENGTH} 个字符。`)
  return name
}

export function readModelName(value) {
  try { return normalizeModelName(value) } catch { return singleLine(value, MAX_MODEL_NAME_LENGTH) }
}

export function normalizeRequestFormat(value) {
  const format = String(value ?? '').trim().toLowerCase()
  // 当前发行版只实现 OpenAI Chat Completions；未知值回落到它，避免旧设置把应用卡死。
  return REQUEST_FORMATS.has(format) ? format : REQUEST_FORMAT_OPENAI
}

export function normalizeTemperature(value) {
  if (value === '' || value === null || value === undefined) return DEFAULT_TEMPERATURE
  const temperature = Number(value)
  if (!Number.isFinite(temperature) || temperature < MIN_TEMPERATURE || temperature > MAX_TEMPERATURE) {
    throw new Error(`温度必须是 ${MIN_TEMPERATURE} 到 ${MAX_TEMPERATURE.toFixed(1)} 之间的数字。`)
  }
  return Math.round(temperature * 10) / 10
}

// 读取旧设置或手工编辑过的文件时使用：无效温度退回默认值，而不是让整个设置页读不出来。
export function readTemperature(value) {
  try { return normalizeTemperature(value) } catch { return DEFAULT_TEMPERATURE }
}

export function normalizeVisionMode(value) {
  const mode = String(value ?? '').trim().toLowerCase()
  return VISION_MODES.has(mode) ? mode : VISION_MODE_AUTO
}

// 设置里的三档视觉能力 → 本次请求到底要不要尝试带图片。
// text 明确禁用；image 明确启用；auto 一律先尝试。
//
// auto 以前是“模型名看起来支持才带”，结果自定义中转名（deepseek-chat、te-gpt-4o 之类）
// 全都判成纯文本，用户发图后模型只会回“附件没加载出来”。现在改成“先试，失败再退回纯文本”——
// 真正的判断交给服务端：拒绝就降级重试，接受就正常看图。
export function shouldAttemptImages(visionMode) {
  return normalizeVisionMode(visionMode) !== VISION_MODE_TEXT
}

export function resolveVisionEnabled(visionMode, modelId) {
  const mode = normalizeVisionMode(visionMode)
  if (mode === VISION_MODE_TEXT) return false
  if (mode === VISION_MODE_IMAGE) return true
  // auto：明确不支持时不必浪费一次失败请求，其余情况都试。
  return inferVisionSupport(modelId, {}) !== false
}

export function resolveTemperature(value, fallback = DEFAULT_TEMPERATURE) {
  if (value === '' || value === null || value === undefined) return fallback
  return normalizeTemperature(value)
}

const VISION_NAME_HINTS = /(?:gpt-4o|gpt-4\.1|gpt-5(?:\.\d+)?|chatgpt-4o|o[34](?:-mini)?|gemini|claude-(?:3|4)|qwen(?:2(?:\.5)?)?-?vl|qwen-vl|glm-4(?:\.\d)?v|llava|pixtral|internvl|minicpm-v|vision|multimodal|omni)/i

const VISION_MODALITY_LISTS = [
  (entry) => entry?.architecture?.input_modalities,
  (entry) => entry?.input_modalities,
  (entry) => entry?.modalities?.input,
  (entry) => entry?.capabilities?.input_modalities,
]

const VISION_FLAGS = [
  (entry) => entry?.supports_vision,
  (entry) => entry?.vision,
  (entry) => entry?.capabilities?.vision,
  (entry) => entry?.capabilities?.image_input,
]

function explicitVisionSupport(entry) {
  for (const read of VISION_MODALITY_LISTS) {
    const list = read(entry)
    if (!Array.isArray(list) || list.length === 0) continue
    const modalities = list.map((item) => String(item ?? '').trim().toLowerCase())
    if (modalities.some((item) => item === 'image' || item === 'vision')) return true
    if (modalities.every((item) => item === 'text' || item === 'text-only' || item === 'text_only')) return false
  }
  for (const read of VISION_FLAGS) {
    const flag = read(entry)
    if (typeof flag === 'boolean') return flag
  }
  return null
}

// 供应商列表里通常会有 OpenRouter 风格的 input_modalities；没有元数据时退回模型名启发式。
// 返回 null 表示“无法判断”，界面上按纯文本提示，避免夸大能力。
export function inferVisionSupport(modelId, entry = {}) {
  const explicit = explicitVisionSupport(entry)
  if (explicit !== null) return explicit
  return VISION_NAME_HINTS.test(String(modelId ?? '')) ? true : null
}

export function parseProviderModelPayload(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : []
  const models = new Map()
  for (const entry of list) {
    const raw = typeof entry === 'string' ? entry : entry?.id ?? entry?.name ?? entry?.model
    const id = singleLine(raw, 201)
    if (!id || id.length > 200 || models.has(id)) continue
    const ownedBy = singleLine(typeof entry === 'object' ? entry?.owned_by ?? entry?.ownedBy : '', 80)
    models.set(id, { id, ownedBy, vision: inferVisionSupport(id, entry) })
    if (models.size >= 5000) break
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'))
}
