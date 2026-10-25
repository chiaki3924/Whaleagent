// 读取时间窗：限制每天允许“B站读取”的时段。
// 与互动时间窗不同：没有任何时间窗表示全天可读；一旦设置，窗口外不能获取候选或发起 AI 筛选。

export const MAX_READING_WINDOWS = 12
const MINUTES_PER_DAY = 24 * 60

function parseClock(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''))
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function formatClock(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function minuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes()
}

function withinWindow(startMinute, endMinute, minute) {
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute
}

export function normalizeReadingWindows(value = []) {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new Error('读取时间窗格式无效。')
  if (value.length > MAX_READING_WINDOWS) throw new Error(`最多设置 ${MAX_READING_WINDOWS} 个读取时间窗。`)
  return value.map((window) => {
    const start = String(window?.start || '')
    const end = String(window?.end || '')
    const startMinute = parseClock(start)
    const endMinute = parseClock(end)
    if (startMinute === null || endMinute === null || startMinute === endMinute) {
      throw new Error('读取时间窗无效，请为每个时间窗设置不同的 HH:MM 开始和结束时间。')
    }
    return { start, end }
  })
}

export function isWithinReadingWindows(windowsInput = [], date = new Date()) {
  const windows = normalizeReadingWindows(windowsInput)
  if (windows.length === 0) return true
  const minute = minuteOfDay(date)
  return windows.some(({ start, end }) => withinWindow(parseClock(start), parseClock(end), minute))
}

export function nextReadingWindowStart(windowsInput = [], date = new Date()) {
  const windows = normalizeReadingWindows(windowsInput)
  if (windows.length === 0) return null
  const now = minuteOfDay(date)
  let best = null
  for (const { start } of windows) {
    const startMinute = parseClock(start)
    let delta = startMinute - now
    if (delta <= 0) delta += MINUTES_PER_DAY
    if (best === null || delta < best.delta) best = { delta, startMinute }
  }
  if (best === null) return null
  const at = new Date(date.getTime())
  at.setSeconds(0, 0)
  at.setMinutes(at.getMinutes() + best.delta)
  const tomorrow = at.getFullYear() !== date.getFullYear()
    || at.getMonth() !== date.getMonth()
    || at.getDate() !== date.getDate()
  return { start: formatClock(best.startMinute), at, label: formatClock(best.startMinute), tomorrow }
}

export function readingWindowState(windowsInput = [], date = new Date()) {
  const windows = normalizeReadingWindows(windowsInput)
  if (windows.length === 0) return { allowed: true, windows: [], message: '未设置读取时间窗：全天可读取。' }
  const minute = minuteOfDay(date)
  const active = windows.find(({ start, end }) => withinWindow(parseClock(start), parseClock(end), minute))
  if (active) {
    return { allowed: true, windows, active, message: `当前在读取时间窗内（${active.start}–${active.end}）。` }
  }
  const next = nextReadingWindowStart(windows, date)
  return {
    allowed: false,
    windows,
    active: null,
    message: next
      ? `当前不在读取时间窗内；下一时段 ${next.label} 开始${next.tomorrow ? '（明天）' : ''}。`
      : '当前不在读取时间窗内。',
  }
}
