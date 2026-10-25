import { isModelReady, canAnalyze, personaDirty, personaIsEmpty, resolveSearchRequest, profileIsReady, profileLabel, orderedModels } from './state.js'

const $ = (id) => document.getElementById(id)
const status = $('status')
let loginPollTimer = null
let pollInFlight = false
const selectedBvids = new Set()
const selectedVideos = new Map()
let searchPage = 1
let searchHasNext = false
let searchKeyword = ''
let searchSources = ['keyword', 'following', 'homepage']
let searchSkipNote = ''
let readingConfigRendered = false
let readingSaveTimer = null
let autoReportSeen = ''
let diaryState = null
let diaryWriting = false
let diaryLastRunAt = ''
// 第一次读到状态时只做基线，避免把启动前就存在的 lastRunAt 误判成“刚刚写好”。
let diaryStateObserved = false
let diaryConfigRendered = false
let modelReady = false
let biliLoggedIn = false
let biliMid = ''
let pendingAnalysisBvids = []
let savedPersona = {}
let savedPersonaAt = ''
let customPersonaLimit = 2000
let savedPreferences = ''
let preferencesRendered = false
let preferenceLimit = 1200
let providerModels = []
let modelCheckInFlight = false
let models = []
let primaryModelId = ''
let fallbackModelId = ''
let modelLimit = 8
let editingModelId = ''

const PERSONA_INPUTS = [
  ['ownerUid', 'persona-owner-uid'],
  ['ownerNickname', 'persona-owner-nickname'],
  ['selfUid', 'persona-self-uid'],
  ['selfNickname', 'persona-self-nickname'],
  ['realName', 'persona-real-name'],
  ['ownerTitle', 'persona-owner-title'],
  ['selfClaim', 'persona-self-claim'],
  ['custom', 'persona-custom'],
]

function collectPersona() {
  const persona = {}
  for (const [key, id] of PERSONA_INPUTS) persona[key] = $(id).value
  return persona
}

function fillPersonaInputs(persona) {
  for (const [key, id] of PERSONA_INPUTS) $(id).value = String(persona?.[key] ?? '')
}

function clearPersonaError() {
  $('persona-error').classList.add('hidden')
  $('persona-error').textContent = ''
}

function showPersonaError(message, focusId = '') {
  $('persona-error').textContent = message
  $('persona-error').classList.remove('hidden')
  if (focusId) $(focusId).focus()
}

function validatePersonaInputs(values) {
  for (const [key, label, id] of [
    ['ownerUid', '主人UID', 'persona-owner-uid'],
    ['selfUid', '自己UID', 'persona-self-uid'],
  ]) {
    const value = values[key].trim()
    if (value && !/^\d{1,20}$/.test(value)) return { message: `${label}只能填写数字（最多 20 位）。`, id }
  }
  return null
}

function renderPersonaNote() {
  const values = collectPersona()
  const dirty = personaDirty(values, savedPersona)
  const empty = personaIsEmpty(savedPersona)
  const badge = $('persona-state')
  badge.dataset.dirty = String(dirty)
  $('persona-note').dataset.dirty = String(dirty)
  if (dirty) {
    badge.textContent = '有未保存修改'
    $('persona-note').textContent = '当前内容尚未保存；保存后才会用于新的分析和自动回复。'
  } else if (empty) {
    badge.textContent = '尚未设置'
    $('persona-note').textContent = '尚未设置人设；模型将使用中性语气。'
  } else {
    badge.textContent = '已保存'
    const savedAt = new Date(savedPersonaAt)
    $('persona-note').textContent = Number.isFinite(savedAt.getTime())
      ? `已保存于 ${savedAt.toLocaleString('zh-CN')}；之后的分析和自动回复会使用这份人设。`
      : '已保存；之后的分析和自动回复会使用这份人设。'
  }
  $('persona-count').textContent = `${values.custom.length} / ${customPersonaLimit}`
  $('persona-save').disabled = !dirty
  $('persona-reset').disabled = !dirty
}

function renderSystemPrompts(prompts) {
  const list = $('system-prompt-list')
  list.replaceChildren()
  if (!Array.isArray(prompts) || prompts.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'muted'
    empty.textContent = '未能读取系统人设。'
    list.append(empty)
    return
  }
  const fragment = document.createDocumentFragment()
  for (const prompt of prompts) {
    const card = document.createElement('article')
    card.className = 'prompt-card'
    const head = document.createElement('div')
    head.className = 'prompt-card-head'
    const title = document.createElement('h4')
    title.textContent = String(prompt?.title || prompt?.id || '系统提示词')
    const id = document.createElement('span')
    id.textContent = String(prompt?.id || '')
    head.append(title, id)
    const purpose = document.createElement('p')
    purpose.className = 'prompt-purpose'
    purpose.textContent = String(prompt?.purpose || '')
    const content = document.createElement('pre')
    content.className = 'prompt-text'
    content.textContent = String(prompt?.content || '')
    card.append(head, purpose, content)
    fragment.append(card)
  }
  list.append(fragment)
}

function renderPreferencesNote() {
  const value = $('content-preferences').value
  const dirty = value.trim() !== String(savedPreferences || '').trim()
  const badge = $('content-preferences-state')
  badge.dataset.dirty = String(dirty)
  $('content-preferences-count').textContent = `${value.length} / ${preferenceLimit}`
  $('content-preferences-save').disabled = !dirty
  if (dirty) {
    badge.textContent = '有未保存修改'
    $('content-preferences-note').textContent = '当前内容尚未保存；保存后新的筛选才会使用。'
  } else if (!String(savedPreferences || '').trim()) {
    badge.textContent = '未填写'
    $('content-preferences-note').textContent = '未填写时，模型只按视频内容判断，并会在报告里注明。'
  } else {
    badge.textContent = '已保存'
    $('content-preferences-note').textContent = '已保存；自动读取和手动“AI 筛选”都会带上这段偏好。'
  }
}

function applyPreferencesState(state) {
  savedPreferences = String(state?.preferences || '')
  const limit = Number(state?.maxPreferenceChars)
  preferenceLimit = Number.isInteger(limit) && limit > 0 ? limit : 1200
  $('content-preferences').maxLength = preferenceLimit
  if (!preferencesRendered) {
    $('content-preferences').value = savedPreferences
    preferencesRendered = true
  }
  $('content-preferences-error').classList.add('hidden')
  renderPreferencesNote()
}

function applyPromptState(state) {
  savedPersona = state?.persona && typeof state.persona === 'object' ? state.persona : {}
  savedPersonaAt = String(state?.personaUpdatedAt || '')
  const limit = Number(state?.maxCustomChars)
  customPersonaLimit = Number.isInteger(limit) && limit > 0 ? limit : 2000
  $('persona-custom').maxLength = customPersonaLimit
  fillPersonaInputs(savedPersona)
  applyPreferencesState(state)
  renderSystemPrompts(state?.systemPrompts)
  clearPersonaError()
  renderPersonaNote()
}

async function loadPrompts() {
  try { applyPromptState(await window.whaleagent.readPrompts()) }
  catch (error) { notify(error.message, true) }
}

function windowRows(containerId) {
  return [...document.querySelectorAll(`#${containerId} .interaction-window`)]
}

function renderWindowRows(containerId, windows = [], onChange = () => {}) {
  $(containerId).replaceChildren()
  for (const windowValue of windows) addWindowRow(containerId, windowValue, onChange)
}

function addWindowRow(containerId, windowValue = { start: '20:00', end: '22:00' }, onChange = () => {}) {
  const row = document.createElement('div')
  row.className = 'interaction-window'
  for (const [key, labelText] of [['start', '开始'], ['end', '结束']]) {
    const label = document.createElement('label')
    label.textContent = labelText
    const input = document.createElement('input')
    input.type = 'time'
    input.required = true
    input.value = String(windowValue?.[key] || '')
    input.dataset.windowField = key
    input.addEventListener('input', onChange)
    input.addEventListener('change', onChange)
    label.append(input)
    row.append(label)
  }
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'danger'
  remove.textContent = '移除'
  remove.addEventListener('click', () => {
    row.remove()
    onChange()
  })
  row.append(remove)
  $(containerId).append(row)
}

function renderInteractionWindows(windows = []) {
  renderWindowRows('interaction-windows', windows)
}

function addInteractionWindow(windowValue = { start: '20:00', end: '22:00' }) {
  addWindowRow('interaction-windows', windowValue)
}

function collectWindowRows(containerId) {
  return windowRows(containerId).map((row) => ({
    start: row.querySelector('[data-window-field="start"]').value,
    end: row.querySelector('[data-window-field="end"]').value,
  }))
}

function collectInteractionSettings() {
  return {
    commentsEnabled: $('comments-enabled').checked,
    dmEnabled: $('dm-enabled').checked,
    intervalMinutes: $('interaction-interval').value,
    dailyLimit: $('interaction-daily-limit').value,
    scheduleWindows: collectWindowRows('interaction-windows'),
  }
}

