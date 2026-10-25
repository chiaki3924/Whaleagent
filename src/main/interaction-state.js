import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const MAX_SEEN = 10000
const MAX_WINDOWS = 12
const MAX_DAILY_SENDS = 500

function parseClock(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''))
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

export function normalizeInteractionSettings(value = {}) {
  const intervalMinutes = value.intervalMinutes === '' || value.intervalMinutes == null ? 0 : Number(value.intervalMinutes)
  const dailyLimit = value.dailyLimit === '' || value.dailyLimit == null ? 0 : Number(value.dailyLimit)
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 0 || intervalMinutes > 1440) throw new Error('监听间隔必须为 0 到 1440 之间的整数分钟。')
  if (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > MAX_DAILY_SENDS) throw new Error(`每日发送上限必须为 0 到 ${MAX_DAILY_SENDS} 之间的整数。`)
  const inputWindows = Array.isArray(value.scheduleWindows) ? value.scheduleWindows : []
  if (inputWindows.length > MAX_WINDOWS) throw new Error(`最多设置 ${MAX_WINDOWS} 个互动时间窗。`)
  const scheduleWindows = inputWindows.map((window) => {
    const start = String(window?.start || '')
    const end = String(window?.end || '')
    const startMinute = parseClock(start)
    const endMinute = parseClock(end)
    if (startMinute === null || endMinute === null || startMinute === endMinute) throw new Error('互动时间窗无效，请设置不同的 HH:MM 开始和结束时间。')
    return { start, end }
  })
  return {
    commentsEnabled: value.commentsEnabled === true,
    dmEnabled: value.dmEnabled === true,
    intervalMinutes,
    dailyLimit,
    scheduleWindows,
  }
}

export function isWithinInteractionSchedule(settings, date = new Date()) {
  const normalized = normalizeInteractionSettings(settings)
  if (!normalized.scheduleWindows.length) return false
  const minute = date.getHours() * 60 + date.getMinutes()
  return normalized.scheduleWindows.some(({ start, end }) => {
    const begin = parseClock(start)
    const finish = parseClock(end)
    return begin < finish ? minute >= begin && minute < finish : minute >= begin || minute < finish
  })
}

export function interactionEnabled(settings) {
  const normalized = normalizeInteractionSettings(settings)
  return (normalized.commentsEnabled || normalized.dmEnabled)
    && normalized.intervalMinutes > 0
    && normalized.dailyLimit > 0
    && normalized.scheduleWindows.length > 0
}

export function localDayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function createInteractionState(previous = {}, now = new Date()) {
  const day = localDayKey(now)
  return {
    version: 1,
    initialized: previous.initialized === true,
    seenIds: Array.isArray(previous.seenIds) ? previous.seenIds.filter((id) => typeof id === 'string').slice(-MAX_SEEN) : [],
    enabledSources: Array.isArray(previous.enabledSources) ? previous.enabledSources.filter((id) => ['comments', 'dm'].includes(id)) : [],
    daily: previous.daily?.date === day && Number.isInteger(previous.daily?.count) && previous.daily.count >= 0
      ? { date: day, count: previous.daily.count }
      : { date: day, count: 0 },
    pausedReason: typeof previous.pausedReason === 'string' ? previous.pausedReason.slice(0, 240) : '',
  }
}

export function interactionSourceList(settings) {
  const normalized = normalizeInteractionSettings(settings)
  return [normalized.commentsEnabled ? 'comments' : null, normalized.dmEnabled ? 'dm' : null].filter(Boolean)
}

export function planInteractionEvents(settings, previousState, events, now = new Date()) {
  const state = createInteractionState(previousState, now)
  const enabled = new Set(interactionSourceList(settings))
  const validEvents = (Array.isArray(events) ? events : []).filter((event) => enabled.has(event?.source) && typeof event.id === 'string')
  const seen = new Set(state.seenIds)
  if (!state.initialized) {
    for (const event of validEvents) seen.add(event.id)
    state.seenIds = [...seen].slice(-MAX_SEEN)
    state.enabledSources = [...enabled]
    state.initialized = true
    return { state, baseline: true, events: [] }
  }
  const justEnabled = new Set([...enabled].filter((source) => !state.enabledSources.includes(source)))
  const fresh = []
  for (const event of validEvents.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))) {
    if (seen.has(event.id)) continue
    if (justEnabled.has(event.source)) seen.add(event.id)
    else fresh.push(event)
  }
  state.seenIds = [...seen].slice(-MAX_SEEN)
  state.enabledSources = [...enabled]
  return { state, baseline: false, events: fresh }
}

export function markInteractionEventSeen(stateInput, eventId) {
  const state = { ...stateInput, seenIds: [...(stateInput.seenIds ?? [])] }
  if (!state.seenIds.includes(eventId)) state.seenIds.push(eventId)
  state.seenIds = state.seenIds.slice(-MAX_SEEN)
  return state
}

export function interactionEventId(event) {
  const identity = [event?.source, event?.senderId, event?.timestamp, event?.text, event?.parent, event?.messageKey].map((part) => String(part ?? '')).join('|')
  return createHash('sha256').update(identity).digest('hex')
}

export function canSendInteraction(settings, stateInput, now = new Date()) {
  const settingsNormalized = normalizeInteractionSettings(settings)
  const state = createInteractionState(stateInput, now)
  return interactionEnabled(settingsNormalized)
    && !state.pausedReason
    && state.daily.count < settingsNormalized.dailyLimit
    && isWithinInteractionSchedule(settingsNormalized, now)
}

export function recordInteractionSent(stateInput, now = new Date()) {
  const state = createInteractionState(stateInput, now)
  state.daily.count += 1
  return state
}

export function pauseInteractionState(stateInput, reason, now = new Date()) {
  const state = createInteractionState(stateInput, now)
  state.pausedReason = String(reason || '平台风控或验证要求，互动已暂停。').slice(0, 240)
  return state
}

export async function readInteractionState(statePath, now = new Date()) {
  try { return createInteractionState(JSON.parse(await fs.readFile(statePath, 'utf8')), now) }
  catch (error) {
    if (error.code === 'ENOENT') return createInteractionState({}, now)
    throw new Error('互动状态文件损坏或无法读取；为避免重复发送，互动已停止。')
  }
}

export async function writeInteractionState(statePath, state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true })
  const tempPath = `${statePath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await fs.rename(tempPath, statePath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

export function isInteractionRiskError(error) {
  return /验证码|风控|请求过于频繁|操作频繁|risk control|captcha|too frequent/i.test(String(error?.message ?? error ?? ''))
}

export function normalizeReplyText(value, maxLength = 300) {
  const text = String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim()
  if (!text) throw new Error('生成的互动回复为空。')
  if (text.length > maxLength) throw new Error(`互动回复超过 ${maxLength} 字限制。`)
  if (/https?:\/\/|www\./i.test(text)) throw new Error('互动回复包含外链，已拒绝自动发送。')
  return text
}
