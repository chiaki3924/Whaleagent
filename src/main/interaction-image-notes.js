// 图片识图结果的短期记忆：模型看过某张图后，把它的文字描述缓存起来。
//
// 为什么需要：追问“图里那个人穿的什么”时，那张图往往已经不在触发消息里了，
// 只把图片重新附一遍既费 token，也不保证模型这次还看得见。把上次的识图结论
// 放进历史，模型就有据可回。
//
// 只存内存：描述内容来自用户私信里的图片，属于敏感数据，不做持久化；
// 应用重启后最多重新识图一次。键用图片 URL 的哈希，避免明文地址进入内存快照之外的地方。
import { createHash } from 'node:crypto'

export const IMAGE_NOTE_MAX_ENTRIES = 200
export const IMAGE_NOTE_MAX_CHARS = 240

const notes = new Map()

function keyOf(url) {
  const value = String(url || '').trim()
  if (!value) return ''
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function cleanText(value, max = IMAGE_NOTE_MAX_CHARS) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export function rememberImageNote(url, description) {
  const key = keyOf(url)
  const text = cleanText(description)
  if (!key || !text) return ''
  // 重新识图时覆盖旧结论，并把该键移到队尾（最近使用）。
  notes.delete(key)
  notes.set(key, text)
  while (notes.size > IMAGE_NOTE_MAX_ENTRIES) {
    const oldest = notes.keys().next()
    if (oldest.done) break
    notes.delete(oldest.value)
  }
  return text
}

export function imageNoteFor(url) {
  const key = keyOf(url)
  if (!key) return ''
  const text = notes.get(key)
  if (!text) return ''
  // 命中即刷新热度，避免长会话里把还在用的条目挤掉。
  notes.delete(key)
  notes.set(key, text)
  return text
}

export function imageNoteCount() {
  return notes.size
}

export function clearImageNotes() {
  notes.clear()
}

// 工具：把模型返回的 [{index, description}] 与本次实际附上的图片顺序对齐。
export function alignImageNotes(entries, urls) {
  const list = Array.isArray(urls) ? urls : []
  const aligned = []
  const seen = new Set()
  for (const entry of Array.isArray(entries) ? entries : []) {
    const index = Number(entry?.index)
    if (!Number.isInteger(index) || index < 1 || index > list.length) continue
    if (seen.has(index)) continue
    const text = cleanText(entry?.description)
    if (!text) continue
    seen.add(index)
    aligned.push({ url: list[index - 1], index, description: text })
  }
  return aligned
}