function renderReadingWindows(windows = []) {
  renderWindowRows('reading-windows', windows, scheduleReadingSave)
}

function addReadingWindow(windowValue = { start: '20:00', end: '22:00' }) {
  addWindowRow('reading-windows', windowValue, scheduleReadingSave)
}

function formatAutoRunTime(iso) {
  const date = new Date(iso)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : ''
}

function renderReportDmState(state) {
  const dm = state?.reportDm || {}
  const uid = String(dm.recipientUid || '').trim()
  if (!uid) {
    $('report-dm-note').textContent = '尚未填写主人UID；报告生成后不会私信。请到【提示词】填写主人UID。'
  } else if (biliMid && uid === biliMid) {
    $('report-dm-note').textContent = `主人UID 与当前登录账号相同（${uid}），不能私信自己；请换一个收件账号。`
  } else if (!biliLoggedIn) {
    $('report-dm-note').textContent = `收件人：主人 UID ${uid}；B站尚未登录，暂时不会发送。`
  } else {
    $('report-dm-note').textContent = `报告生成后私信给主人 UID ${uid}（今天已发送 ${Number(dm.sentToday) || 0}/${Number(dm.dailyLimit) || 20} 条）。`
  }
  if (dm.lastSentAt) {
    $('report-dm-status').textContent = `上次私信：${formatAutoRunTime(dm.lastSentAt)}，${dm.lastResult || '已发送'}`
  } else if (dm.lastResult) {
    $('report-dm-status').textContent = `上次投递：${dm.lastResult}`
  } else {
    $('report-dm-status').textContent = '尚未发送报告私信。'
  }
}

function applyReadingState(state) {
  const message = String(state?.message || '自动读取状态未知。')
  $('reading-window-status').textContent = message
  $('reading-window-status').dataset.paused = String(state?.autoEnabled === true && state?.allowed === false)
  const auto = state?.auto || {}
  if (auto.running) {
    $('reading-auto-status').textContent = 'agent 正在自动读取…'
  } else if (auto.lastRunAt) {
    $('reading-auto-status').textContent = `上次自动读取：${formatAutoRunTime(auto.lastRunAt)}，${auto.lastResult || '已完成'}`
  } else {
    $('reading-auto-status').textContent = '尚未自动读取。'
  }
  $('reading-auto-status').dataset.running = String(auto.running === true)
  const sourceNames = { keyword: '关键词搜索', following: '关注动态', homepage: '首页推荐' }
  const lastRead = state?.lastRead || {}
  const autoKeyword = String(lastRead.keyword || '').trim()
  const rawSources = Array.isArray(lastRead.sources) ? lastRead.sources.filter((source) => source in sourceNames) : []
  const effectiveSources = rawSources.filter((source) => source !== 'keyword' || autoKeyword)
  const sourceList = (effectiveSources.length ? effectiveSources : ['following', 'homepage']).map((source) => sourceNames[source]).join('、')
  $('reading-auto-source').textContent = `自动读取来源：${sourceList}；关键词：${autoKeyword ? `「${autoKeyword}」` : '无'}。`
  const preferenceText = String(state?.preferences || '').trim()
  $('preferences-summary').textContent = preferenceText
    ? `内容偏好：${preferenceText.length > 90 ? `${preferenceText.slice(0, 90)}…` : preferenceText}（可在【提示词】页修改）`
    : '内容偏好：未填写。可在【提示词】页的“内容偏好”里告诉 agent 主人想看什么风格。'
  renderReportDmState(state)
  if (!readingConfigRendered) {
    renderReadingWindows(Array.isArray(state?.windows) ? state.windows : [])
    $('reading-auto-interval').value = String(state?.autoIntervalMinutes ?? 60)
    const screen = state?.screen || {}
    $('skip-no-subtitle').checked = screen.skipNoSubtitle !== false
    $('title-exclude').value = Array.isArray(screen.titleExclude) ? screen.titleExclude.join('，') : ''
    $('max-age-days').value = String(screen.maxAgeDays ?? 7)
    $('report-dm-enabled').checked = state?.reportDm?.enabled === true
    readingConfigRendered = true
  }
  renderAgeWindowNote(state)
  const report = String(auto.lastReport || '')
  if (report && report !== autoReportSeen) {
    const initial = autoReportSeen === ''
    autoReportSeen = report
    if (!initial) {
      void refreshReports().catch(() => {})
      notify(`agent 已自动保存报告：${report}。可在报告页查看。`)
    }
  }
}

function scheduleReadingSave() {
  if (readingSaveTimer) clearTimeout(readingSaveTimer)
  readingSaveTimer = setTimeout(() => { readingSaveTimer = null; void persistReadingConfig() }, 600)
}

// 界面上只让主人填一个数字；记录保留期由主进程按“窗 + 1 天”推导后回显，
// 这样两个数字不可能被填反，也就不会出现“记录先过期、视频还在窗口内”导致重复推荐。
function renderAgeWindowNote(state) {
  const days = Number(state?.screen?.maxAgeDays ?? 7)
  const retention = Number(state?.historyRetentionDays ?? 0)
  const safeDays = Number.isInteger(days) && days >= 0 ? days : 7
  $('age-window-note').textContent = safeDays > 0
    ? `只推荐最近 ${safeDays} 天发布的视频；已推荐记录自动保留 ${retention || safeDays + 1} 天（比时间窗多 1 天，保证同一条视频不会重复推荐）。`
    : '不限发布时间：只按已推荐记录去重，记录不按时间自动删除。'
}

async function persistReadingConfig() {
  const windows = collectWindowRows('reading-windows')
  if (windows.some((windowValue) => !windowValue.start || !windowValue.end)) {
    $('reading-window-status').textContent = '时间窗尚未填写完整，尚未保存。'
    return
  }
  try {
    applyReadingState(await window.whaleagent.saveReadingConfig({
      windows,
      autoIntervalMinutes: $('reading-auto-interval').value,
      screen: {
        skipNoSubtitle: $('skip-no-subtitle').checked,
        titleExclude: $('title-exclude').value,
        maxAgeDays: $('max-age-days').value,
      },
      reportDm: { enabled: $('report-dm-enabled').checked },
    }))
  } catch (error) {
    notify(error.message, true)
    $('reading-window-status').textContent = `自动读取设置未保存：${error.message}`
  }
}

async function refreshReadingStatus() {
  try {
    applyReadingState(await window.whaleagent.readingStatus())
  } catch (error) {
    $('reading-window-status').textContent = '无法读取自动读取状态。'
  }
}

function renderDiaryConfig(state) {
  $('diary-enabled').checked = state.enabled
  $('diary-auto').checked = state.autoEnabled
  $('diary-public').checked = state.publicEnabled
  $('diary-private').checked = state.privateEnabled
  $('diary-time').value = state.time
  $('diary-retention').value = state.retentionDays
  diaryConfigRendered = true
}

function updateDiaryControls() {
  const hasBooks = Boolean(diaryState?.publicEnabled || diaryState?.privateEnabled)
  $('diary-write').disabled = diaryWriting || !diaryState?.enabled || !hasBooks || !modelReady
  $('diary-save').disabled = diaryWriting
  $('diary-write').title = !modelReady
    ? '请先在【模型设置】中配置模型服务'
    : (!diaryState?.enabled ? '日记总开关已关闭' : '')
}

function applyDiaryState(state) {
  diaryState = state
  if (!diaryConfigRendered) renderDiaryConfig(state)
  const books = []
  if (state.publicEnabled) books.push('给主人看的那本')
  if (state.privateEnabled) books.push('给自己看的那本')
  const counts = state.entryCounts || {}
  const existing = (counts.public?.count || 0) + (counts.private?.count || 0)
  let message
  if (!state.enabled) message = '日记总开关已关闭。'
  else if (!books.length) message = '两本日记都未启用。'
  else if (!state.autoEnabled) message = '自动写日记已关闭；可以随时手动写今天的日记。'
  else message = `每天 ${state.time} 自动写${books.join('和')}。`
  const lastRun = state.lastRunAt
    ? `上次运行：${new Date(state.lastRunAt).toLocaleString('zh-CN')}。${state.lastResult || ''}`
    : (existing ? `已有 ${existing} 篇日记，但还没有记录自动运行。` : '还没有写过日记。')
  $('diary-status').textContent = `${message} ${lastRun}`
  if (!state.enabled || !state.autoEnabled || !books.length) {
    $('diary-next').textContent = '自动写日记未开启。'
  } else if (!modelReady) {
    $('diary-next').textContent = '模型服务未配置，到点也不会写。请先在【模型设置】中配置。'
  } else if (!state.nextRunAt) {
    $('diary-next').textContent = '自动写日记未开启。'
  } else {
    const next = new Date(state.nextRunAt)
    $('diary-next').textContent = next.getTime() - Date.now() <= 60_000
      ? '下次自动写日记：即将开始。'
      : `下次自动写日记：${next.toLocaleString('zh-CN')}。`
  }
  $('diary-retention-note').textContent = `只保留最近 ${state.retentionDays} 天；写新日记时自动删除更早的条目，模型也只读取保留窗口内的日记，以节约上下文。`
  if (diaryStateObserved && state.lastRunAt && state.lastRunAt !== diaryLastRunAt && !diaryWriting) {
    void refreshDiaries()
    const failed = /^写日记失败/.test(state.lastResult || '')
    notify(failed ? state.lastResult : 'agent 已写好今天的日记。', failed)
  }
  diaryStateObserved = true
  diaryLastRunAt = state.lastRunAt || ''
  updateDiaryControls()
}

