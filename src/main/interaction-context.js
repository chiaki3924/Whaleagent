// 互动回复的会话上下文：只保留最近若干条消息，并区分“我说的”和“对方说的”。
// 这段内容会随提示词发给模型，所以必须做长度预算和字符清洗，不能原样透传。
import { normalizeImageRefs } from './interaction-images.js'

export const CONTEXT_MAX_ITEMS = 20
export const CONTEXT_MAX_ITEM_CHARS = 500
export const CONTEXT_MAX_CHARS = 4000
export const CONTEXT_MAX_IMAGES_PER_ENTRY = 4

export const CONTEXT_SPEAKER_SELF = 'self'
export const CONTEXT_SPEAKER_OTHER = 'other'
export const CONTEXT_SELF_LABEL = '我'

function cleanText(value, max = CONTEXT_MAX_ITEM_CHARS) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function cleanId(value) {
  return String(value ?? '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 32)
}

export function normalizeContextEntry(value) {
  const text = cleanText(value?.text ?? value?.message)
  const images = normalizeImageRefs(value?.images, { max: CONTEXT_MAX_IMAGES_PER_ENTRY })
  // 一条纯图片消息没有文字，但它仍然是有效的上下文。
  if (!text && !images.length) return null
  const timestamp = Number(value?.timestamp)
  return {
    speaker: value?.speaker === CONTEXT_SPEAKER_SELF ? CONTEXT_SPEAKER_SELF : CONTEXT_SPEAKER_OTHER,
    speakerId: cleanId(value?.speakerId),
    name: cleanText(value?.name, 40),
    text,
    images,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
  }
}

// 同一楼层里可能有多个“对方”。model 需要能分清是谁在说话，所以按发言人给稳定标签：
// 只有一个对方时叫“对方”，有多个时按首次出现顺序编号“对方1/对方2”。
// 标签由本地生成，原始 UID 不发给模型——模型只需要“是不是同一个人”，不需要第三方标识符。
function assignLabels(entries) {
  const groups = new Map()
  // 没有 speakerId/昵称时一律归为同一个“对方”：编造编号会让同一个陌生人被拆成两个人，
  // 而 B站 的评论和私信条目都带 mid，真实场合并不会走到这个兜底。
  const keyFor = (entry) => entry.speakerId || entry.name || 'unknown'
  entries.forEach((entry) => {
    if (entry.speaker === CONTEXT_SPEAKER_SELF) return
    const key = keyFor(entry)
    if (!groups.has(key)) groups.set(key, groups.size + 1)
  })
  const many = groups.size > 1
  return entries.map((entry) => ({
    ...entry,
    label: entry.speaker === CONTEXT_SPEAKER_SELF
      ? CONTEXT_SELF_LABEL
      : (many ? `对方${groups.get(keyFor(entry))}` : '对方'),
  }))
}

// 先按时间取最近 maxItems 条，再从最新往回累加字数；超预算时丢弃最旧的消息，
// 保证越靠近当前触发消息的上下文越完整。
export function normalizeInteractionContext(items, { maxItems = CONTEXT_MAX_ITEMS, maxChars = CONTEXT_MAX_CHARS } = {}) {
  const list = (Array.isArray(items) ? items : [])
    .map(normalizeContextEntry)
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp)
    .filter((entry, index, all) => {
      // 只去掉“同一人 + 同内容 + 同一时间戳”的重复项：那基本是接口重复返回。
      // 隔开或在别的时间点重复的同样内容（例如对方连发两次“在吗”）是正常对话，必须保留。
      const previous = all[index - 1]
      if (!previous) return true
      return !(previous.speaker === entry.speaker && previous.text === entry.text && previous.timestamp === entry.timestamp)
    })
  const limited = list.slice(-maxItems)
  const kept = []
  let total = 0
  for (let index = limited.length - 1; index >= 0; index -= 1) {
    const entry = limited[index]
    total += entry.text.length
    if (total > maxChars) break
    kept.unshift(entry)
  }
  return assignLabels(kept)
}

// 诊断日志只记录条数，不记录任何消息正文或图片地址。
export function describeInteractionContext(context) {
  const list = Array.isArray(context) ? context : []
  if (!list.length) return '无'
  const self = list.filter((entry) => entry.speaker === CONTEXT_SPEAKER_SELF).length
  const images = list.reduce((sum, entry) => sum + (Array.isArray(entry.images) ? entry.images.length : 0), 0)
  const speakers = new Set(list.map((entry) => entry.label || entry.speaker)).size
  return `${list.length} 条（自己 ${self} 条，对方 ${list.length - self} 条${speakers > 2 ? `，${speakers - 1} 人` : ''}${images ? `，图片 ${images} 张` : ''}）`
}
