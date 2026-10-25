import { normalizeInteractionSettings } from './interaction-state.js'

export function cleanBaseUrl(value) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { throw new Error('请输入有效的模型服务 API 地址。') }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('服务地址必须使用 HTTP 或 HTTPS。')
  if (url.username || url.password) throw new Error('请勿把凭据写入服务地址。')
  if (url.search || url.hash) throw new Error('服务地址不能包含查询参数或片段。')
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !isLoopback) throw new Error('非本机服务必须使用 HTTPS。')
  return url.toString().replace(/\/$/, '')
}

export function validateModelConnectionSettings(settings) {
  const rawBaseUrl = String(settings?.baseUrl || '').trim()
  if (!rawBaseUrl) throw new Error('请先填写模型服务 API 地址并保存设置。')
  const baseUrl = cleanBaseUrl(rawBaseUrl)
  if (settings?.hasApiKey !== true) throw new Error('请先填写并保存 API Key。')
  return baseUrl
}

export const PREFERENCE_MAX_CHARS = 1200

export function normalizePreferences(value) {
  const preferences = String(value || '').trim()
  if (preferences.length > PREFERENCE_MAX_CHARS) throw new Error(`内容偏好最多 ${PREFERENCE_MAX_CHARS} 个字符。`)
  return preferences
}

export function normalizeInteractionConfig(value) {
  return normalizeInteractionSettings(value)
}

export function isModelReady(settings) {
  if (settings?.modelReady === true) return true
  if (Array.isArray(settings?.models)) {
    return settings.models.some((profile) => Boolean(String(profile?.baseUrl || '').trim() && String(profile?.model || '').trim() && profile?.hasApiKey === true))
  }
  return Boolean(String(settings?.baseUrl || '').trim() && String(settings?.model || '').trim() && settings?.hasApiKey === true)
}

export function validateReportName(value) {
  const name = String(value || '').trim()
  if (!name || name.length > 100 || /[\\/:*?"<>|\r\n]/.test(name) || name === '.' || name === '..') throw new Error('报告名称无效。')
  return name
}

export function normalizeReportMetadata(value) {
  let name
  try { name = validateReportName(value?.name) } catch { return null }
  const size = Number(value?.size)
  const modified = new Date(value?.modifiedAt)
  if (!Number.isFinite(size) || size < 0 || size > 1024 * 1024 || !Number.isFinite(modified.getTime())) return null
  return { name, size, modifiedAt: modified.toISOString() }
}

export function validateReport(input, maxBytes = 1024 * 1024) {
  const title = validateReportName(input?.title)
  const content = String(input?.content || '')
  if (!content.trim() || Buffer.byteLength(content, 'utf8') > maxBytes) throw new Error('报告内容为空或超过 1 MB。')
  return { title, content }
}