async function refreshDiaryStatus() {
  try {
    applyDiaryState(await window.whaleagent.diaryStatus())
  } catch (error) {
    $('diary-status').textContent = '无法读取日记状态。'
  }
}

function renderDiaryBook(kind, entries) {
  const list = $(`diary-${kind}-list`)
  const count = $(`diary-${kind}-count`)
  list.replaceChildren()
  const now = new Date()
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  count.textContent = entries.length ? `共 ${entries.length} 篇` : ''
  if (!entries.length) {
    const empty = document.createElement('p')
    empty.className = 'muted diary-empty'
    empty.textContent = '还没有日记。'
    list.append(empty)
    return
  }
  const fragment = document.createDocumentFragment()
  for (const entry of entries) {
    const item = document.createElement('article')
    item.className = 'diary-entry'
    const head = document.createElement('div')
    head.className = 'diary-entry-head'
    const time = document.createElement('time')
    time.dateTime = entry.date
    time.textContent = entry.date
    head.append(time)
    if (entry.date === todayKey) {
      const badge = document.createElement('span')
      badge.className = 'diary-today'
      badge.textContent = '今天'
      head.append(badge)
    }
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = '删除'
    remove.addEventListener('click', async () => {
      if (!window.confirm(`确定删除 ${entry.date} 的这篇日记吗？删除后无法恢复。`)) return
      try {
        await window.whaleagent.deleteDiaryEntry(kind, entry.date)
        await refreshDiaries()
        await refreshDiaryStatus()
        notify(`已删除 ${entry.date} 的日记。`)
      } catch (error) { notify(error.message, true) }
    })
    head.append(remove)
    const text = document.createElement('div')
    text.className = 'diary-entry-text'
    text.textContent = entry.content
    item.append(head, text)
    fragment.append(item)
  }
  list.append(fragment)
}

async function refreshDiaries() {
  try {
    const entries = await window.whaleagent.listDiaries()
    renderDiaryBook('public', entries.public || [])
    renderDiaryBook('private', entries.private || [])
  } catch (error) { notify(error.message, true) }
}

function collectDiaryConfig() {
  return {
    enabled: $('diary-enabled').checked,
    autoEnabled: $('diary-auto').checked,
    publicEnabled: $('diary-public').checked,
    privateEnabled: $('diary-private').checked,
    time: $('diary-time').value,
    retentionDays: $('diary-retention').value,
  }
}

$('diary-save').addEventListener('click', async () => {
  const config = collectDiaryConfig()
  if (config.enabled && !config.publicEnabled && !config.privateEnabled) {
    notify('请至少启用一本日记，或关闭日记总开关。', true)
    return
  }
  if (!/^\d{2}:\d{2}$/.test(config.time)) {
    notify('自动写日记时间请使用 HH:MM 格式。', true)
    return
  }
  const retention = Number(config.retentionDays)
  if (!Number.isInteger(retention) || retention < 1 || retention > 365) {
    notify('保留天数必须是 1 到 365 之间的整数。', true)
    return
  }
  $('diary-save').disabled = true
  try {
    const state = await window.whaleagent.saveDiaryConfig(config)
    diaryConfigRendered = false
    applyDiaryState(state)
    // 缩短保留天数会立刻删掉窗口外的旧日记，列表必须跟着刷新。
    await refreshDiaries()
    notify('日记设置已保存。')
  } catch (error) { notify(error.message, true) }
  finally { updateDiaryControls() }
})

$('diary-write').addEventListener('click', async () => {
  if (diaryWriting) return
  if (!window.confirm('现在写今天的日记？如果今天已经写过，会替换成基于当前活动的新版本。')) return
  diaryWriting = true
  updateDiaryControls()
  notify('正在写今天的日记…')
  try {
    const result = await window.whaleagent.writeDiaryNow()
    diaryWriting = false
    diaryLastRunAt = result.status?.lastRunAt || ''
    if (result.status) applyDiaryState(result.status)
    await refreshDiaries()
    notify(result.message, Boolean(result.failed))
  } catch (error) { notify(error.message, true) }
  finally { diaryWriting = false; updateDiaryControls() }
})

$('diary-refresh').addEventListener('click', async () => {
  await refreshDiaryStatus()
  await refreshDiaries()
  notify('日记已刷新。')
})

$('diary-open-folder').addEventListener('click', async () => {
  try { await window.whaleagent.openDiaryFolder(); notify('已打开日记文件夹。') }
  catch (error) { notify(error.message, true) }
})

$('add-reading-window').addEventListener('click', () => {
  if (windowRows('reading-windows').length >= 12) {
    notify('最多可以设置 12 个读取时间窗。', true)
    return
  }
  addReadingWindow()
  scheduleReadingSave()
})

$('reading-auto-interval').addEventListener('input', scheduleReadingSave)
$('reading-auto-interval').addEventListener('change', scheduleReadingSave)
$('skip-no-subtitle').addEventListener('change', scheduleReadingSave)
$('title-exclude').addEventListener('input', scheduleReadingSave)
$('max-age-days').addEventListener('input', scheduleReadingSave)
$('max-age-days').addEventListener('change', scheduleReadingSave)
$('report-dm-enabled').addEventListener('change', scheduleReadingSave)

async function refreshInteractionStatus() {
  try {
    const current = await window.whaleagent.interactionStatus()
    $('interaction-status').textContent = current.sentToday > 0
      ? `${current.message} 今日发送 ${current.sentToday} 条。`
      : current.message
    $('interaction-status').dataset.paused = String(current.paused)
    $('resume-interaction').classList.toggle('hidden', !current.paused)
  } catch (error) { $('interaction-status').textContent = error.message }
}

setInterval(() => void refreshInteractionStatus(), 15_000)

function updateSelectionControls() {
  $('selection-count').textContent = `已选 ${selectedBvids.size}/3`
  $('bili-analyze').disabled = !canAnalyze({ modelReady, biliLoggedIn, selectedCount: selectedBvids.size })
  $('bili-search').disabled = !biliLoggedIn
  $('bili-keyword').disabled = !biliLoggedIn
}

let notifyTimer = null

// 状态提示浮在右下角，过几秒自动收起；错误停留更久。
function notify(message, error = false) {
  status.textContent = message
  status.dataset.error = String(error)
  if (notifyTimer) clearTimeout(notifyTimer)
  notifyTimer = message ? setTimeout(() => { status.textContent = '' }, error ? 9000 : 4500) : null
}

// 把实际生效的数据目录写在报告页顶部：便携版应显示程序目录，
// 如果程序放在只读位置会显示退化后的用户数据目录。
async function refreshDataInfo() {
  const line = $('data-location')
  try {
    const info = await window.whaleagent.dataInfo()
    const label = info.mode === 'portable' ? '便携模式，随程序目录移动'
      : info.mode === 'custom' ? '由 WHALEAGENT_DATA_DIR 指定'
        : '程序目录不可写，已改用用户数据目录'
    const parts = [`数据目录：${info.rootDir}（${label}）`]
    if (info.subdirs?.images) parts.push(`私信配图放在 ${info.subdirs.images}，文件名写成图片含义`)
    if (info.migrated?.copied) parts.push(`已从旧位置迁移 ${info.migrated.copied} 个文件`)
    if (info.migrated?.failed) parts.push(`${info.migrated.failed} 个文件迁移失败，详见日志`)
    if (info.encryptionAvailable === false) parts.push('Windows 系统加密当前不可用，API Key 和 B站登录无法保存；请重新启动程序或检查系统凭据服务。')
    if (info.secrets && info.secrets.readable === false) parts.push(info.secrets.reason)
    line.textContent = parts.join('；')
    line.classList.toggle('data-location-fallback', info.mode === 'fallback' || info.encryptionAvailable === false || info.secrets?.readable === false)
  } catch (error) {
    line.textContent = `数据目录：读取失败（${error.message}）`
  }
}

function setSettingsStatus(message, error = false) {
  $('settings-status').textContent = message
  $('settings-status').dataset.error = String(error)
}

