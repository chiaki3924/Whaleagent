import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ANALYSIS_SYSTEM_PROMPT,
  DIARY_SYSTEM_PROMPT,
  INTERACTION_SYSTEM_PROMPT,
  PREFERENCE_ADAPTER_NOTE,
  PERSONA_ADAPTER_NOTE,
  PERSONA_MAX_CHARS,
  REPORT_DM_SYSTEM_PROMPT,
  composeSystemPrompt,
  emptyPersona,
  listSystemPrompts,
  normalizePersona,
  personaIsEmpty,
  personaText,
  preferenceSection,
  readSavedPersona,
} from '../src/main/prompts.js'
import { buildAnalysisPrompt, formatAnalysisReport } from '../src/main/model.js'

test('migrates a legacy string persona into custom content', () => {
  assert.deepEqual(normalizePersona('  称呼我为老板  '), { ...emptyPersona(), custom: '称呼我为老板' })
  assert.deepEqual(normalizePersona(''), emptyPersona())
  assert.deepEqual(normalizePersona({ custom: 'x' }), { ...emptyPersona(), custom: 'x' })
})

test('normalizes modular persona fields and strips control characters', () => {
  assert.deepEqual(normalizePersona({
    ownerUid: ' 12345 ',
    ownerNickname: ' 鲸鱼 ',
    selfUid: '67890',
    selfNickname: '小鲸',
    realName: '鲸',
    ownerTitle: '主人',
    selfClaim: '人家',
    custom: '  语气简短。\r\n',
  }), {
    ownerUid: '12345',
    ownerNickname: '鲸鱼',
    selfUid: '67890',
    selfNickname: '小鲸',
    realName: '鲸',
    ownerTitle: '主人',
    selfClaim: '人家',
    custom: '语气简短。',
  })
})

test('rejects non-numeric UIDs and overlong persona fields', () => {
  assert.throws(() => normalizePersona({ ownerUid: 'abc' }), /主人UID只能填写数字/)
  assert.throws(() => normalizePersona({ selfUid: '12 34' }), /自己UID只能填写数字/)
  assert.throws(() => normalizePersona({ ownerNickname: 'x'.repeat(51) }), /主人昵称最多 50 个字符/)
  assert.throws(() => normalizePersona({ custom: 'x'.repeat(PERSONA_MAX_CHARS + 1) }), /自定义人设内容最多 2000 个字符/)
})

test('tolerates oversized legacy persona values when reading settings', () => {
  const saved = readSavedPersona({ ownerNickname: 'x'.repeat(60), custom: 'y'.repeat(PERSONA_MAX_CHARS + 5) })
  assert.equal(saved.ownerNickname.length, 50)
  assert.equal(saved.custom.length, PERSONA_MAX_CHARS)
  assert.equal(readSavedPersona('旧人设').custom, '旧人设')
  assert.deepEqual(readSavedPersona(null), emptyPersona())
})

test('combines modular identity and custom content into the persona text', () => {
  const text = personaText({
    ownerUid: '1',
    ownerNickname: '阿鲸',
    selfUid: '2',
    selfNickname: '小鲸',
    realName: '鲸',
    ownerTitle: '主人',
    selfClaim: '人家',
    custom: '语气简短。',
  })
  assert.match(text, /【模块化人设】/)
  assert.match(text, /主人（使用者）：昵称「阿鲸」，UID 1/)
  assert.match(text, /自己（你）：昵称「小鲸」，UID 2/)
  assert.match(text, /你的真实名字：鲸/)
  assert.match(text, /你如何称呼主人：主人/)
  assert.match(text, /你如何自称：人家/)
  assert.match(text, /【自定义人设】\n语气简短。/)
  assert.ok(text.indexOf('【模块化人设】') < text.indexOf('【自定义人设】'))
})

test('omits empty persona sections instead of emitting blank labels', () => {
  assert.equal(personaText({}), '')
  assert.equal(personaText(''), '')
  assert.equal(personaText({ ownerNickname: '阿鲸' }), '【模块化人设】\n- 主人（使用者）：昵称「阿鲸」')
  assert.equal(personaText({ custom: '只用自定义。' }), '【自定义人设】\n只用自定义。')
})

test('detects whether any persona content is set', () => {
  assert.equal(personaIsEmpty({}), true)
  assert.equal(personaIsEmpty({ custom: '   ' }), true)
  assert.equal(personaIsEmpty({ ownerUid: '1' }), false)
})

test('appends the combined persona after the fixed system prompt with adapter rules', () => {
  const composed = composeSystemPrompt(ANALYSIS_SYSTEM_PROMPT, {
    ownerUid: '123',
    selfClaim: '小鲸',
    custom: '称呼我为老板。',
  })
  assert.ok(composed.startsWith(ANALYSIS_SYSTEM_PROMPT))
  assert.ok(composed.includes(PERSONA_ADAPTER_NOTE))
  assert.ok(composed.indexOf('UID 123') > composed.indexOf(ANALYSIS_SYSTEM_PROMPT))
  assert.ok(composed.indexOf('称呼我为老板。') > composed.indexOf('UID 123'))
  assert.match(composed, /<<<人设开始>>>\n【模块化人设】[\s\S]*【自定义人设】\n称呼我为老板。\n<<<人设结束>>>/)
})

