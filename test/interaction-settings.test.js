import test from 'node:test'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { interactionSettingsReady } from '../src/main/interaction-settings.js'
import { normalizeInteractionSettings, interactionEnabled } from '../src/main/interaction-state.js'

test('main process imports the interaction enablement guard used by settings save', async () => {
  const source = await readFile(new URL('../src/main/index.js', import.meta.url), 'utf8')
  assert.match(source, /import \{[^}]*\binteractionEnabled\b[^}]*\} from '\.\/interaction-state\.js'/)
  assert.match(source, /import \{[^}]*\bisWithinInteractionSchedule\b[^}]*\} from '\.\/interaction-state\.js'/)
})
test('interaction monitor only starts when all safety prerequisites are met', () => {
  const base = { commentsEnabled: true, dmEnabled: false, intervalMinutes: 5, dailyLimit: 5, scheduleWindows: [{ start: '09:00', end: '18:00' }] }
  const ready = { interaction: base, baseUrl: 'https://api.example.com/v1', model: 'deepseek-v4.1-flash', hasApiKey: true, biliLoggedIn: true }
  assert.equal(interactionSettingsReady(ready), true)
  assert.equal(interactionSettingsReady({ ...ready, interaction: { ...base, intervalMinutes: 0 } }), false)
  assert.equal(interactionSettingsReady({ ...ready, interaction: { ...base, dailyLimit: 0 } }), false)
  assert.equal(interactionSettingsReady({ ...ready, interaction: { ...base, scheduleWindows: [] } }), false)
  assert.equal(interactionSettingsReady({ ...ready, baseUrl: '' }), false)
  assert.equal(interactionSettingsReady({ ...ready, model: '  ' }), false)
  assert.equal(interactionSettingsReady({ ...ready, hasApiKey: false }), false)
  assert.equal(interactionSettingsReady({ ...ready, biliLoggedIn: false }), false)
})

test('an empty interval disables polling and comment and DM switches work independently', () => {
  const empty = normalizeInteractionSettings({ commentsEnabled: true, intervalMinutes: '', dailyLimit: 1, scheduleWindows: [{ start: '00:00', end: '23:59' }] })
  assert.equal(empty.intervalMinutes, 0)
  assert.equal(interactionEnabled(empty), false)
  for (const interaction of [
    { commentsEnabled: true, dmEnabled: false, intervalMinutes: 5, dailyLimit: 1, scheduleWindows: [{ start: '00:00', end: '23:59' }] },
    { commentsEnabled: false, dmEnabled: true, intervalMinutes: 5, dailyLimit: 1, scheduleWindows: [{ start: '00:00', end: '23:59' }] },
  ]) assert.equal(interactionSettingsReady({ interaction, baseUrl: 'https://api.example.com/v1', model: 'm', hasApiKey: true, biliLoggedIn: true }), true)
})