function applyModelReadiness(settings) {
  modelReady = isModelReady(settings)
  $('model-setup-notice').classList.toggle('hidden', modelReady)
  const badge = $('model-state-badge')
  const total = models.length
  badge.dataset.ready = String(modelReady)
  badge.textContent = modelReady ? `已配置 ${total} 个` : (total ? '待补全' : '尚未配置')
  updateSelectionControls()
  updateDiaryControls()
}

function setModelPickerOpen(open) {
  $('model-picker').classList.toggle('hidden', !open)
  $('check-models').setAttribute('aria-expanded', String(open))
  if (open) $('model-filter').focus()
}

function modelVisionLabel(model) {
  if (model?.vision === true) return '图片'
  if (model?.vision === false) return '文本'
  return ''
}

function describeModelVision(model) {
  if (model?.vision === true) return '供应商列表标注支持图片输入'
  if (model?.vision === false) return '供应商列表标注为纯文本'
  return '供应商未提供能力信息'
}

function renderVisionNote() {
  const mode = $('vision-mode').value
  const modelId = $('model').value.trim()
  const selected = providerModels.find((model) => model.id === modelId)
  let message
  if (mode === 'image') {
    message = '已声明该模型支持图片输入；当前筛选请求仍只发送文字。'
  } else if (mode === 'text') {
    message = '已声明为纯文本模型；应用不会向它发送图片。'
  } else if (!modelId) {
    message = '自动检测：填写或选择模型后，会结合供应商列表给出能力提示。'
  } else if (selected?.vision === true) {
    message = '自动检测：供应商列表标注该模型支持图片输入。'
  } else if (selected?.vision === false) {
    message = '自动检测：供应商列表把该模型标为纯文本。'
  } else {
    message = '自动检测：尚未取得该模型的能力信息，暂按纯文本提示；可点击“检查模型”读取供应商列表。'
  }
  if (mode === 'auto') message += '当前视频筛选只发送文字。'
  $('vision-note').textContent = message
}

function renderModelOptions() {
  const filter = $('model-filter').value.trim().toLowerCase()
  const selectedId = $('model').value.trim()
  const matches = providerModels.filter((model) => !filter || model.id.toLowerCase().includes(filter))
  const options = $('model-options')
  options.replaceChildren()
  const fragment = document.createDocumentFragment()
  for (const model of matches) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'model-option'
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', String(model.id === selectedId))
    button.dataset.vision = model.vision === true ? 'true' : model.vision === false ? 'false' : 'unknown'
    const id = document.createElement('span')
    id.className = 'model-option-id'
    id.textContent = model.id
    button.append(id)
    const vision = modelVisionLabel(model)
    if (vision) {
      const badge = document.createElement('span')
      badge.className = 'model-vision'
      badge.textContent = vision
      button.append(badge)
    }
    button.addEventListener('click', () => {
      $('model').value = model.id
      renderModelOptions()
      renderVisionNote()
      $('model-check-status').dataset.error = 'false'
      $('model-check-status').textContent = `已选择 ${model.id}（${describeModelVision(model)}）；保存模型后生效。`
      setModelPickerOpen(false)
      $('model').focus()
    })
    fragment.append(button)
  }
  options.append(fragment)
  $('model-count').textContent = filter ? `${matches.length} / ${providerModels.length}` : `共 ${providerModels.length} 个`
  $('model-empty').classList.toggle('hidden', matches.length > 0)
}

async function checkProviderModels() {
  if (modelCheckInFlight) return
  modelCheckInFlight = true
  const button = $('check-models')
  button.disabled = true
  button.textContent = '检查中…'
  $('model-check-status').dataset.error = 'false'
  $('model-check-status').textContent = '正在读取供应商模型列表…'
  try {
    const result = await window.whaleagent.listModels({
      id: editingModelId,
      baseUrl: $('base-url').value,
      apiKey: $('api-key').value,
    })
    providerModels = Array.isArray(result?.models) ? result.models : []
    if (!providerModels.length) throw new Error('供应商没有返回可用模型。')
    $('model-filter').value = ''
    renderModelOptions()
    setModelPickerOpen(true)
    $('model-check-status').textContent = `已读取 ${providerModels.length} 个模型，点击列表中的模型即可填入。`
    setEditorStatus(`已读取 ${providerModels.length} 个模型。选择后记得保存模型。`)
  } catch (error) {
    providerModels = []
    setModelPickerOpen(false)
    $('model-check-status').dataset.error = 'true'
    $('model-check-status').textContent = error.message
    setEditorStatus(error.message, true)
  } finally {
    modelCheckInFlight = false
    button.disabled = false
    button.textContent = '检查模型'
  }
}

function normalizeTemperatureField() {
  const raw = $('temperature').value.trim()
  if (raw === '') { $('temperature').value = '0.7'; return }
  const value = Number(raw)
  if (!Number.isFinite(value)) return
  const normalized = Math.min(2, Math.max(0, Math.round(value * 10) / 10))
  if (String(normalized) !== raw) $('temperature').value = String(normalized)
}

function stepTemperature(delta) {
  const current = Number($('temperature').value)
  const base = Number.isFinite(current) ? current : 0.7
  const next = Math.min(2, Math.max(0, Math.round((base + delta) * 10) / 10))
  $('temperature').value = String(next)
}

function stopLoginPolling() {
  if (loginPollTimer) clearInterval(loginPollTimer)
  loginPollTimer = null
  pollInFlight = false
}

for (const button of document.querySelectorAll('.tab')) {
  button.addEventListener('click', () => {
    for (const tab of document.querySelectorAll('.tab')) {
      tab.classList.toggle('active', tab === button)
      tab.setAttribute('aria-current', String(tab === button))
    }
    for (const panel of document.querySelectorAll('.panel')) panel.classList.toggle('hidden', panel.id !== button.dataset.panel)
    if (button.dataset.panel !== 'settings') setModelPickerOpen(false)
    if (button.dataset.panel === 'automation') { void refreshReadingStatus(); void refreshInteractionStatus() }
    if (button.dataset.panel === 'diary') { void refreshDiaryStatus(); void refreshDiaries() }
    if (button.dataset.panel === 'update') void refreshUpdateStatus()
    notify('')
    window.scrollTo({ top: 0, behavior: 'auto' })
  })
}

async function refreshReports() {
  const list = $('report-list')
  list.replaceChildren()
  try {
    const reports = await window.whaleagent.listReports()
    if (!reports.length) {
      const empty = document.createElement('p')
      empty.className = 'muted'
      empty.textContent = '还没有保存的报告。'
      list.append(empty)
      return
    }
    const fragment = document.createDocumentFragment()
    for (const report of reports) {
      const row = document.createElement('div')
      row.className = 'report-item'
      const name = document.createElement('span')
      name.className = 'report-name'
      name.textContent = report.name
      const date = document.createElement('time')
      date.className = 'report-date'
      date.dateTime = report.modifiedAt
      date.textContent = new Date(report.modifiedAt).toLocaleString('zh-CN')
      const actions = document.createElement('div')
      actions.className = 'report-actions'
      const open = document.createElement('button')
      open.type = 'button'
      open.textContent = '打开'
      open.addEventListener('click', async () => {
        try {
          const loaded = await window.whaleagent.readReport(report.name)
          $('report-title').value = loaded.name
          $('report-content').value = loaded.content
          pendingAnalysisBvids = []
          notify(`已打开报告：${loaded.name}。编辑后请另存为新名称。`)
        } catch (error) { notify(error.message, true) }
      })
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = '删除'
      remove.addEventListener('click', async () => {
        if (!window.confirm(`确定永久删除报告“${report.name}”吗？`)) return
        try {
          await window.whaleagent.deleteReport(report.name)
          await refreshReports()
          notify(`已删除报告：${report.name}`)
        } catch (error) { notify(error.message, true) }
      })
      actions.append(open, remove)
      row.append(name, date, actions)
      fragment.append(row)
    }
    list.append(fragment)
  } catch (error) { notify(error.message, true) }
}

async function loadSettings() {
  try {
    const settings = await window.whaleagent.readSettings()
    applyModelState(settings)
    const interaction = settings.interaction || { commentsEnabled: false, dmEnabled: false, intervalMinutes: 0, dailyLimit: 0, scheduleWindows: [] }
    $('comments-enabled').checked = interaction.commentsEnabled
    $('dm-enabled').checked = interaction.dmEnabled
    $('interaction-interval').value = interaction.intervalMinutes
    $('interaction-daily-limit').value = interaction.dailyLimit
    renderInteractionWindows(interaction.scheduleWindows)
    await refreshInteractionStatus()
  } catch (error) { notify(error.message, true) }
}

