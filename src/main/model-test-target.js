// “测试连接”要测的是编辑器里当前这个模型，不能悄悄退回首选模型。
// 规则：编辑器里填了的优先（新增模型只有表单值），留空的回退到该模型已保存的值。
import { cleanBaseUrl } from './validation.js'

export const TEST_TIMEOUT_MS = 15000

export function resolveTestTarget({ profile = null, input = {}, savedKey = '' } = {}) {
  const formBaseUrl = String(input?.baseUrl ?? '').trim()
  const formKey = String(input?.apiKey ?? '').trim()
  const formModel = String(input?.model ?? '').trim()
  const formProvider = String(input?.providerName ?? '').trim()
  const savedBaseUrl = String(profile?.baseUrl ?? '').trim()
  const storedKey = String(savedKey ?? '').trim()

  const rawBaseUrl = formBaseUrl || savedBaseUrl
  if (!rawBaseUrl) throw new Error('请先填写模型服务 API 地址。')
  const apiKey = formKey || storedKey
  if (!apiKey) throw new Error(profile ? '请先填写 API Key，或先保存这个模型的 API Key 再测试。' : '请先填写 API Key。')

  const baseUrl = cleanBaseUrl(rawBaseUrl)
  // 优先用供应商名称，其次是模型名称；都没有时退回域名，至少能看出测的是哪个地址。
  let host = ''
  try { host = new URL(baseUrl).host } catch { host = '' }
  const label = formProvider || String(profile?.providerName ?? '').trim() || formModel || String(profile?.model ?? '').trim() || host
  // 表单内容与已保存内容不一致时提示用户保存，避免“测通了但实际没用上”。
  const changed = Boolean((formBaseUrl && formBaseUrl !== savedBaseUrl) || (formKey && formKey !== storedKey))
  return { baseUrl, apiKey, label, unsaved: !profile || changed }
}

export function testConnectionMessage({ label = '', unsaved = false } = {}) {
  const who = String(label || '').trim() || '当前模型'
  return unsaved
    ? `连接成功（${who}）。这份连接信息还没保存，记得点“保存模型”。`
    : `连接成功（${who}）。`
}

// “检查模型”和“测试连接”用同一套取值规则：表单优先，留空回退到该模型自己的已保存值。
export function resolveListTarget({ profile = null, input = {}, savedKey = '' } = {}) {
  const formBaseUrl = String(input?.baseUrl ?? '').trim()
  const formKey = String(input?.apiKey ?? '').trim()
  const rawBaseUrl = formBaseUrl || String(profile?.baseUrl ?? '').trim()
  if (!rawBaseUrl) throw new Error('请先填写模型服务 API 地址。')
  const apiKey = formKey || String(savedKey ?? '').trim()
  if (!apiKey) throw new Error(profile ? '请先填写 API Key，或先保存这个模型的 API Key 再检查模型。' : '请先填写 API Key，再检查模型。')
  return { baseUrl: cleanBaseUrl(rawBaseUrl), apiKey }
}
