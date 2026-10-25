import test from 'node:test'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { MAX_READING_WINDOWS, isWithinReadingWindows, nextReadingWindowStart, normalizeReadingWindows, readingWindowState } from '../src/main/reading-window.js'

const localTime = (hour, minute = 0, day = 23) => new Date(2026, 9, day, hour, minute, 0)

test('normalizes reading windows and drops unknown fields', () => {
  assert.deepEqual(normalizeReadingWindows(undefined), [])
  assert.deepEqual(normalizeReadingWindows(null), [])
  assert.deepEqual(normalizeReadingWindows([]), [])
  assert.deepEqual(normalizeReadingWindows([{ start: '09:00', end: '12:30', extra: true }]), [{ start: '09:00', end: '12:30' }])
})

test('rejects invalid or incomplete reading windows', () => {
  for (const value of [
    [{ start: '9:00', end: '12:00' }],
    [{ start: '24:00', end: '01:00' }],
    [{ start: '09:60', end: '12:00' }],
    [{ start: '09:00', end: '09:00' }],
    [{ start: '', end: '12:00' }],
    [{ start: '09:00' }],
    'not-an-array',
  ]) assert.throws(() => normalizeReadingWindows(value), /读取时间窗/)
  const tooMany = Array.from({ length: MAX_READING_WINDOWS + 1 }, () => ({ start: '09:00', end: '10:00' }))
  assert.throws(() => normalizeReadingWindows(tooMany), /最多设置 12 个读取时间窗/)
  assert.equal(normalizeReadingWindows(tooMany.slice(0, MAX_READING_WINDOWS)).length, MAX_READING_WINDOWS)
})

test('no reading windows means reading is allowed all day', () => {
  assert.equal(isWithinReadingWindows([], localTime(3)), true)
  assert.equal(isWithinReadingWindows(undefined, localTime(23)), true)
  const state = readingWindowState([], localTime(15))
  assert.equal(state.allowed, true)
  assert.deepEqual(state.windows, [])
  assert.match(state.message, /全天可读取/)
})

test('reading windows are start-inclusive and end-exclusive', () => {
  const windows = [{ start: '09:00', end: '12:00' }]
  assert.equal(isWithinReadingWindows(windows, localTime(8, 59)), false)
  assert.equal(isWithinReadingWindows(windows, localTime(9, 0)), true)
  assert.equal(isWithinReadingWindows(windows, localTime(11, 59)), true)
  assert.equal(isWithinReadingWindows(windows, localTime(12, 0)), false)
  assert.equal(isWithinReadingWindows(windows, localTime(22, 0)), false)
})

test('reading windows spanning midnight wrap around the day', () => {
  const windows = [{ start: '23:00', end: '02:00' }]
  assert.equal(isWithinReadingWindows(windows, localTime(23, 30)), true)
  assert.equal(isWithinReadingWindows(windows, localTime(0, 30)), true)
  assert.equal(isWithinReadingWindows(windows, localTime(1, 59)), true)
  assert.equal(isWithinReadingWindows(windows, localTime(2, 0)), false)
  assert.equal(isWithinReadingWindows(windows, localTime(22, 59)), false)
})

test('any matching window allows reading when several are configured', () => {
  const windows = [{ start: '07:00', end: '09:00' }, { start: '20:00', end: '22:00' }]
  assert.equal(isWithinReadingWindows(windows, localTime(8)), true)
  assert.equal(isWithinReadingWindows(windows, localTime(21)), true)
  assert.equal(isWithinReadingWindows(windows, localTime(13)), false)
})

test('finds the next reading window start later today or tomorrow', () => {
  const windows = [{ start: '09:00', end: '12:00' }, { start: '20:00', end: '22:00' }]
  assert.equal(nextReadingWindowStart([], localTime(13)), null)
  assert.deepEqual(nextReadingWindowStart(windows, localTime(8)).label, '09:00')
  assert.equal(nextReadingWindowStart(windows, localTime(8)).tomorrow, false)
  assert.deepEqual(nextReadingWindowStart(windows, localTime(13)).label, '20:00')
  assert.equal(nextReadingWindowStart(windows, localTime(23)).label, '09:00')
  assert.equal(nextReadingWindowStart(windows, localTime(23)).tomorrow, true)
  assert.equal(nextReadingWindowStart(windows, localTime(23)).at.getDate(), 24)
  assert.equal(nextReadingWindowStart([{ start: '06:30', end: '07:00' }], localTime(6, 30)).tomorrow, true)
})

test('reading window state explains whether reading is currently allowed', () => {
  const windows = [{ start: '09:00', end: '12:00' }]
  const open = readingWindowState(windows, localTime(10))
  assert.equal(open.allowed, true)
  assert.match(open.message, /读取时间窗内（09:00–12:00）/)
  const closed = readingWindowState(windows, localTime(13))
  assert.equal(closed.allowed, false)
  assert.match(closed.message, /下一时段 09:00 开始（明天）/)
  assert.deepEqual(closed.windows, windows)
})

test('main process wires automatic reading to the configured reading windows', async () => {
  const source = await readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')
  assert.match(source, /import \{[^}]*\bnormalizeReadingConfig\b[^}]*\} from '\.\/reading-auto\.js'/)
  assert.match(source, /reading: normalizeReadingConfig\(settings\?\.reading\)/)
  assert.match(source, /reading: readReadingConfig\(data\.reading\)/)
  assert.match(source, /handle\('bili:reading-status'/)
  assert.match(source, /handle\('bili:reading-config-save'/)
  assert.match(source, /setInterval\(\(\) => void tickReadingAuto\(\), 30_000\)/)
  assert.match(source, /input\?\.reading === undefined \? existing\.reading/)
  assert.match(source, /readingLastRead: normalizeReadingLastRead\(\{ keyword, sources \}\)/)
})