// 主进程返回的模型档案（不含 Key）+ 首选/备用位置，是界面唯一的数据来源。
function applyModelState(state) {
  models = Array.isArray(state?.models) ? state.models : []
  primaryModelId = String(state?.primaryModelId || '')
  fallbackModelId = String(state?.fallbackModelId || '')
  modelLimit = Number(state?.maxModels) > 0 ? Number(state.maxModels) : 8
  renderModelList()
  if (editingModelId && !models.some((profile) => profile.id === editingModelId)) closeModelEditor()
  applyModelReadiness({ models, primaryModelId, fallbackModelId, modelReady: models.some((profile) => profileIsReady(profile)) })
}

function renderModelList() {
  const list = $('model-list')
  list.replaceChildren()
  const { ordered } = orderedModels(models, primaryModelId, fallbackModelId)
  const fragment = document.createDocumentFragment()
  for (const profile of models) {
    const position = ordered.findIndex((item) => item.id === profile.id)
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'model-item'
    card.dataset.id = profile.id
    card.dataset.ready = String(profileIsReady(profile))
    card.setAttribute('aria-label', `编辑 ${profileLabel(profile)}`)

    const head = document.createElement('span')
    head.className = 'model-item-head'
    const title = document.createElement('span')
    title.className = 'model-item-title'
    title.textContent = profileLabel(profile)
    head.append(title)
    if (position === 0) head.append(modelTag('首选', 'primary'))
    else if (position === 1) head.append(modelTag('备用', 'fallback'))
    head.append(modelTag(profileIsReady(profile) ? '可用' : '待补全', profileIsReady(profile) ? 'ready' : 'pending'))

    const meta = document.createElement('span')
    meta.className = 'model-item-meta'
    const parts = [profile.model || '未填写模型名称', profile.baseUrl || '未填写地址']
    if (profile.visionMode === 'image') parts.push('支持图片')
    else if (profile.visionMode === 'text') parts.push('纯文本')
    meta.textContent = parts.join(' · ')

    card.append(head, meta)

    const actions = document.createElement('span')
    actions.className = 'model-item-actions'
    if (profile.id !== primaryModelId) {
      const makePrimary = document.createElement('span')
      makePrimary.className = 'model-item-action'
      makePrimary.textContent = '设为首选'
      makePrimary.addEventListener('click', (event) => {
        event.stopPropagation()
        void setModelPosition({ primaryModelId: profile.id })
      })
      actions.append(makePrimary)
    }
    if (profile.id !== fallbackModelId) {
      const makeFallback = document.createElement('span')
      makeFallback.className = 'model-item-action'
      makeFallback.textContent = '设为备用'
      makeFallback.addEventListener('click', (event) => {
        event.stopPropagation()
        void setModelPosition({ primaryModelId, fallbackModelId: profile.id })
      })
      actions.append(makeFallback)
    }
    card.append(actions)
    card.addEventListener('click', () => openModelEditor(profile.id))
    fragment.append(card)
  }
  list.append(fragment)
  $('model-list-empty').classList.toggle('hidden', models.length > 0)
  $('model-list').classList.toggle('hidden', models.length === 0)
  $('add-model').disabled = models.length >= modelLimit
  renderChainNote()
}

function modelTag(text, kind) {
  const tag = document.createElement('span')
  tag.className = 'model-tag'
  tag.dataset.kind = kind
  tag.textContent = text
  return tag
}

function renderChainNote() {
  const note = $('model-chain-note')
  const primary = models.find((profile) => profile.id === primaryModelId) || models[0]
  const fallback = models.find((profile) => profile.id === fallbackModelId && profile.id !== primary?.id)
  // 列表为空时上方已有引导文案，这里不再重复。
  note.classList.toggle('hidden', !primary)
  if (!primary) {
    note.textContent = ''
    return
  }
  const parts = [`优先使用：${profileLabel(primary)}`]
  parts.push(fallback ? `失败后改用：${profileLabel(fallback)}` : '失败后不再尝试其他模型（未设置备用模型）')
  if (models.length >= modelLimit) parts.push(`已达上限 ${modelLimit} 个`)
  note.textContent = `${parts.join('；')}。`
}

async function setModelPosition(chain) {
  try {
    const state = await window.whaleagent.saveModelChain(chain)
    applyModelState(state)
    setSettingsStatus('模型调用顺序已保存。')
  } catch (error) { setSettingsStatus(error.message, true) }
}

function closeModelEditor() {
  editingModelId = ''
  setModelPickerOpen(false)
  providerModels = []
  $('model-editor').classList.add('hidden')
  $('api-key').value = ''
  $('model-editor-status').textContent = ''
  $('model-editor-status').dataset.error = 'false'
}

function openModelEditor(id = '') {
  const profile = models.find((item) => item.id === id) || null
  editingModelId = profile?.id || ''
  $('provider-name').value = profile?.providerName || ''
  $('request-format').value = profile?.requestFormat || 'openai'
  $('base-url').value = profile?.baseUrl || ''
  $('model').value = profile?.model || ''
  $('temperature').value = Number.isFinite(Number(profile?.temperature)) ? profile.temperature : 0.7
  $('vision-mode').value = profile?.visionMode || 'auto'
  $('api-key').value = ''
  providerModels = []
  $('model-filter').value = ''
  setModelPickerOpen(false)
  $('model-check-status').dataset.error = 'false'
  $('model-check-status').textContent = profile?.model ? `当前模型：${profile.model}` : '尚未填写模型名称。'
  $('key-state').textContent = profile?.hasApiKey ? '已加密保存' : '尚未设置'
  $('delete-api-key').classList.toggle('hidden', !profile?.hasApiKey)
  $('delete-model').classList.toggle('hidden', !profile)
  $('model-editor-title').textContent = profile ? '编辑模型' : '新增模型'
  $('model-editor-note').textContent = profile
    ? `正在编辑「${profileLabel(profile)}」；API Key 留空表示保留已保存的密钥。`
    : '填写连接信息后保存；API Key 只加密保存在本机。'
  $('model-editor-status').textContent = ''
  $('model-editor-status').dataset.error = 'false'
  $('model-editor').classList.remove('hidden')
  renderVisionNote()
  $('model-editor').scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  $('provider-name').focus()
}

function setEditorStatus(message, error = false) {
  $('model-editor-status').textContent = message
  $('model-editor-status').dataset.error = String(error)
}

async function refreshBiliStatus() {
  try {
    const state = await window.whaleagent.biliStatus()
    biliLoggedIn = Boolean(state.loggedIn)
    biliMid = state.loggedIn ? String(state.mid || '') : ''
    $('bili-account').textContent = state.loggedIn ? `已登录：${state.name}（UID ${state.mid}）` : '尚未登录'
    $('bili-login').classList.toggle('hidden', state.loggedIn)
    $('bili-logout').classList.toggle('hidden', !state.loggedIn)
    if (!state.loggedIn) {
      searchKeyword = ''
      searchPage = 1
      searchHasNext = false
      $('bili-results').replaceChildren()
      $('bili-pagination').classList.add('hidden')
      selectedBvids.clear()
      selectedVideos.clear()
      updateSelectionControls()
    }
    $('bili-login-note').textContent = state.loggedIn ? '凭据已使用 Windows 系统加密保存在本机。' : '扫码凭据仅加密保存在本机。'
    updateSelectionControls()
    void refreshReadingStatus()
  } catch (error) {
    $('bili-account').textContent = '无法验证登录状态'
    notify(error.message, true)
  }
}

async function pollLogin() {
  if (pollInFlight) return
  pollInFlight = true
  try {
    const result = await window.whaleagent.pollBiliLogin()
    if (result.state === 'scanned') $('qr-status').textContent = '已扫码，请在手机上确认登录。'
    if (result.state === 'waiting') $('qr-status').textContent = '请使用 B站 手机客户端扫码。'
    if (result.state === 'expired') {
      stopLoginPolling()
      $('qr-status').textContent = '二维码已过期，请重新生成。'
    }
    if (result.state === 'ok') {
      stopLoginPolling()
      $('qr-wrap').classList.add('hidden')
      notify('B站扫码登录成功。')
      await refreshBiliStatus()
    }
    if (result.state === 'error') {
      stopLoginPolling()
      $('qr-status').textContent = result.message || '登录失败，请重新扫码。'
    }
  } catch (error) {
    $('qr-status').textContent = '网络暂时不可用，正在重试…'
    notify(error.message, true)
  } finally { pollInFlight = false }
}

$('open-model-settings').addEventListener('click', () => {
  document.querySelector('.tab[data-panel="settings"]').click()
})

$('save-interaction').addEventListener('click', async () => {
  try {
    const result = await window.whaleagent.saveSettings({ interaction: collectInteractionSettings() })
    applyModelState(result)
    await refreshInteractionStatus()
    notify('互动设置已保存。')
    setSettingsStatus('互动设置已保存。')
  } catch (error) {
    notify(error.message, true)
    setSettingsStatus(error.message, true)
  }
})