test('returns the fixed system prompt unchanged without a persona', () => {
  assert.equal(composeSystemPrompt(ANALYSIS_SYSTEM_PROMPT, ''), ANALYSIS_SYSTEM_PROMPT)
  assert.equal(composeSystemPrompt(ANALYSIS_SYSTEM_PROMPT, {}), ANALYSIS_SYSTEM_PROMPT)
  assert.equal(composeSystemPrompt(ANALYSIS_SYSTEM_PROMPT, { ownerUid: '   ' }), ANALYSIS_SYSTEM_PROMPT)
})

test('lists the running system prompts as read-only, non-empty entries', () => {
  const prompts = listSystemPrompts()
  assert.deepEqual(prompts.map((prompt) => prompt.id), ['analysis', 'interaction', 'diary', 'report-dm', 'content-preferences', 'persona-adapter'])
  for (const prompt of prompts) {
    assert.equal(typeof prompt.title, 'string')
    assert.ok(prompt.title.length > 0)
    assert.equal(typeof prompt.purpose, 'string')
    assert.ok(prompt.purpose.length > 0)
    assert.equal(typeof prompt.content, 'string')
    assert.ok(prompt.content.trim().length > 0)
  }
  assert.equal(prompts[0].content, ANALYSIS_SYSTEM_PROMPT)
  assert.equal(prompts[1].content, INTERACTION_SYSTEM_PROMPT)
  assert.equal(prompts[2].content, DIARY_SYSTEM_PROMPT)
  assert.equal(prompts[3].content, REPORT_DM_SYSTEM_PROMPT)
  assert.equal(prompts[4].content, PREFERENCE_ADAPTER_NOTE)
  assert.equal(prompts[5].content, PERSONA_ADAPTER_NOTE)
})

test('content preferences are a trusted task requirement outside the persona block', () => {
  const empty = preferenceSection('')
  assert.match(empty, /主人尚未填写内容偏好/)
  assert.doesNotMatch(empty, /<<<人设开始>>>/)

  const filled = preferenceSection('  只看硬核技术  ')
  assert.match(filled, /只看硬核技术/)
  assert.match(filled, /可信的任务要求/)
  assert.match(filled, /不可信/)

  const composed = buildAnalysisPrompt([{ bvid: 'BV1234567890', title: '标题', author: 'UP', follows: false }], '只看硬核技术', { ownerNickname: '老板' })
  assert.match(composed.system, /【主人偏好】/)
  assert.match(composed.system, /只看硬核技术/)
  // 偏好必须落在人设块之外，避免被“人设只影响语气”的适配规则降级。
  assert.ok(composed.system.indexOf('【主人偏好】') < composed.system.indexOf(PERSONA_ADAPTER_NOTE))
  assert.equal(JSON.parse(composed.user).preferences, undefined)
})

test('followed UP videos are flagged for the model and marked in the report', () => {
  const followedPrompt = buildAnalysisPrompt([{ bvid: 'BV1234567890', title: '关注的视频', author: 'UP', source: '关注动态', followed: true }], '')
  assert.match(followedPrompt.system, /【已关注 UP 主】/)
  assert.equal(JSON.parse(followedPrompt.user).videos[0].fromFollowedUp, true)
  assert.equal(JSON.parse(followedPrompt.user).videos[0].source, '关注动态')

  const plainPrompt = buildAnalysisPrompt([{ bvid: 'BV1234567890', title: '普通视频', author: 'UP' }], '')
  assert.doesNotMatch(plainPrompt.system, /【已关注 UP 主】/)
  assert.equal(JSON.parse(plainPrompt.user).videos[0].fromFollowedUp, false)

  const report = formatAnalysisReport(
    [{ bvid: 'BV1234567890', title: '关注的视频', author: 'UP', source: '关注动态', followed: true, subtitle: '字幕' }],
    { items: [{ bvid: 'BV1234567890', score: 8, reason: '值得看', summary: '概述' }] },
    new Date('2026-01-01T00:00:00Z'),
    '只看硬核技术',
  )
  assert.match(report, /- 来源：关注动态（已关注 UP 主）/)
  assert.match(report, /内容偏好：只看硬核技术/)
  assert.match(formatAnalysisReport(
    [{ bvid: 'BV1234567890', title: 't', author: 'UP', subtitle: '字幕' }],
    { items: [{ bvid: 'BV1234567890', score: 8, reason: 'r', summary: 's' }] },
  ), /内容偏好：未填写（仅按视频内容判断）/)
})
