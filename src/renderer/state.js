export function isModelReady(settings) {
  if (settings?.modelReady === true) return true
  if (Array.isArray(settings?.models)) return settings.models.some((profile) => profileIsReady(profile))
  return Boolean(String(settings?.baseUrl || '').trim() && String(settings?.model || '').trim() && settings?.hasApiKey === true)
}

// 与主进程 profileIsReady 保持一致：地址、模型名和 Key 三者齐全才算可用。
export function profileIsReady(profile) {
  return Boolean(String(profile?.baseUrl || '').trim() && String(profile?.model || '').trim() && profile?.hasApiKey === true)
}

export function profileLabel(profile) {
  const provider = String(profile?.providerName || '').trim()
  const model = String(profile?.model || '').trim()
  if (provider && model) return `${provider}（${model}）`
  return provider || model || '未命名模型'
}

// 首选失败才会用备用；这里只做展示顺序，真正调用顺序由主进程决定。
export function orderedModels(models, primaryModelId, fallbackModelId) {
  const list = Array.isArray(models) ? models : []
  const primary = list.find((profile) => profile.id === primaryModelId) || list[0] || null
  const ordered = primary ? [primary] : []
  const fallback = list.find((profile) => profile.id === fallbackModelId)
  if (fallback && fallback.id !== primary?.id) ordered.push(fallback)
  return { ordered, primary, fallback: ordered[1] || null }
}

export function canAnalyze({ modelReady, biliLoggedIn, selectedCount }) {
  return modelReady === true
    && biliLoggedIn === true
    && Number.isInteger(selectedCount)
    && selectedCount >= 1
    && selectedCount <= 3
}

// 关键词来源勾选但关键词留空、同时选择了关注/首页时，跳过关键词而不阻断整次读取。
export function resolveSearchRequest({ keywordChecked, keyword, followingChecked, homepageChecked }) {
  const term = keywordChecked ? String(keyword || '').trim() : ''
  if (!keywordChecked && !followingChecked && !homepageChecked) return { error: '请至少选择一个视频来源。' }
  if (keywordChecked && !term && !followingChecked && !homepageChecked) {
    return { error: '关键词搜索已启用，请输入关键词；或取消关键词来源。' }
  }
  const sources = []
  if (keywordChecked && term) sources.push('keyword')
  if (followingChecked) sources.push('following')
  if (homepageChecked) sources.push('homepage')
  return {
    sources,
    keyword: term,
    note: keywordChecked && !term ? '关键词为空，已跳过关键词搜索。' : '',
  }
}

const PERSONA_TEXT_FIELDS = ['ownerUid', 'ownerNickname', 'selfUid', 'selfNickname', 'realName', 'ownerTitle', 'selfClaim', 'custom']

function personaValues(value) {
  if (typeof value === 'string') return { custom: value }
  return value && typeof value === 'object' ? value : {}
}

export function personaDirty(value, savedPersona) {
  const current = personaValues(value)
  const saved = personaValues(savedPersona)
  return PERSONA_TEXT_FIELDS.some((key) => String(current[key] ?? '').trim() !== String(saved[key] ?? '').trim())
}

export function personaIsEmpty(value) {
  const persona = personaValues(value)
  return PERSONA_TEXT_FIELDS.every((key) => !String(persona[key] ?? '').trim())
}