$('add-interaction-window').addEventListener('click', () => {
  if (windowRows('interaction-windows').length >= 12) {
    notify('最多可以设置 12 个互动时间窗。', true)
    return
  }
  addInteractionWindow()
})

$('resume-interaction').addEventListener('click', async () => {
  if (!window.confirm('仅在确认 B站账号状态正常、无验证码或限流后恢复自动互动？')) return
  try {
    await window.whaleagent.resumeInteraction()
    await refreshInteractionStatus()
    notify('已请求恢复互动监听。')
  } catch (error) { notify(error.message, true) }
})

for (const [, id] of PERSONA_INPUTS) {
  $(id).addEventListener('input', () => {
    clearPersonaError()
    renderPersonaNote()
  })
}

$('persona-reset').addEventListener('click', () => {
  fillPersonaInputs(savedPersona)
  clearPersonaError()
  renderPersonaNote()
  notify('已还原为上次保存的人设。')
})

$('content-preferences').addEventListener('input', () => {
  $('content-preferences-error').classList.add('hidden')
  renderPreferencesNote()
})

$('content-preferences-save').addEventListener('click', async () => {
  $('content-preferences-save').disabled = true
  $('content-preferences-error').classList.add('hidden')
  notify('正在保存内容偏好…')
  try {
    const state = await window.whaleagent.saveContentPreferences($('content-preferences').value)
    applyPreferencesState(state)
    void refreshReadingStatus()
    notify(String(state.preferences || '').trim()
      ? '内容偏好已保存；之后的筛选会带上这段偏好。'
      : '内容偏好已清空；之后的筛选只按视频内容判断。')
  } catch (error) {
    $('content-preferences-error').textContent = error.message
    $('content-preferences-error').classList.remove('hidden')
    notify(error.message, true)
    renderPreferencesNote()
  }
})

$('persona-save').addEventListener('click', async () => {
  const values = collectPersona()
  const invalid = validatePersonaInputs(values)
  if (invalid) {
    showPersonaError(invalid.message, invalid.id)
    return
  }
  $('persona-save').disabled = true
  clearPersonaError()
  notify('正在保存我的人设…')
  try {
    const state = await window.whaleagent.savePersona(values)
    applyPromptState(state)
    notify(personaIsEmpty(state.persona) ? '我的人设已清空；模型将使用中性语气。' : '我的人设已保存，将用于之后的分析和自动回复。')
  } catch (error) {
    showPersonaError(error.message)
    notify(error.message, true)
    renderPersonaNote()
  }
})

$('bili-login').addEventListener('click', async () => {
  try {
    stopLoginPolling()
    notify('正在生成 B站登录二维码…')
    const result = await window.whaleagent.startBiliLogin()
    $('qr-image').src = result.image
    $('qr-status').textContent = '请使用 B站 手机客户端扫码。二维码约 3 分钟有效。'
    $('qr-wrap').classList.remove('hidden')
    notify('二维码已生成；登录 URL 和轮询密钥不会写入日志。')
    loginPollTimer = setInterval(pollLogin, 2000)
    pollLogin()
  } catch (error) { notify(error.message, true) }
})

$('qr-close').addEventListener('click', () => {
  stopLoginPolling()
  $('qr-wrap').classList.add('hidden')
  notify('已取消扫码登录。')
})

$('bili-logout').addEventListener('click', async () => {
  if (!window.confirm('退出 B站登录并删除本机保存的加密凭据？')) return
  try {
    await window.whaleagent.logoutBili()
    $('bili-results').replaceChildren()
    selectedBvids.clear()
    selectedVideos.clear()
    updateSelectionControls()
    notify('本机 B站凭据已删除。')
    await refreshBiliStatus()
  } catch (error) { notify(error.message, true) }
})

function renderVideoResults(items) {
  const fragment = document.createDocumentFragment()
  for (const item of items) {
    const row = document.createElement('article')
    row.className = 'result-row'
    const selectLabel = document.createElement('label')
    selectLabel.className = 'video-select'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.addEventListener('change', () => {
      if (checkbox.checked && selectedBvids.size >= 3) {
        checkbox.checked = false
        notify('每次最多选择 3 条视频。', true)
        return
      }
      if (checkbox.checked) {
        selectedBvids.add(item.bvid)
        selectedVideos.set(item.bvid, { source: item.source || '', followed: item.followed === true })
      } else {
        selectedBvids.delete(item.bvid)
        selectedVideos.delete(item.bvid)
      }
      updateSelectionControls()
    })
    const selectText = document.createElement('span')
    selectText.textContent = '选作分析'
    selectLabel.append(checkbox, selectText)
    const title = document.createElement('h3')
    title.textContent = item.title
    if (item.seenBefore) {
      const badge = document.createElement('span')
      badge.className = 'seen-badge'
      badge.textContent = '已分析'
      badge.title = item.lastAnalyzedAt ? `上次分析：${new Date(item.lastAnalyzedAt).toLocaleString('zh-CN')}` : '本机历史记录显示已分析'
      title.append(' ', badge)
    }
    const meta = document.createElement('p')
    meta.className = 'result-meta'
    meta.textContent = `${item.source || '关键词'} · ${item.author} · ${item.duration} · 播放 ${item.play}`
    const description = document.createElement('p')
    description.textContent = item.description
    const open = document.createElement('button')
    open.type = 'button'
    open.textContent = '打开视频'
    open.addEventListener('click', () => window.whaleagent.openBiliVideo(item.bvid).catch((error) => notify(error.message, true)))
    row.append(selectLabel, title, meta, description, open)
    fragment.append(row)
  }
  $('bili-results').replaceChildren(fragment)
}

async function searchBiliPage(page) {
  const hasNonKeywordSource = searchSources.some((source) => source !== 'keyword')
  if ((!searchKeyword && !hasNonKeywordSource) || (page > 1 && !searchKeyword) || page < 1 || page > 50) return
  const skipNote = searchSkipNote
  searchSkipNote = ''
  $('bili-search').disabled = true
  $('search-prev').disabled = true
  $('search-next').disabled = true
  $('bili-results').replaceChildren()
  $('bili-pagination').classList.add('hidden')
  selectedBvids.clear()
  selectedVideos.clear()
  updateSelectionControls()
  notify(`正在读取 B站搜索结果（第 ${page} 页）…`)
  try {
    const result = await window.whaleagent.searchBiliVideos(searchKeyword, page, searchSources)
    searchPage = result.page
    searchHasNext = result.hasNext
    renderVideoResults(result.items)
    $('search-page-label').textContent = result.totalPages ? `第 ${result.page} / ${result.totalPages} 页` : `第 ${result.page} 页`
    $('search-prev').disabled = result.page <= 1
    $('search-next').disabled = !result.hasNext || result.page >= 50
    $('bili-pagination').classList.toggle('hidden', result.items.length === 0 || !searchSources.includes('keyword'))
    const warningNames = { keyword: '关键词搜索', following: '关注动态', homepage: '首页推荐' }
    const unavailable = Array.isArray(result.sourceWarnings) ? result.sourceWarnings.map((source) => warningNames[source] || source) : []
    const prefix = skipNote ? `${skipNote} ` : ''
    notify(unavailable.length ? `${prefix}第 ${result.page} 页读取到 ${result.items.length} 条结果；暂不可用：${unavailable.join('、')}。` : `${prefix}第 ${result.page} 页读取到 ${result.items.length} 条结果。`)
  } catch (error) {
    $('bili-results').replaceChildren()
    $('bili-pagination').classList.add('hidden')
    notify(error.message, true)
  } finally { updateSelectionControls() }
}

$('bili-search').addEventListener('click', async () => {
  const request = resolveSearchRequest({
    keywordChecked: $('source-keyword').checked,
    keyword: $('bili-keyword').value,
    followingChecked: $('source-following').checked,
    homepageChecked: $('source-homepage').checked,
  })
  if (request.error) { notify(request.error, true); return }
  searchKeyword = request.keyword
  searchSources = request.sources
  searchSkipNote = request.note
  searchPage = 1
  await searchBiliPage(searchPage)
})

$('search-prev').addEventListener('click', () => { if (searchPage > 1) searchBiliPage(searchPage - 1) })
$('search-next').addEventListener('click', () => { if (searchHasNext && searchPage < 50) searchBiliPage(searchPage + 1) })

$('bili-analyze').addEventListener('click', async () => {
  if (!canAnalyze({ modelReady, biliLoggedIn, selectedCount: selectedBvids.size })) return
  $('bili-analyze').disabled = true
  notify('正在读取所选视频资料和字幕，并请求模型分析…')
  try {
    const result = await window.whaleagent.analyzeBiliVideos({
      videos: [...selectedBvids].map((bvid) => ({
        bvid,
        source: selectedVideos.get(bvid)?.source || '',
        followed: selectedVideos.get(bvid)?.followed === true,
      })),
    })
    $('report-content').value = result.report
    pendingAnalysisBvids = Array.isArray(result.recommendedBvids)
      ? result.recommendedBvids
      : Array.isArray(result.analyzedBvids) ? result.analyzedBvids : []
    $('report-title').value = `Whaleagent-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
    for (const tab of document.querySelectorAll('.tab')) {
      if (tab.dataset.panel === 'report') tab.click()
    }
    const skipped = Array.isArray(result.skipped) ? result.skipped.length : 0
    notify(`已生成 ${result.count} 条分析草稿${skipped ? `，另有 ${skipped} 条被筛选规则跳过` : ''}；请检查内容后手动保存报告。`)
  } catch (error) { notify(error.message, true) }
  finally { updateSelectionControls() }
})

$('save-model').addEventListener('click', async () => {
  try {
    normalizeTemperatureField()
    $('save-model').disabled = true
    const state = await window.whaleagent.saveModelProfile({
      id: editingModelId,
      providerName: $('provider-name').value,
      baseUrl: $('base-url').value,
      requestFormat: $('request-format').value,
      model: $('model').value,
      temperature: $('temperature').value,
      visionMode: $('vision-mode').value,
      apiKey: $('api-key').value,
    })
    $('api-key').value = ''
    applyModelState(state)
    closeModelEditor()
    await refreshInteractionStatus()
    notify('模型已保存。')
    setSettingsStatus('模型已保存在本机。')
  } catch (error) {
    notify(error.message, true)
    setEditorStatus(error.message, true)
  } finally { $('save-model').disabled = false }
})

$('add-model').addEventListener('click', () => openModelEditor(''))

$('close-model-editor').addEventListener('click', () => {
  closeModelEditor()
  setSettingsStatus('')
})

$('delete-model').addEventListener('click', async () => {
  const profile = models.find((item) => item.id === editingModelId)
  if (!profile) return
  if (!window.confirm(`删除模型「${profileLabel(profile)}」及其本机保存的 API Key？此操作不影响其他模型和 B站登录。`)) return
  try {
    const state = await window.whaleagent.deleteModelProfile(profile.id)
    applyModelState(state)
    closeModelEditor()
    await refreshInteractionStatus()
    notify('模型已删除。')
    setSettingsStatus('模型已删除。')
  } catch (error) { setEditorStatus(error.message, true) }
})

$('delete-api-key').addEventListener('click', async () => {
  const profile = models.find((item) => item.id === editingModelId)
  if (!profile) {
    setEditorStatus('请先保存这个模型，再清除它的 API Key。', true)
    return
  }
  if (!window.confirm('删除这个模型在本机保存的 API Key？地址、模型名称和温度会保留。')) return
  try {
    const state = await window.whaleagent.deleteModelApiKey(profile.id)
    applyModelState(state)
    $('key-state').textContent = '尚未设置'
    $('delete-api-key').classList.add('hidden')
    notify('本机 API Key 已删除。')
    setEditorStatus('本机 API Key 已删除。')
  } catch (error) { setEditorStatus(error.message, true) }
})

$('test-model').addEventListener('click', async () => {
  try {
    notify('正在测试连接…')
    setEditorStatus('正在测试当前填写的地址与 API Key…')
    const result = await window.whaleagent.testModel({
      id: editingModelId,
      providerName: $('provider-name').value,
      baseUrl: $('base-url').value,
      model: $('model').value,
      apiKey: $('api-key').value,
    })
    notify(result.message)
    setEditorStatus(result.message)
  } catch (error) {
    notify(error.message, true)
    setEditorStatus(error.message, true)
  }
})

$('check-models').addEventListener('click', () => { void checkProviderModels() })

$('model-filter').addEventListener('input', renderModelOptions)

$('model').addEventListener('input', () => {
  renderModelOptions()
  renderVisionNote()
})

$('base-url').addEventListener('input', () => {
  if (!providerModels.length) return
  providerModels = []
  setModelPickerOpen(false)
  $('model-check-status').dataset.error = 'false'
  $('model-check-status').textContent = 'API 地址已修改，请重新检查模型列表。'
  renderVisionNote()
})

$('vision-mode').addEventListener('change', renderVisionNote)

$('temperature').addEventListener('change', normalizeTemperatureField)
$('temperature-up').addEventListener('click', () => stepTemperature(0.1))
$('temperature-down').addEventListener('click', () => stepTemperature(-0.1))

$('model-picker').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    setModelPickerOpen(false)
    $('model').focus()
    return
  }
  if (event.key === 'Enter' && event.target === $('model-filter')) {
    const first = $('model-options').querySelector('.model-option')
    if (first) {
      event.preventDefault()
      first.click()
    }
  }
})

document.addEventListener('click', (event) => {
  if ($('model-picker').classList.contains('hidden')) return
  if ($('model-picker').contains(event.target) || $('check-models').contains(event.target)) return
  setModelPickerOpen(false)
})

$('save-report').addEventListener('click', async () => {
  try {
    const result = await window.whaleagent.saveReport({
      title: $('report-title').value,
      content: $('report-content').value,
      relatedVideoIds: pendingAnalysisBvids,
    })
    if (result.historySaved !== false) pendingAnalysisBvids = []
    const dmNote = result.dm?.sent ? ' 已私信主人。' : ''
    notify(result.historySaved === false ? `报告已保存，但本地已分析记录未能更新：${result.name}。修改名称另存可重试。${dmNote}` : `报告已保存：${result.name}。${dmNote}`)
    if (result.dm?.sent) void refreshReadingStatus()
    await refreshReports()
  } catch (error) { notify(error.message, true) }
})

$('open-folder').addEventListener('click', async () => {
  try { await window.whaleagent.openReportFolder(); notify('已打开报告文件夹。') }
  catch (error) { notify(error.message, true) }
})

$('open-data-folder').addEventListener('click', async () => {
  try { await window.whaleagent.openDataFolder(); notify('已打开数据目录。') }
  catch (error) { notify(error.message, true) }
})

$('refresh-reports').addEventListener('click', refreshReports)

// ---- 软件更新 ----
// 界面只负责展示：检查、下载、校验、替换文件全在主进程，这里轮询状态。
let updateState = null
let updatePollTimer = null

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}

function formatSpeed(bytesPerSecond) {
  const value = Number(bytesPerSecond) || 0
  if (value <= 0) return '0 KB/s'
  return `${formatBytes(value)}/s`
}

function formatRemaining(status) {
  const speed = Number(status.speed) || 0
  const { received, total } = status.progress || {}
  if (!speed || !total || total <= received) return ''
  const seconds = Math.round((total - received) / speed)
  if (seconds < 60) return `约 ${seconds} 秒`
  if (seconds < 3600) return `约 ${Math.round(seconds / 60)} 分钟`
  return `约 ${(seconds / 3600).toFixed(1)} 小时`
}

function describeUpdateState(status) {
  const latest = status.latest
  switch (status.phase) {
    case 'unsupported':
      return { text: status.error || '当前运行方式不支持自动更新。', tone: 'is-error', badge: '不支持' }
    case 'checking':
      return { text: '正在检查更新…', tone: 'is-busy', badge: '检查中' }
    case 'downloading': {
      const { received, total } = status.progress
      const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0
      // 慢链路下“数字不动”不等于卡死：把速度和预计剩余时间一起显示，
      // 真的 15 秒没有新字节时明确说“已停滞”。
      const remaining = formatRemaining(status)
      const speedText = status.stalled ? '已停滞，正在重试' : formatSpeed(status.speed)
      return {
        text: `正在下载 ${latest?.version || ''}：${formatBytes(received)}${total > 0 ? ` / ${formatBytes(total)}` : ''}（${percent}%）· ${speedText}${remaining ? ` · 剩余 ${remaining}` : ''}`,
        tone: status.stalled ? 'is-error' : 'is-busy',
        badge: status.stalled ? '停滞' : '下载中',
      }
    }
    case 'ready':
      return { text: `已下载并校验 ${status.ready?.version || ''}；点「立即重启安装」才会替换程序文件。`, tone: 'is-ok', badge: '待重启' }
    case 'applying':
      return { text: '正在退出并安装，随后会自动启动新版本。', tone: 'is-busy', badge: '安装中' }
    case 'available':
      return { text: `发现新版本 ${latest?.version || ''}，点「下载并校验」开始下载。`, tone: 'is-ok', badge: '有新版本' }
    case 'error':
      return { text: status.error || '更新失败。', tone: 'is-error', badge: '出错' }
    case 'idle':
    default:
      if (status.checkedAt) return { text: status.error || '当前已是最新版本。', tone: 'is-ok', badge: '已是最新' }
      return { text: '尚未检查更新。', tone: 'is-busy', badge: '尚未检查' }
  }
}

function selectedTargetRelease(status) {
  const version = $('update-target').value
  if (!version) return null
  return (status.releases || []).find((release) => release.version === version) || null
}

function renderUpdateNotes(status) {
  const list = $('update-notes')
  list.replaceChildren()
  const target = selectedTargetRelease(status)
  const notes = (target?.notes?.length ? target.notes : status.latest?.notes) || []
  const version = target?.version || status.latest?.version || ''
  $('update-notes-version').textContent = version || '—'
  if (!notes.length) {
    const empty = document.createElement('li')
    empty.className = 'muted'
    empty.textContent = status.checkedAt ? '这个版本没有写更新说明。' : '检查更新后显示。'
    list.append(empty)
    return
  }
  for (const note of notes) {
    const item = document.createElement('li')
    item.textContent = note
    list.append(item)
  }
}

function renderUpdateTargets(status) {
  const select = $('update-target')
  const previous = select.value
  select.replaceChildren()
  const releases = status.releases || []
  if (!releases.length) {
    const option = document.createElement('option')
    option.value = ''
    option.textContent = status.checkedAt ? '没有可选版本' : '尚未检查'
    select.append(option)
    select.disabled = true
    return
  }
  for (const release of releases) {
    const option = document.createElement('option')
    option.value = release.version
    const tags = []
    if (release.newer) tags.push('新版本')
    if (release.current) tags.push('当前')
    if (!release.installable) tags.push('无安装包')
    option.textContent = `${release.version}${tags.length ? `（${tags.join('、')}）` : ''}`
    option.disabled = !release.installable
    select.append(option)
  }
  const fallback = releases.find((release) => release.newer && release.installable)?.version
    || releases.find((release) => release.installable)?.version
    || ''
  const keep = releases.some((release) => release.version === previous && release.installable) ? previous : fallback
  select.value = keep
  select.disabled = ['checking', 'downloading', 'applying'].includes(status.phase)
}

function renderUpdateProgress(status) {
  const card = $('update-progress-card')
  const busy = status.phase === 'downloading'
  const ready = status.phase === 'ready'
  const { received, total } = status.progress
  const percent = ready ? 100 : total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0
  card.classList.toggle('hidden', !busy && !ready)
  $('update-progress-fill').style.width = `${percent}%`
  $('update-progress-percent').textContent = `${percent}%`
  const bar = card.querySelector('.update-progress')
  bar.setAttribute('aria-valuenow', String(percent))
  $('update-progress-text').textContent = ready
    ? `${formatBytes(status.ready?.size || 0)}，已通过 SHA-256 校验。`
    : busy
      ? `${formatBytes(received)}${total > 0 ? ` / ${formatBytes(total)}` : ''} · ${status.stalled ? '已停滞，正在重试' : formatSpeed(status.speed)}${formatRemaining(status) ? ` · 剩余 ${formatRemaining(status)}` : ''}`
      : '等待开始。'
}

function renderUpdateStatus(status) {
  if (!status) return
  updateState = status
  const view = describeUpdateState(status)
  const badge = $('update-state-badge')
  badge.textContent = view.badge
  badge.classList.toggle('is-busy', view.tone === 'is-busy')
  badge.classList.toggle('is-ready', view.tone === 'is-ok')

  const line = $('update-status-line')
  line.textContent = view.text
  line.classList.toggle('is-error', view.tone === 'is-error')
  line.classList.toggle('is-ok', view.tone === 'is-ok')
  line.classList.toggle('is-busy', view.tone === 'is-busy')

  $('update-current-version').textContent = status.currentVersion || '—'
  $('update-current-note').textContent = status.supported
    ? '便携版：程序目录与 WhaleagentData 一起移动。'
    : (status.error || '当前运行方式不支持自动更新。')

  const latest = status.latest
  $('update-latest-version').textContent = latest ? latest.version : (status.checkedAt ? '无' : '尚未检查')
  $('update-latest-note').textContent = latest
    ? [
      status.updateAvailable ? '可更新。' : (status.phase === 'ready' ? '已下载，等待安装。' : '当前已是最新版本。'),
      latest.size ? `程序包 ${formatBytes(latest.size)}。` : '',
      latest.publishedAt ? `发布于 ${new Date(latest.publishedAt).toLocaleString('zh-CN')}。` : '',
    ].filter(Boolean).join('')
    : (status.checkedAt ? '没有可用的更新清单。' : '点「检查更新」后才会查询。')

  $('update-folder').textContent = status.updateDir || '—'
  $('update-logfile').textContent = status.logPath || '安装时写入 apply.log。'

  renderUpdateTargets(status)
  renderUpdateProgress(status)
  renderUpdateNotes(status)

  const busy = ['checking', 'downloading', 'applying'].includes(status.phase)
  $('update-check').disabled = !status.supported || busy
  $('update-check').textContent = status.phase === 'checking' ? '正在检查…' : '检查更新'
  $('update-download').disabled = !status.supported || busy || status.phase === 'ready' || !latest
  $('update-download').textContent = status.phase === 'downloading' ? '正在下载…' : '下载并校验'
  $('update-apply').disabled = status.phase !== 'ready'
  $('update-cancel').classList.toggle('hidden', status.phase !== 'downloading')
  $('update-discard').classList.toggle('hidden', !status.ready)
}

function stopUpdatePolling() {
  if (updatePollTimer) clearInterval(updatePollTimer)
  updatePollTimer = null
}

function startUpdatePolling() {
  stopUpdatePolling()
  updatePollTimer = setInterval(async () => {
    try {
      const status = await window.whaleagent.updateStatus()
      renderUpdateStatus(status)
      if (status.phase !== 'downloading') stopUpdatePolling()
    } catch { stopUpdatePolling() }
  }, 500)
}

async function refreshUpdateStatus() {
  try { renderUpdateStatus(await window.whaleagent.updateStatus()) }
  catch (error) { notify(error.message, true) }
}

$('update-check').addEventListener('click', async () => {
  $('update-check').disabled = true
  $('update-check').textContent = '正在检查…'
  $('update-status-line').textContent = '正在检查更新…'
  try {
    const status = await window.whaleagent.checkUpdate()
    renderUpdateStatus(status)
    if (status.phase === 'error') notify(status.error, true)
    else if (status.phase === 'idle') notify('当前已是最新版本。')
    else notify(`发现新版本 ${status.latest?.version}：${formatBytes(status.latest?.size || 0)}。`)
  } catch (error) {
    notify(error.message, true)
    await refreshUpdateStatus()
  }
})

$('update-download').addEventListener('click', async () => {
  const version = $('update-target').value || ''
  $('update-download').disabled = true
  $('update-download').textContent = '正在下载…'
  $('update-progress-card').classList.remove('hidden')
  startUpdatePolling()
  try {
    const status = await window.whaleagent.downloadUpdate(version)
    renderUpdateStatus(status)
    if (status.phase === 'ready') notify(`更新 ${status.ready?.version} 已下载并通过校验，可以重启安装。`)
    else if (status.phase !== 'idle') notify(status.error || '下载未完成。', true)
    else notify(status.error || '已取消下载。')
  } catch (error) {
    notify(error.message, true)
  } finally {
    stopUpdatePolling()
    await refreshUpdateStatus()
  }
})

$('update-cancel').addEventListener('click', async () => {
  try {
    renderUpdateStatus(await window.whaleagent.cancelUpdateDownload())
    notify('已请求取消下载。')
  } catch (error) { notify(error.message, true) }
})

$('update-discard').addEventListener('click', async () => {
  try {
    renderUpdateStatus(await window.whaleagent.discardUpdatePackage())
    notify('已删除下载的更新包。')
  } catch (error) { notify(error.message, true) }
})

$('update-apply').addEventListener('click', async () => {
  $('update-apply').disabled = true
  try {
    const status = await window.whaleagent.applyUpdate()
    renderUpdateStatus(status)
    if (status.phase === 'applying') notify('正在退出并安装，完成后会自动启动新版本。')
    else notify(status.error || '安装未开始。', true)
  } catch (error) {
    notify(error.message, true)
  } finally {
    if (updateState?.phase !== 'applying') $('update-apply').disabled = updateState?.phase !== 'ready'
  }
})

$('update-open-folder').addEventListener('click', async () => {
  try { await window.whaleagent.openUpdateFolder() }
  catch (error) { notify(error.message, true) }
})

$('update-open-releases').addEventListener('click', async () => {
  try { await window.whaleagent.openUpdateReleases() }
  catch (error) { notify(error.message, true) }
})

$('update-target').addEventListener('change', () => { if (updateState) renderUpdateNotes(updateState) })

loadSettings()
loadPrompts()
refreshDataInfo()
refreshBiliStatus()
refreshReports()
refreshInteractionStatus()
refreshReadingStatus()
refreshDiaryStatus()
refreshDiaries()
refreshUpdateStatus()
setInterval(refreshInteractionStatus, 10_000)
setInterval(refreshReadingStatus, 30_000)
setInterval(refreshDiaryStatus, 30_000)
window.addEventListener('focus', () => { void refreshReadingStatus() })
