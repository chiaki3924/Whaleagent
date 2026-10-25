import { app, BrowserWindow, ipcMain, nativeImage, net, safeStorage, session, shell } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateReport, validateReportName, normalizeReportMetadata, normalizePreferences, PREFERENCE_MAX_CHARS, normalizeInteractionConfig } from './validation.js'
import { beginQrLogin, pollQrLogin, getAccountStatus, searchVideos, discoverVideos, fetchVideoForAnalysis, bilibiliCookieHeader, likeVideo, favoriteVideo } from './bilibili.js'
import { analyzeVideosWithModel, generateInteractionReplyDetailed, generateDiariesWithModel, generateReportDmLine } from './model.js'
import { fetchCommentTriggers, fetchDmTriggers, sendCommentReply, sendPrivateMessage, sendPrivateImageToTalker, sendPrivateMessageTo, uploadImageToBilibili } from './interaction-bilibili.js'
import QRCode from 'qrcode'
import { appendDiagnostic, errorSummary } from './diagnostics.js'
import { readUtf8FileLimited, deleteRegularFileInDirectory } from './local-files.js'
import { pruneHistoryFile, readHistory, decorateWithHistory, recordAnalyzed } from './history.js'
import { interactionEnabled, isWithinInteractionSchedule, normalizeInteractionSettings, readInteractionState, writeInteractionState } from './interaction-state.js'
import { readingWindowState } from './reading-window.js'
import { normalizeReadingConfig, normalizeReadingLastRead, normalizeReadingState, readReadingState, writeReadingState, shouldAutoRun, autoEnabled, nextAutoRunAt, executeReadingAuto } from './reading-auto.js'
import { runInteractionCycle } from './interaction-worker.js'
import { interactionSettingsReady } from './interaction-settings.js'
import { describeScreening, historyRetentionDays, normalizeScreenConfig, publishedTooOld, readScreenConfig, readVideoAgeDays, titleExcluded } from './screening.js'
import { describeInteractionContext } from './interaction-context.js'
import { createIdentityDirectory } from './interaction-identity.js'
import { countImages, loadImageParts, summarizeImageParts } from './interaction-images.js'
import { imageNoteFor, rememberImageNote } from './interaction-image-notes.js'
import { describeImageLibrary, listLibraryImages, readLibraryImage } from './image-library.js'
import { DEFAULT_TEMPERATURE, resolveVisionEnabled } from './model-settings.js'
import { MAX_MODELS, normalizeModelProfile, normalizeChainSelection, profileIsReady, readModelProfile, readModelProfiles, resolveModelChain } from './model-profiles.js'
import { runModelChain } from './model-chain.js'
import { keyForProfile, normalizeKeyStore, pruneKeyStore, withProfileKey, withoutProfileKey } from './model-keys.js'
import { fetchProviderModels } from './model-list.js'
import { TEST_TIMEOUT_MS, resolveListTarget, resolveTestTarget, testConnectionMessage } from './model-test-target.js'
import { REPORT_DM_DAILY_LIMIT, executeReportDm, localDay, normalizeReportDmConfig, normalizeReportDmState, readReportDmState, writeReportDmState } from './report-dm.js'
import { buildPushLogFromReports, buildPushedVideoPayload, describePushLog, isAutoReportName, readPushLog, recordPush, recordPushAction } from './push-log.js'
import { describeActionOutcome, executeRequestedActions } from './interaction-actions.js'
import { PERSONA_MAX_CHARS, listSystemPrompts, normalizePersona, personaIsEmpty, readSavedPersona } from './prompts.js'
import { DATA_DIR_NAME, ensureDataLayout, markProfileReset, migrateLegacyData, profileResetBlocked, resolveDataLayout, seedRuntimeProfile } from './app-paths.js'
import { RELEASES_PAGE_URL, createUpdater } from './updater.js'
import {
  DIARY_FILE_NAMES,
  DIARY_KINDS,
  DIARY_KIND_LABELS,
  diaryDue,
  executeDiaryGeneration,
  formatDiaryFile,
  isValidDayKey,
  localDayKey,
  nextDiaryRunAt,
  normalizeDiaryConfig,
  parseDiarySections,
  pruneDiaryText,
  readDiaryState,
  writeDiaryState,
} from './diary.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.resolve(HERE, '..', '..')
// 便携版：程序所在目录。打包后是 Whaleagent.exe 旁边，开发时是项目根目录。
const PROGRAM_DIR = app.isPackaged ? path.dirname(app.getPath('exe')) : APP_DIR
// 先记下系统默认位置：旧数据迁移还要从这里读，之后 userData 可能被便携目录接管。
const DEFAULT_USER_DATA_DIR = app.getPath('userData')
const DEFAULT_DOCUMENTS_DIR = app.getPath('documents')
const DATA_LAYOUT = resolveDataLayout({
  programDir: PROGRAM_DIR,
  defaultUserData: DEFAULT_USER_DATA_DIR,
  env: process.env,
})
ensureDataLayout(DATA_LAYOUT)
// 便携模式把 Chromium 缓存也收进 WhaleagentData\runtime，避免继续往 %APPDATA% 写文件。
// 但必须先播下旧的 Local State：Electron 的 safeStorage 密钥就存在这个文件里，
// 少了它，从旧版本迁移过来的 API Key 和 B站登录态会解不开。
if (DATA_LAYOUT.mode === 'portable' || DATA_LAYOUT.mode === 'custom') {
  seedRuntimeProfile({
    runtimeDir: DATA_LAYOUT.runtimeDir,
    legacyUserDataDir: DEFAULT_USER_DATA_DIR,
    blocked: profileResetBlocked(DATA_LAYOUT),
  })
  app.setPath('userData', DATA_LAYOUT.runtimeDir)
}

// 单实例：两个实例同时更新会互相踩程序目录里的文件，而且它们共用同一个 WhaleagentData。
// 后启动的实例直接退出，把已有窗口唤到前面（更新脚本重启新版本时也依赖这条）。
const HAS_SINGLE_INSTANCE = app.requestSingleInstanceLock()
if (!HAS_SINGLE_INSTANCE) app.quit()
else app.on('second-instance', () => {
  const [window] = BrowserWindow.getAllWindows()
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.focus()
})

// 软件更新：包放在数据目录下的 update，替换程序文件交给独立的 PowerShell 脚本，
// 本进程要退出之后文件才会解锁。检查与下载走 Electron 的 net.fetch，继承系统代理设置。
const UPDATER = createUpdater({
  programDir: PROGRAM_DIR,
  dataDir: DATA_LAYOUT.rootDir,
  currentVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  fetchImpl: (url, init) => net.fetch(url, init),
  // 下载走 Node 的 tls 并行分片（Chromium 的 HTTP/2 多路复用会把并发压成一条），
  // 所以代理要单独解析一次交给它。系统代理没配时 resolveProxy 返回 DIRECT。
  proxyResolver: (url) => session.defaultSession.resolveProxy(url),
  logger: (level, event, detail) => logDiagnostic(level, event, detail),
})

const REPORT_DIR = () => DATA_LAYOUT.reportsDir
const CONFIG_PATH = () => path.join(DATA_LAYOUT.configDir, 'settings.json')
const KEY_PATH = () => path.join(DATA_LAYOUT.secretsDir, 'model-key.bin')
const MODEL_KEYS_PATH = () => path.join(DATA_LAYOUT.secretsDir, 'model-keys.bin')
const BILI_CREDENTIAL_PATH = () => path.join(DATA_LAYOUT.secretsDir, 'bilibili-session.bin')
const LOG_PATH = () => path.join(DATA_LAYOUT.logsDir, 'whaleagent.log')
const HISTORY_PATH = () => path.join(DATA_LAYOUT.historyDir, 'analyzed-videos.json')
// 推送台账：记「推过哪几条视频」，私信被挤出窗口后 agent 仍认得出自己推过什么。
const PUSH_LOG_PATH = () => path.join(DATA_LAYOUT.historyDir, 'pushed-videos.json')
const INTERACTION_STATE_PATH = () => path.join(DATA_LAYOUT.configDir, 'interaction-state.json')
const READING_STATE_PATH = () => path.join(DATA_LAYOUT.configDir, 'reading-state.json')
const REPORT_DM_STATE_PATH = () => path.join(DATA_LAYOUT.configDir, 'report-dm-state.json')
const DIARY_DIR = () => DATA_LAYOUT.diariesDir
const DIARY_STATE_PATH = () => path.join(DATA_LAYOUT.configDir, 'diary-state.json')
const RENDERER_PATH = path.join(APP_DIR, 'src', 'renderer', 'index.html')
let dataMigration = null
let activeQrKey = null
let activeQrTimer = null
let interactionTimer = null
let interactionGeneration = 0
let interactionInFlight = false
// 私信对方的昵称要按 mid 额外查（会话对象里没有），目录进程内缓存，减少重复请求。
const identityDirectory = createIdentityDirectory()
let interactionStatus = { enabled: false, paused: false, sentToday: 0, message: '互动监听未配置。' }
let readingAutoTimer = null
let readingAutoInFlight = false
let readingConfigUpdatedAt = 0
let diaryAutoTimer = null
let diaryInFlight = false
let diaryRetryAfter = 0
let biliCredentialUnreadableLogged = false
let keyStoreUnreadableLogged = false

function logDiagnostic(level, event, detail = '') {
  void appendDiagnostic(LOG_PATH(), level, event, detail).catch(() => {})
}

// 界面上展示“数据到底存在哪里”，便携模式与退化模式要能一眼区分。
// 顺带探测一次已保存的密钥能不能解开：把整个数据目录复制到另一台电脑或另一个
// Windows 用户后，DPAPI 保护的密钥会失效，需要提示重新填写。
async function secretState() {
  if (!safeStorage.isEncryptionAvailable()) return { readable: true, reason: '' }
  // API Key 与 B站登录态都可能是旧机器留下的；任意一个解不开都提示重新填写/登录。
  for (const file of [MODEL_KEYS_PATH(), BILI_CREDENTIAL_PATH()]) {
    let encrypted = null
    try { encrypted = await fs.readFile(file) } catch { continue }
    try {
      safeStorage.decryptString(encrypted)
    } catch {
      return {
        readable: false,
        reason: '已保存的 API Key 和 B站登录态无法解密，通常是数据文件夹被复制到了另一台电脑或另一个 Windows 用户。请在【模型设置】重新填写 API Key，并重新扫码登录 B站。',
      }
    }
  }
  return { readable: true, reason: '' }
}

async function dataInfo() {
  const secrets = await secretState()
  return {
    mode: DATA_LAYOUT.mode,
    portable: DATA_LAYOUT.mode === 'portable' || DATA_LAYOUT.mode === 'custom',
    rootDir: DATA_LAYOUT.rootDir,
    programDir: PROGRAM_DIR,
    portableDir: path.join(PROGRAM_DIR, DATA_DIR_NAME),
    reason: DATA_LAYOUT.reason,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    secrets,
    subdirs: {
      config: DATA_LAYOUT.configDir,
      secrets: DATA_LAYOUT.secretsDir,
      history: DATA_LAYOUT.historyDir,
      reports: DATA_LAYOUT.reportsDir,
      diaries: DATA_LAYOUT.diariesDir,
      logs: DATA_LAYOUT.logsDir,
      images: DATA_LAYOUT.imagesDir,
      runtime: DATA_LAYOUT.runtimeDir,
    },
    migrated: dataMigration
      ? { skipped: dataMigration.skipped, copied: dataMigration.copied, failed: dataMigration.failed }
      : null,
  }
}

function requireSystemEncryption() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 系统加密不可用，已拒绝保存或读取凭据。')
}

async function readBiliCredential() {
  requireSystemEncryption()
  try {
    const encrypted = await fs.readFile(BILI_CREDENTIAL_PATH())
    return JSON.parse(safeStorage.decryptString(encrypted))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    // 数据目录被搬到另一台电脑/另一个 Windows 用户时，DPAPI 解不开旧登录态。
    // 不再每轮轮询都抛错，按“未登录”处理，界面和日志各提示一次。
    if (!biliCredentialUnreadableLogged) {
      biliCredentialUnreadableLogged = true
      logDiagnostic('warn', 'bili-credential-unreadable', 'B站登录态无法解密，需要重新扫码登录。')
    }
    return null
  }
}

async function saveBiliCredential(credential) {
  requireSystemEncryption()
  await fs.mkdir(path.dirname(BILI_CREDENTIAL_PATH()), { recursive: true })
  const encrypted = safeStorage.encryptString(JSON.stringify(credential))
  await fs.writeFile(BILI_CREDENTIAL_PATH(), encrypted, { mode: 0o600 })
}

function clearActiveQr() {
  activeQrKey = null
  if (activeQrTimer) clearTimeout(activeQrTimer)
  activeQrTimer = null
}

// 每个模型的 API Key 都单独加密保存在 model-keys.bin；0.7.0 的单个 model-key.bin 会自动迁移过来。
async function readKeyStore() {
  try {
    const encrypted = await fs.readFile(MODEL_KEYS_PATH())
    if (!safeStorage.isEncryptionAvailable()) return {}
    return normalizeKeyStore(JSON.parse(safeStorage.decryptString(encrypted)))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    if (!keyStoreUnreadableLogged) {
      keyStoreUnreadableLogged = true
      logDiagnostic('warn', 'model-keys-unreadable', 'API Key 无法解密，需要重新填写。')
    }
    return {}
  }
}

async function writeKeyStore(store) {
  requireSystemEncryption()
  await fs.mkdir(path.dirname(MODEL_KEYS_PATH()), { recursive: true })
  await fs.writeFile(MODEL_KEYS_PATH(), safeStorage.encryptString(JSON.stringify(normalizeKeyStore(store))), { mode: 0o600 })
}

async function readLegacyKey() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return ''
    return String(safeStorage.decryptString(await fs.readFile(KEY_PATH())) || '').trim()
  } catch { return '' }
}

// 只有存在旧 key 文件且还没有多模型密钥库时才迁移，避免每次启动都读旧文件。
async function loadModelKeys(models) {
  let store = await readKeyStore()
  if (Object.keys(store).length || !models.length) return store
  const legacy = await readLegacyKey()
  if (!legacy) return store
  store = withProfileKey(store, models[0].id, legacy)
  try {
    await writeKeyStore(store)
    await fs.rm(KEY_PATH(), { force: true })
    logDiagnostic('info', 'model-key-migrated', `models=${models.length}`)
  } catch (error) {
    logDiagnostic('warn', 'model-key-migrate-failed', errorSummary(error))
  }
  return store
}

async function readSettings() {
  try {
    const data = JSON.parse(await fs.readFile(CONFIG_PATH(), 'utf8'))
    const personaUpdatedAt = typeof data.personaUpdatedAt === 'string' ? new Date(data.personaUpdatedAt) : null
    const { models, primaryModelId, fallbackModelId } = readModelProfiles(data)
    const store = await loadModelKeys(models)
    const withKeys = models.map((profile) => ({ ...profile, hasApiKey: Boolean(keyForProfile(store, profile.id)) }))
    const primary = withKeys.find((profile) => profile.id === primaryModelId) || null
    return {
      models: withKeys,
      primaryModelId: primary?.id || '',
      fallbackModelId: withKeys.some((profile) => profile.id === fallbackModelId) && fallbackModelId !== primary?.id ? fallbackModelId : '',
      modelReady: withKeys.some((profile) => profileIsReady(profile)),
      // 下面这些扁平字段保持 0.7.0 的形状，供就绪判断和旧代码读取，值取自首选模型。
      providerName: primary?.providerName || '',
      baseUrl: primary?.baseUrl || '',
      requestFormat: primary?.requestFormat || 'openai',
      model: primary?.model || '',
      temperature: primary?.temperature ?? DEFAULT_TEMPERATURE,
      visionMode: primary?.visionMode || 'auto',
      hasApiKey: Boolean(primary?.hasApiKey),
      preferences: normalizePreferences(data.preferences),
      interaction: normalizeInteractionConfig(data.interaction),
      reading: readReadingConfig(data.reading),
      readingLastRead: readReadingLastRead(data.readingLastRead),
      screen: readScreenConfig(data.screen),
      reportDm: normalizeReportDmConfig(data.reportDm),
      diary: readDiaryConfig(data.diary),
      persona: readSavedPersona(data.persona),
      personaUpdatedAt: personaUpdatedAt && Number.isFinite(personaUpdatedAt.getTime()) ? personaUpdatedAt.toISOString() : '',
    }
  } catch {
    return { models: [], primaryModelId: '', fallbackModelId: '', modelReady: false, providerName: '', baseUrl: '', requestFormat: 'openai', model: '', temperature: DEFAULT_TEMPERATURE, visionMode: 'auto', hasApiKey: false, preferences: '', interaction: normalizeInteractionConfig({}), reading: normalizeReadingConfig({}), readingLastRead: normalizeReadingLastRead({}), screen: normalizeScreenConfig({}), reportDm: normalizeReportDmConfig({}), diary: normalizeDiaryConfig({}), persona: '', personaUpdatedAt: '' }
  }
}

function publicProfile(profile) {
  return {
    id: profile.id,
    providerName: profile.providerName,
    baseUrl: profile.baseUrl,
    requestFormat: profile.requestFormat,
    model: profile.model,
    temperature: profile.temperature,
    visionMode: profile.visionMode,
    hasApiKey: profile.hasApiKey === true,
    ready: profileIsReady(profile),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }
}

// 只把模型档案的可见字段送到渲染层，API Key 永远不出主进程。
function modelState(settings) {
  return {
    models: settings.models.map(publicProfile),
    primaryModelId: settings.primaryModelId,
    fallbackModelId: settings.fallbackModelId,
    maxModels: MAX_MODELS,
  }
}

function readReadingConfig(value) {
  try { return normalizeReadingConfig(value) } catch { return normalizeReadingConfig({}) }
}

// 已推荐记录的保留天数由“发布时间窗”推导（窗 + 1 天）。读不到设置时按默认 7 天窗口算。
async function historyRetentionSetting() {
  try {
    const settings = await readSettings()
    return historyRetentionDays(settings.screen.maxAgeDays)
  } catch { return historyRetentionDays(undefined) }
}

function readReadingLastRead(value) {
  return normalizeReadingLastRead(value)
}

function readDiaryConfig(value) {
  try { return normalizeDiaryConfig(value) } catch { return normalizeDiaryConfig({}) }
}

async function writeConfig(settings) {
  // 写入时再次规范化，但坏掉的历史数据只做兜底保留，不能让整次保存失败。
  const models = (Array.isArray(settings?.models) ? settings.models : []).slice(0, MAX_MODELS).map((profile) => {
    try { return normalizeModelProfile(profile) } catch { return readModelProfile(profile) }
  })
  const payload = {
    models,
    ...normalizeChainSelection(models, settings?.primaryModelId, settings?.fallbackModelId),
    preferences: normalizePreferences(settings?.preferences),
    interaction: normalizeInteractionConfig(settings?.interaction),
    reading: normalizeReadingConfig(settings?.reading),
    readingLastRead: normalizeReadingLastRead(settings?.readingLastRead),
    screen: normalizeScreenConfig(settings?.screen),
    reportDm: normalizeReportDmConfig(settings?.reportDm),
    diary: normalizeDiaryConfig(settings?.diary),
    persona: readSavedPersona(settings?.persona),
    personaUpdatedAt: String(settings?.personaUpdatedAt || ''),
  }
  await fs.mkdir(path.dirname(CONFIG_PATH()), { recursive: true })
  await fs.writeFile(CONFIG_PATH(), JSON.stringify(payload, null, 2), { mode: 0o600 })
}

// 保存单个模型档案：新增或编辑，Key 单独加密写入 model-keys.bin。
async function saveModelProfile(input) {
  const existing = await readSettings()
  const rawId = String(input?.id || '').trim()
  const current = rawId ? existing.models.find((profile) => profile.id === rawId) : null
  if (rawId && !current) throw new Error('要编辑的模型不存在，请刷新后重试。')
  if (!current && existing.models.length >= MAX_MODELS) throw new Error(`最多可以添加 ${MAX_MODELS} 个模型。`)
  const now = new Date()
  const profile = normalizeModelProfile({
    id: current?.id || undefined,
    providerName: input?.providerName,
    baseUrl: input?.baseUrl,
    requestFormat: input?.requestFormat,
    model: input?.model,
    temperature: input?.temperature,
    visionMode: input?.visionMode,
    createdAt: current?.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
  }, { now })
  const apiKey = String(input?.apiKey ?? '')
  if (apiKey.length > 4096) throw new Error('API Key 长度超出限制。')
  if (apiKey && !safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，已拒绝保存 API Key。')

  const models = current
    ? existing.models.map((item) => (item.id === current.id ? { ...profile } : item))
    : [...existing.models, profile]
  const selection = normalizeChainSelection(
    models,
    existing.primaryModelId || models[0]?.id,
    existing.fallbackModelId,
  )
  const generation = ++interactionGeneration
  await writeConfig({ ...existing, models, ...selection })
  if (apiKey) {
    const store = withProfileKey(await readKeyStore(), profile.id, apiKey)
    await writeKeyStore(store)
  }
  logDiagnostic('info', current ? 'model-profile-updated' : 'model-profile-added', `id=${profile.id} total=${models.length}`)
  const saved = await readSettings()
  configureInteractionMonitor(saved, generation)
  return { ...modelState(saved), savedProfileId: profile.id }
}

async function deleteModelProfile(idInput) {
  const existing = await readSettings()
  const id = String(idInput || '').trim()
  if (!existing.models.some((profile) => profile.id === id)) throw new Error('要删除的模型不存在。')
  const models = existing.models.filter((profile) => profile.id !== id)
  const selection = normalizeChainSelection(models, existing.primaryModelId === id ? models[0]?.id : existing.primaryModelId, existing.fallbackModelId)
  const generation = ++interactionGeneration
  await writeConfig({ ...existing, models, ...selection })
  const store = pruneKeyStore(await readKeyStore(), models)
  if (safeStorage.isEncryptionAvailable()) await writeKeyStore(store).catch(() => {})
  logDiagnostic('info', 'model-profile-deleted', `id=${id} total=${models.length}`)
  const saved = await readSettings()
  configureInteractionMonitor(saved, generation)
  return modelState(saved)
}

// 首选 / 备用的位置调整：只能指定已存在的模型，且两者不能相同。
async function setModelChain(input = {}) {
  const existing = await readSettings()
  if (!existing.models.length) throw new Error('请先添加至少一个模型。')
  const selection = normalizeChainSelection(existing.models, input?.primaryModelId, input?.fallbackModelId)
  if (String(input?.fallbackModelId || '').trim() && !selection.fallbackModelId) throw new Error('备用模型不存在或与首选模型相同。')
  if (selection.primaryModelId !== existing.primaryModelId || selection.fallbackModelId !== existing.fallbackModelId) {
    await writeConfig({ ...existing, ...selection })
  }
  logDiagnostic('info', 'model-chain-saved', `primary=${selection.primaryModelId} fallback=${selection.fallbackModelId || 'none'}`)
  return modelState(await readSettings())
}

// 这个入口只保存非模型的设置（互动监听等）；模型档案走 saveModelProfile。
async function saveSettings(input) {
  const existing = await readSettings()
  // 内容偏好现在只在【提示词】页保存；模型设置不再提交该字段，缺省时保留原值。
  const preferences = input?.preferences === undefined ? existing.preferences : normalizePreferences(input.preferences)
  const interaction = normalizeInteractionConfig(input?.interaction)
  const reading = input?.reading === undefined ? existing.reading : normalizeReadingConfig(input.reading)
  const readingLastRead = input?.readingLastRead === undefined ? existing.readingLastRead : normalizeReadingLastRead(input.readingLastRead)
  const diary = input?.diary === undefined ? existing.diary : normalizeDiaryConfig(input.diary)
  const persona = input?.persona === undefined ? existing.persona : normalizePersona(input.persona)
  const screen = input?.screen === undefined ? existing.screen : normalizeScreenConfig(input.screen)
  const reportDm = input?.reportDm === undefined ? existing.reportDm : normalizeReportDmConfig(input.reportDm)
  const personaUpdatedAt = input?.persona === undefined ? existing.personaUpdatedAt : (personaIsEmpty(persona) ? '' : new Date().toISOString())
  const generation = ++interactionGeneration
  await writeConfig({ ...existing, preferences, interaction, reading, readingLastRead, screen, reportDm, diary, persona, personaUpdatedAt })
  const saved = await readSettings()
  configureInteractionMonitor(saved, generation)
  return saved
}

function promptState(settings) {
  return {
    persona: settings.persona,
    personaUpdatedAt: settings.personaUpdatedAt,
    preferences: settings.preferences,
    maxCustomChars: PERSONA_MAX_CHARS,
    maxPreferenceChars: PREFERENCE_MAX_CHARS,
    systemPrompts: listSystemPrompts(),
  }
}

async function readPrompts() {
  return promptState(await readSettings())
}

async function savePersona(value) {
  const persona = normalizePersona(value)
  const existing = await readSettings()
  const personaUpdatedAt = personaIsEmpty(persona) ? '' : new Date().toISOString()
  await writeConfig({ ...existing, persona, personaUpdatedAt })
  logDiagnostic('info', 'persona-saved', personaIsEmpty(persona) ? 'cleared' : `customChars=${persona.custom.length}`)
  return promptState(await readSettings())
}

// 内容偏好只用于视频筛选；保存后自动读取和手动分析都会使用。
async function saveContentPreferences(value) {
  const preferences = normalizePreferences(value)
  const existing = await readSettings()
  await writeConfig({ ...existing, preferences })
  logDiagnostic('info', 'content-preferences-saved', `chars=${preferences.length}`)
  return promptState(await readSettings())
}

async function saveReadingConfig(value) {
  const existing = await readSettings()
  const reading = normalizeReadingConfig(value)
  // 这个入口就是标题排除框的保存路径：只要带了 screen，就视为用户已经亲自确认过词表；
  // 之后即使清空也不会再被默认词覆盖。
  const screen = value?.screen === undefined
    ? existing.screen
    : normalizeScreenConfig({ ...value.screen, titleExcludeCustomized: true })
  const reportDm = value?.reportDm === undefined ? existing.reportDm : normalizeReportDmConfig(value.reportDm)
  await writeConfig({ ...existing, reading, screen, reportDm })
  readingConfigUpdatedAt = Date.now()
  // 缩短发布时间窗后立即按新的保留期清理一次已推荐记录，不必等到下一次保存报告。
  try {
    const pruned = await pruneHistoryFile(HISTORY_PATH(), { retentionDays: historyRetentionDays(screen.maxAgeDays) })
    if (pruned.removed) logDiagnostic('info', 'analysis-history-pruned', `removed=${pruned.removed} kept=${pruned.kept}`)
  } catch (error) { logDiagnostic('warn', 'analysis-history-prune-failed', errorSummary(error)) }
  logDiagnostic('info', 'bili-reading-config-saved', `windows=${reading.windows.length} interval=${reading.autoIntervalMinutes} skipNoSubtitle=${screen.skipNoSubtitle} excludes=${screen.titleExclude.length} maxAgeDays=${screen.maxAgeDays} reportDm=${reportDm.enabled}`)
  return readingStatus()
}

async function saveDiaryConfig(value) {
  const existing = await readSettings()
  const diary = normalizeDiaryConfig(value)
  await writeConfig({ ...existing, diary })
  diaryRetryAfter = 0
  // 缩短保留天数后立即清理，不必等到下一次写日记或重启才生效。
  await pruneDiaryFiles()
  logDiagnostic('info', 'diary-config-saved', `enabled=${diary.enabled} auto=${diary.autoEnabled} public=${diary.publicEnabled} private=${diary.privateEnabled} time=${diary.time} retention=${diary.retentionDays}`)
  return diaryStatus()
}

async function readingStatus() {
  const settings = await readSettings()
  const windowState = readingWindowState(settings.reading.windows)
  const state = await readReadingState(READING_STATE_PATH())
  const dmState = await readReportDmState(REPORT_DM_STATE_PATH()).catch(() => normalizeReportDmState({}))
  const today = localDay()
  const enabled = autoEnabled(settings.reading)
  const dueAt = nextAutoRunAt(settings.reading, state.lastRunAt)
  const quietUntil = readingConfigUpdatedAt ? new Date(readingConfigUpdatedAt + 60_000) : null
  const effectiveDue = dueAt && quietUntil && quietUntil > dueAt ? quietUntil : dueAt
  const dueClock = effectiveDue ? effectiveDue.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''
  const windowMessage = !enabled
    ? '自动读取未开启：设置读取时间窗和自动读取间隔后生效；手动读取不受影响。'
    : windowState.allowed
      ? `当前在读取时间窗内（${windowState.active.start}–${windowState.active.end}）；${dueClock ? `下次自动读取约 ${dueClock}。` : 'agent 会自动读取并保存报告。'}`
      : `${windowState.message} 手动读取不受时间窗限制。`
  return {
    allowed: windowState.allowed,
    windows: windowState.windows,
    autoEnabled: enabled,
    autoIntervalMinutes: settings.reading.autoIntervalMinutes,
    message: windowMessage,
    nextAutoRunAt: effectiveDue ? effectiveDue.toISOString() : '',
    auto: {
      running: readingAutoInFlight,
      lastRunAt: state.lastRunAt,
      lastReport: state.lastReport,
      lastResult: state.lastResult,
    },
    lastRead: settings.readingLastRead,
    preferences: settings.preferences,
    screen: settings.screen,
    // 界面只让用户填“最近几天”，记录保留期由代码推导后回显，避免两个数字填反。
    historyRetentionDays: historyRetentionDays(settings.screen.maxAgeDays),
    reportDm: {
      enabled: settings.reportDm.enabled,
      recipientUid: settings.persona.ownerUid,
      lastSentAt: dmState.lastSentAt,
      lastReport: dmState.lastReport,
      lastResult: dmState.lastResult,
      sentToday: dmState.daily.date === today ? dmState.daily.count : 0,
      dailyLimit: REPORT_DM_DAILY_LIMIT,
    },
  }
}

async function tickReadingAuto() {
  if (readingAutoInFlight) return
  // 设置刚保存后留出一分钟静默期，避免用户还在编辑时间窗时就被自动读取打断。
  if (Date.now() - readingConfigUpdatedAt < 60_000) return
  readingAutoInFlight = true
  try {
    const settings = await readSettings()
    const state = await readReadingState(READING_STATE_PATH())
    if (!autoEnabled(settings.reading) || !shouldAutoRun(settings.reading, state.lastRunAt, new Date())) return
    await runReadingAuto(settings, state)
  } catch (error) {
    logDiagnostic('error', 'reading-auto-tick-failed', errorSummary(error))
  } finally {
    readingAutoInFlight = false
  }
}

// 互动消息里的图片：手机直出照片常有几 MB，超过大部分供应商的单图上限。
// 用 Electron 自带解码把长边压到 1568px、转 JPEG；仍超过目标体积时继续降边长和质量。
// 压缩失败就退回原图（由调用方按目标体积决定要不要这张）。
const INTERACTION_IMAGE_MAX_EDGE = 1568
const INTERACTION_IMAGE_QUALITY = 82
// 目标体积留一点余量，别正好顶到 2 MB 上限。
const INTERACTION_IMAGE_TARGET_BYTES = 1_800_000

function encodeJpeg(image, quality) {
  const output = image.toJPEG(quality)
  return output?.byteLength ? output : null
}

function downscaleImage({ bytes, contentType, maxBytes = INTERACTION_IMAGE_TARGET_BYTES }) {
  // GIF 会丢动画，不处理；解码失败也不处理。
  if (contentType === 'image/gif') return null
  try {
    let image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) return null
    const size = image.getSize()
    const edge = Math.max(size.width, size.height)
    if (edge > INTERACTION_IMAGE_MAX_EDGE) {
      // 边长超限时优先满足尺寸要求：即使 JPEG 比原图略大也要缩放，
      // 否则供应商仍可能因为像素过多拒绝这张图。
      image = image.resize({
        width: Math.max(1, Math.round(size.width * INTERACTION_IMAGE_MAX_EDGE / edge)),
        height: Math.max(1, Math.round(size.height * INTERACTION_IMAGE_MAX_EDGE / edge)),
        quality: 'good',
      })
    }
    // 先按标准质量编码；太大了再逐级降质量、必要时继续缩边长。
    // 手机直出的 8 MB 照片只缩长边往往还在 3 MB 以上，一次就放弃等于永远发不出去。
    let best = encodeJpeg(image, INTERACTION_IMAGE_QUALITY)
    if (!best) return null
    if (best.byteLength > maxBytes) {
      for (const quality of [70, 60, 50, 40]) {
        const attempt = encodeJpeg(image, quality)
        if (attempt && attempt.byteLength < best.byteLength) best = attempt
        if (best.byteLength <= maxBytes) break
      }
    }
    if (best.byteLength > maxBytes) {
      // 降质量还不够：按比例继续缩边长，最多试三轮。
      let current = image
      for (const scale of [0.8, 0.65, 0.5]) {
        const width = Math.max(1, Math.round(current.getSize().width * scale))
        const height = Math.max(1, Math.round(current.getSize().height * scale))
        current = current.resize({ width, height, quality: 'good' })
        const attempt = encodeJpeg(current, 60)
        if (attempt && attempt.byteLength < best.byteLength) best = attempt
        if (best.byteLength <= maxBytes) break
      }
    }
    // 尺寸本来合规且压完并不更小：保留原图，避免把清晰的小图压糊。
    if (edge <= INTERACTION_IMAGE_MAX_EDGE && best.byteLength >= bytes.byteLength) return null
    return { bytes: best, contentType: 'image/jpeg' }
  } catch { return null }
}

// 图片库文件的 MIME 类型：上传时告诉 B站这是什么格式。
function imageContentType(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.bmp') return 'image/bmp'
  return 'image/jpeg'
}

// 把设置里的“首选 + 备用”解析成带 Key 的调用链；不可用的模型（缺地址/名称/Key）会被跳过。
async function modelChainFor(settings) {
  const store = await readKeyStore()
  return resolveModelChain(settings)
    .map((profile) => ({ ...profile, apiKey: keyForProfile(store, profile.id) }))
    .filter((profile) => profileIsReady(profile))
}

// 首选模型失败后自动改用备用模型；两个都失败时抛出的错误已包含各自原因。
async function runWithModelChain(settings, run) {
  const chain = await modelChainFor(settings)
  if (!chain.length) throw new Error('请先在模型设置中保存可用的模型（API 地址、模型名称和 API Key）。')
  return runModelChain({
    chain,
    run,
    log: (level, event, detail) => logDiagnostic(level, event, detail),
  })
}

async function runReadingAuto(settings, previousState) {
  const startedAt = new Date()
  try {
    const credential = await readBiliCredential().catch(() => null)
    const account = credential ? await getAccountStatus(credential).catch(() => ({ loggedIn: false })) : { loggedIn: false }
    const outcome = await executeReadingAuto({
      lastRead: settings.readingLastRead,
      hasApiKey: Boolean(settings.modelReady),
      credential,
      account,
      screen: settings.screen,
      now: startedAt,
      previousState,
      discover: (keyword, sources) => discoverVideos(keyword, credential, { page: 1, sources }),
      readHistory: (options = {}) => readHistory(HISTORY_PATH(), options),
      fetchVideo: (bvid) => fetchVideoForAnalysis(bvid, credential),
      analyze: async (details) => {
        const { result } = await runWithModelChain(settings, (profile) => analyzeVideosWithModel({
          baseUrl: profile.baseUrl,
          model: profile.model,
          apiKey: profile.apiKey,
          candidates: details,
          temperature: profile.temperature,
          preferences: settings.preferences,
          persona: settings.persona,
        }))
        return result
      },
      // 推送不再点赞：写操作等主人在私信里明确要求后，由互动回复链路按推送台账执行。
      // 只有 agent 选进报告的 3 条才记入历史；落选候选不记，下一轮仍可能被看到。
      saveReport: (title, result) => saveReport({ title, content: result.report, relatedVideoIds: result.recommendedBvids || result.selectedBvids || result.analyzedBvids }),
      deliverReport: ({ name, content }) => deliverReportDm({ reportName: name, content, trigger: 'auto' }),
      log: (level, event, error) => logDiagnostic(level, event, errorSummary(error)),
    })
    if (outcome.report) logDiagnostic('info', 'reading-auto-report-saved', `report=${outcome.report}`)
    // 间隔从上一次自动读取结束时算起，避免一次耗时较长的读取刚结束就立刻再跑一轮。
    const finishedState = normalizeReadingState({ ...outcome.state, lastRunAt: new Date().toISOString() })
    try { await writeReadingState(READING_STATE_PATH(), finishedState) }
    catch (error) { logDiagnostic('error', 'reading-auto-state-write-failed', errorSummary(error)) }
  } catch (error) {
    logDiagnostic('error', 'reading-auto-failed', errorSummary(error))
    const message = `自动读取失败：${errorSummary(error)}。`
    const state = normalizeReadingState({ lastRunAt: new Date().toISOString(), lastReport: previousState.lastReport, lastResult: message })
    try { await writeReadingState(READING_STATE_PATH(), state) }
    catch (writeError) { logDiagnostic('error', 'reading-auto-state-write-failed', errorSummary(writeError)) }
  }
}

// 报告文件保存成功后的私信投递：模板保证可发，模型的一句话是可选加分项。
async function deliverReportDm({ reportName, content, trigger = 'auto' }) {
  const settings = await readSettings()
  if (!settings.reportDm.enabled) return { sent: false, skipped: true, message: '报告私信未开启。' }
  const credential = await readBiliCredential().catch(() => null)
  const account = credential ? await getAccountStatus(credential).catch(() => ({ loggedIn: false })) : { loggedIn: false }
  const state = await readReportDmState(REPORT_DM_STATE_PATH())
  const outcome = await executeReportDm({
    reportName,
    content,
    persona: settings.persona,
    config: settings.reportDm,
    state,
    credential,
    account,
    now: new Date(),
    generateLine: async ({ reportName: name, items }) => {
      if (!items.length || !settings.modelReady) return ''
      const { result } = await runWithModelChain(settings, (profile) => generateReportDmLine({
        baseUrl: profile.baseUrl,
        model: profile.model,
        apiKey: profile.apiKey,
        temperature: profile.temperature,
        reportName: name,
        items,
        persona: settings.persona,
      }))
      return result
    },
    sendMessage: (receiverUid, text) => sendPrivateMessageTo(credential, account.mid, receiverUid, text),
    log: (level, event, error) => logDiagnostic(level, event, errorSummary(error)),
  })
  if (outcome.stateChanged) {
    try { await writeReportDmState(REPORT_DM_STATE_PATH(), outcome.state) }
    catch (error) { logDiagnostic('error', 'report-dm-state-write-failed', errorSummary(error)) }
  }
  // 私信发出去之后才记台账：主人是按「私信里看到的推送」提要求的，
  // 没发出去的推送不该出现在候选里（否则会让 agent 对主人没看过的视频动手）。
  if (outcome.sent && Array.isArray(outcome.pushItems) && outcome.pushItems.length) {
    try {
      const recorded = await recordPush(PUSH_LOG_PATH(), {
        report: reportName,
        items: outcome.pushItems,
        now: new Date(),
      })
      logDiagnostic('info', 'push-log-recorded', `${recorded.count} 条｜${describePushLog(recorded.log)}`)
    } catch (error) {
      logDiagnostic('warn', 'push-log-write-failed', errorSummary(error))
    }
  }
  logDiagnostic(outcome.sent ? 'info' : outcome.skipped ? 'info' : 'warn', 'report-dm', `${trigger}:${outcome.message}`)
  return { sent: outcome.sent, skipped: outcome.skipped, message: outcome.message }
}

function diaryPath(kind) {
  if (!DIARY_KINDS.includes(kind)) throw new Error('日记类型无效。')
  return path.join(DIARY_DIR(), DIARY_FILE_NAMES[kind])
}

async function readDiaryFile(kind) {
  try {
    return await readUtf8FileLimited(diaryPath(kind), 512 * 1024)
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    if (error.message === '文件超过读取大小限制。') throw new Error('日记文件超过 512 KB，无法读取。')
    throw error
  }
}

async function writeDiaryFile(kind, text) {
  const filePath = diaryPath(kind)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tempPath, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await fs.rename(tempPath, filePath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

function truncateText(value, max) {
  const text = String(value || '').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// 启动和写入时都执行保留期清理：即使应用整晚没开，下次打开也会补上“第 8 天删第 1 天”。
async function pruneDiaryFiles(now = new Date()) {
  let settings
  try { settings = await readSettings() } catch { return { removed: [] } }
  if (!settings.diary.enabled) return { removed: [] }
  const removed = []
  for (const kind of DIARY_KINDS) {
    try {
      const text = await readDiaryFile(kind)
      const result = pruneDiaryText({ text, title: DIARY_KIND_LABELS[kind], retentionDays: settings.diary.retentionDays, now })
      if (result.removed.length) {
        await writeDiaryFile(kind, result.text)
        removed.push(...result.removed.map((date) => `${kind}:${date}`))
      }
    } catch (error) {
      logDiagnostic('warn', 'diary-prune-failed', `${kind}:${errorSummary(error)}`)
    }
  }
  if (removed.length) logDiagnostic('info', 'diary-pruned', `count=${removed.length}`)
  return { removed }
}

// 升级到带推送台账的版本时，把已有的自动报告回填成台账（只做一次）。
//
// 不回填的话，新版本第一次运行时 agent 依旧“不记得推过什么”，
// 得等到下一次自动读取才有记录——而这正是主人抱怨的那个空窗期。
// 只在台账文件不存在时运行；回填失败不阻塞启动，下次启动会再试。
async function backfillPushLog() {
  try {
    const existing = await readPushLog(PUSH_LOG_PATH())
    if (existing.pushes.length) return
    let names = []
    try { names = (await listReports()).map((item) => item.name) } catch { return }
    // listReports 返回的是去掉 .md 的报告名；isAutoReportName 两种写法都认。
    const autoNames = names.filter(isAutoReportName).slice(0, 30)
    if (!autoNames.length) return
    const reports = []
    for (const name of autoNames) {
      try {
        const loaded = await readReport(name)
        reports.push({ name: loaded.name, content: loaded.content })
      } catch (error) { logDiagnostic('warn', 'push-log-backfill-read-failed', errorSummary(error)) }
    }
    const log = buildPushLogFromReports(reports)
    if (!log.pushes.length) return
    await recordPush(PUSH_LOG_PATH(), {
      report: log.pushes[0].report,
      items: log.pushes[0].items,
      now: new Date(log.pushes[0].pushedAt),
    })
    // 剩下的（更早的）报告逐条补进去，保证顺序与真实推送时间一致。
    for (const entry of log.pushes.slice(1)) {
      await recordPush(PUSH_LOG_PATH(), { report: entry.report, items: entry.items, now: new Date(entry.pushedAt) })
    }
    logDiagnostic('info', 'push-log-backfilled', `${autoNames.length} 份报告｜${describePushLog(await readPushLog(PUSH_LOG_PATH()))}`)
  } catch (error) {
    logDiagnostic('warn', 'push-log-backfill-failed', errorSummary(error))
  }
}

async function collectDiaryActivity(settings, now = new Date()) {
  const day = localDayKey(now)
  const reports = []
  try {
    const items = await listReports()
    for (const item of items.filter((entry) => localDayKey(new Date(entry.modifiedAt)) === day).slice(0, 8)) {
      try {
        const loaded = await readReport(item.name)
        reports.push({ name: loaded.name, content: truncateText(loaded.content, 1500) })
      } catch (error) {
        logDiagnostic('warn', 'diary-report-read-failed', errorSummary(error))
      }
    }
  } catch (error) {
    logDiagnostic('warn', 'diary-report-list-failed', errorSummary(error))
  }
  let interactions = { sentToday: 0 }
  try {
    const state = await readInteractionState(INTERACTION_STATE_PATH(), now)
    if (state.daily.date === day) interactions.sentToday = state.daily.count
  } catch { /* 互动状态损坏不应阻塞写日记 */ }
  const reading = {
    keyword: settings.readingLastRead.keyword,
    sources: settings.readingLastRead.sources,
    lastResult: '',
  }
  try {
    const state = await readReadingState(READING_STATE_PATH())
    if (state.lastResult) reading.lastResult = state.lastResult
  } catch { /* 读取状态不可读时只写空摘要 */ }
  return { reports, interactions, reading, preferences: settings.preferences }
}

async function diaryStatus() {
  const settings = await readSettings()
  const state = await readDiaryState(DIARY_STATE_PATH())
  const now = new Date()
  const next = nextDiaryRunAt(settings.diary, state, now)
  const today = localDayKey(now)
  const counts = {}
  for (const kind of DIARY_KINDS) {
    try {
      const sections = parseDiarySections(await readDiaryFile(kind))
      counts[kind] = {
        count: sections.length,
        newest: sections[0]?.date || '',
        oldest: sections[sections.length - 1]?.date || '',
      }
    } catch {
      counts[kind] = { count: 0, newest: '', oldest: '' }
    }
  }
  return {
    ...settings.diary,
    nextRunAt: next ? next.toISOString() : '',
    lastRunAt: state.lastRunAt,
    lastRunDate: state.lastRunDate,
    lastResult: state.lastResult,
    writtenToday: counts.public.newest === today || counts.private.newest === today,
    entryCounts: counts,
  }
}

async function diaryEntries() {
  const result = {}
  for (const kind of DIARY_KINDS) result[kind] = parseDiarySections(await readDiaryFile(kind))
  return result
}

async function deleteDiaryEntry(kind, date) {
  if (!DIARY_KINDS.includes(kind)) throw new Error('日记类型无效。')
  const day = String(date || '')
  if (!isValidDayKey(day)) throw new Error('日记日期无效。')
  const text = await readDiaryFile(kind)
  const sections = parseDiarySections(text)
  const remaining = sections.filter((section) => section.date !== day)
  if (remaining.length === sections.length) throw new Error('没有找到这篇日记。')
  await writeDiaryFile(kind, formatDiaryFile(DIARY_KIND_LABELS[kind], remaining))
  logDiagnostic('info', 'diary-entry-deleted', `${kind}:${day}`)
  return { deleted: true, kind, date: day }
}

async function runDiaryGeneration({ settings, state, trigger, now = new Date() }) {
  const outcome = await executeDiaryGeneration({
    config: settings.diary,
    state,
    hasApiKey: Boolean(settings.modelReady),
    now,
    trigger,
    readDiary: (kind) => readDiaryFile(kind),
    writeDiary: (kind, text) => writeDiaryFile(kind, text),
    collectActivity: () => collectDiaryActivity(settings, now),
    generate: async ({ day, activity, publicHistory, privateHistory, retentionDays }) => {
      const { result } = await runWithModelChain(settings, (profile) => generateDiariesWithModel({
        baseUrl: profile.baseUrl,
        model: profile.model,
        apiKey: profile.apiKey,
        temperature: profile.temperature,
        day,
        activity,
        publicHistory,
        privateHistory,
        retentionDays,
        persona: settings.persona,
        requirePublic: settings.diary.publicEnabled,
        requirePrivate: settings.diary.privateEnabled,
      }))
      return result
    },
    log: (level, event, error) => logDiagnostic(level, event, errorSummary(error)),
  })
  if (outcome.stateChanged) {
    try { await writeDiaryState(DIARY_STATE_PATH(), outcome.state) }
    catch (error) { logDiagnostic('error', 'diary-state-write-failed', errorSummary(error)) }
  }
  if (outcome.failed) logDiagnostic('error', 'diary-write-failed', outcome.message)
  else if (outcome.skipped) logDiagnostic('info', 'diary-skipped', outcome.message)
  else logDiagnostic('info', 'diary-written', `trigger=${trigger} day=${outcome.day} written=${(outcome.written || []).join(',')} removed=${(outcome.removed || []).length}`)
  return outcome
}

async function writeDiaryNow() {
  if (diaryInFlight) throw new Error('日记正在生成，请稍候。')
  const settings = await readSettings()
  if (!settings.diary.enabled) throw new Error('日记总开关已关闭。')
  if (!settings.diary.publicEnabled && !settings.diary.privateEnabled) throw new Error('请至少启用一本日记。')
  if (!settings.modelReady) throw new Error('请先在模型设置中添加可用的模型（API 地址、模型名称和 API Key）。')
  diaryInFlight = true
  try {
    const state = await readDiaryState(DIARY_STATE_PATH())
    const outcome = await runDiaryGeneration({ settings, state, trigger: 'manual', now: new Date() })
    return { message: outcome.message, skipped: outcome.skipped, failed: outcome.failed, status: await diaryStatus() }
  } finally {
    diaryInFlight = false
  }
}

async function tickDiaryAuto() {
  if (diaryInFlight || Date.now() < diaryRetryAfter) return
  try {
    const settings = await readSettings()
    const state = await readDiaryState(DIARY_STATE_PATH())
    const now = new Date()
    if (!diaryDue(settings.diary, state, now)) return
    if (!settings.modelReady) return
    diaryInFlight = true
    await runDiaryGeneration({ settings, state, trigger: 'auto', now })
  } catch (error) {
    // 读取/写入等硬失败时退避十分钟，避免每 30 秒重复请求模型或刷日志。
    diaryRetryAfter = Date.now() + 10 * 60_000
    logDiagnostic('error', 'diary-auto-failed', errorSummary(error))
  } finally {
    diaryInFlight = false
  }
}

// 删除某个模型已保存的 API Key。
async function deleteModelApiKey(idInput) {
  const id = String(idInput ?? '').trim()
  if (!id) throw new Error('请先选择要清除 API Key 的模型。')
  ++interactionGeneration
  if (interactionTimer) clearInterval(interactionTimer)
  interactionTimer = null
  const next = withoutProfileKey(await readKeyStore(), id)
  if (safeStorage.isEncryptionAvailable()) await writeKeyStore(next)
  logDiagnostic('info', 'model-api-key-removed', `id=${id}`)
  ++interactionGeneration
  const settings = await readSettings()
  configureInteractionMonitor(settings)
  return modelState(settings)
}

// 测试连接只测编辑器里当前这个模型：表单里填了就用表单值，留空的回退到该模型已保存的值。
// 绝不回退到首选模型——否则新增第二个模型时会误测到别的模型上。
async function testModelConnection(input = {}) {
  const settings = await readSettings()
  const id = String(input?.id ?? '').trim()
  const profile = id ? settings.models.find((item) => item.id === id) : null
  if (id && !profile) throw new Error('要测试的模型不存在，请刷新后重试。')
  if (!profile && !settings.models.length && !String(input?.baseUrl ?? '').trim()) {
    throw new Error('请先在模型设置中填写地址和 API Key。')
  }
  const store = await readKeyStore()
  const savedKey = profile ? keyForProfile(store, profile.id) : ''
  const target = resolveTestTarget({ profile, input, savedKey })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${target.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${target.apiKey}` },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`服务返回 HTTP ${response.status}。`)
    return { ok: true, message: testConnectionMessage(target) }
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接超时（15 秒）。')
    throw new Error(error.message || '连接失败。')
  } finally {
    clearTimeout(timeout)
  }
}

// “检查模型”允许使用界面上尚未保存的地址和 Key；Key 留空时只回退到**这个模型自己**已保存的 Key。
async function listProviderModels(input = {}) {
  const settings = await readSettings()
  const id = String(input?.id ?? '').trim()
  const profile = id ? settings.models.find((item) => item.id === id) : null
  if (id && !profile) throw new Error('要检查的模型不存在，请刷新后重试。')
  const savedKey = profile ? keyForProfile(await readKeyStore(), profile.id) : ''
  const target = resolveListTarget({ profile, input, savedKey })
  const result = await fetchProviderModels({ baseUrl: target.baseUrl, apiKey: target.apiKey })
  logDiagnostic('info', 'model-list-loaded', `count=${result.count}`)
  return result
}

async function saveReport(input) {
  const { title, content } = validateReport(input)
  const relatedVideoIds = Array.isArray(input?.relatedVideoIds) ? [...new Set(input.relatedVideoIds.map(String))] : []
  if (relatedVideoIds.some((bvid) => !/^BV[0-9A-Za-z]{10}$/.test(bvid))) throw new Error('报告关联的视频编号无效。')
  const dir = REPORT_DIR()
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${title}.md`)
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('同名报告已存在，请修改报告名称后再保存。')
    throw error
  }
  const result = { name: path.basename(filePath), path: filePath, historySaved: true }
  if (relatedVideoIds.length) {
    // 记录保留期跟着发布时间窗走，写入时顺手清掉过期记录。
    const retentionDays = await historyRetentionSetting()
    try { await recordAnalyzed(HISTORY_PATH(), relatedVideoIds, title, new Date(), { retentionDays }) }
    catch (error) {
      result.historySaved = false
      logDiagnostic('error', 'analysis-history-write-failed', errorSummary(error))
    }
  }
  return result
}

async function saveReportAndDeliver(input) {
  const saved = await saveReport(input)
  let dm
  try {
    dm = await deliverReportDm({ reportName: saved.name, content: String(input?.content || ''), trigger: 'manual' })
  } catch (error) {
    logDiagnostic('error', 'report-dm-failed', errorSummary(error))
    dm = { sent: false, skipped: false, message: '报告已保存，但私信投递失败。' }
  }
  return { ...saved, dm }
}

async function listReports() {
  let entries = []
  try { entries = await fs.readdir(REPORT_DIR(), { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const items = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    const name = entry.name.slice(0, -3)
    try { validateReportName(name) } catch { continue }
    const filePath = path.join(REPORT_DIR(), entry.name)
    try {
      const stat = await fs.stat(filePath)
      const metadata = normalizeReportMetadata({ name, modifiedAt: stat.mtime, size: stat.size })
      if (metadata) items.push(metadata)
    } catch { /* ignore entries removed or made unreadable while listing */ }
  }
  return items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 200)
}

async function readReport(nameInput) {
  const name = validateReportName(nameInput)
  const filePath = path.join(REPORT_DIR(), `${name}.md`)
  const stat = await fs.lstat(filePath)
  if (!stat.isFile()) throw new Error('报告不存在或不是普通文件。')
  try {
    return { name, content: await readUtf8FileLimited(filePath, 1024 * 1024) }
  } catch (error) {
    if (error.message === '文件超过读取大小限制。') throw new Error('报告超过 1 MB，无法在编辑器中打开。')
    throw error
  }
}

async function deleteReport(nameInput) {
  const name = validateReportName(nameInput)
  await deleteRegularFileInDirectory(REPORT_DIR(), `${name}.md`)
  return { deleted: true, name }
}

async function analyzeSelection(input) {
  const rawVideos = Array.isArray(input?.videos)
    ? input.videos
    : (Array.isArray(input?.bvids) ? input.bvids.map((bvid) => ({ bvid })) : [])
  const videos = []
  const seenVideos = new Set()
  for (const entry of rawVideos) {
    const bvid = String(entry?.bvid || '')
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid) || seenVideos.has(bvid)) continue
    seenVideos.add(bvid)
    videos.push({ bvid, source: String(entry?.source || '').slice(0, 40), followed: entry?.followed === true })
  }
  if (videos.length < 1 || videos.length > 3) {
    throw new Error('请选择 1 到 3 条有效视频进行分析。')
  }
  const credential = await readBiliCredential()
  if (!credential) throw new Error('请先扫码登录 B站。')
  const settings = await readSettings()
  if (!settings.modelReady) throw new Error('请先在模型设置中添加可用的模型（API 地址、模型名称和 API Key）。')
  requireSystemEncryption()
  const screen = settings.screen
  const now = new Date()
  const candidates = []
  const skipped = []
  for (const video of videos) {
    const detail = await fetchVideoForAnalysis(video.bvid, credential)
    if (titleExcluded(detail?.title, screen.titleExclude)) {
      skipped.push({ bvid: video.bvid, title: String(detail?.title || ''), reason: 'title' })
      continue
    }
    if (screen.skipNoSubtitle && !detail?.subtitle) {
      skipped.push({ bvid: video.bvid, title: String(detail?.title || ''), reason: 'subtitle' })
      continue
    }
    // 手动分析也守发布时间窗：主人手动挑的仍然拦，避免“手动点一下就绕过去重承诺”。
    // 详情接口的 publishedAt 优先，缺了才用候选列表带过来的那个。
    const published = { publishedAt: detail?.publishedAt || video.publishedAt || '' }
    if (publishedTooOld(published, screen.maxAgeDays, now)) {
      skipped.push({ bvid: video.bvid, title: String(detail?.title || ''), reason: 'age' })
      continue
    }
    candidates.push({ ...detail, source: video.source, followed: video.followed })
  }
  if (!candidates.length) {
    const detailText = skipped.map((item) => item.reason === 'title'
      ? `「${item.title || item.bvid}」标题命中排除词`
      : item.reason === 'age'
        ? `「${item.title || item.bvid}」超出发布时间窗`
        : `「${item.title || item.bvid}」没有可读字幕`).join('；')
    throw new Error(`所选视频都被筛选规则跳过：${detailText}。`)
  }
  const { result, profile, fallbackUsed } = await runWithModelChain(settings, (entry) => analyzeVideosWithModel({
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey: entry.apiKey,
    candidates,
    temperature: entry.temperature,
    preferences: settings.preferences,
    persona: settings.persona,
  }))
  const screenNote = describeScreening({
    titleSkipped: skipped.filter((item) => item.reason === 'title').length,
    subtitleSkipped: skipped.filter((item) => item.reason === 'subtitle').length,
    ageSkipped: skipped.filter((item) => item.reason === 'age').length,
  })
  const fallbackNote = fallbackUsed ? `本次由备用模型 ${profile.providerName || profile.model} 完成（首选模型调用失败）。` : ''
  const notes = [screenNote, fallbackNote].filter(Boolean)
  return {
    ...result,
    skipped,
    modelUsed: profile.id,
    fallbackUsed,
    // 手动分析也只把 agent 选进报告的 3 条记入历史：手动保存报告时用这个字段。
    // 落选视频不记，避免“只是被扫过一眼”也被当成已经推荐过。
    recommendedBvids: result.selectedBvids || result.analyzedBvids,
    report: notes.length ? `${result.report}\n\n---\n${notes.join('\n')}\n` : result.report,
  }
}

async function runInteractionPoll(expectedGeneration = interactionGeneration) {
  if (interactionInFlight || expectedGeneration !== interactionGeneration) return
  interactionInFlight = true
  try {
    const appSettings = await readSettings()
    const config = normalizeInteractionConfig(appSettings.interaction)
    const now = new Date()
    if (!interactionSettingsReady({ interaction: config, modelReady: appSettings.modelReady, biliLoggedIn: true })) {
      interactionStatus = { enabled: false, paused: false, sentToday: 0, message: '互动监听未启用：请设置通道、间隔、时间窗、每日限额和模型服务。' }
      return
    }
    if (!isWithinInteractionSchedule(config, now)) {
      interactionStatus = { enabled: true, paused: false, sentToday: 0, message: '当前不在互动作息时间窗内。' }
      return
    }
    let previous
    try { previous = await readInteractionState(INTERACTION_STATE_PATH(), now) }
    catch (error) {
      if (interactionTimer) clearInterval(interactionTimer)
      interactionTimer = null
      interactionStatus = { enabled: false, paused: true, sentToday: 0, message: '互动状态损坏，已停止以防重复发送。' }
      logDiagnostic('fatal', 'interaction-state-invalid', errorSummary(error))
      return
    }
    if (previous.pausedReason) {
      if (interactionTimer) clearInterval(interactionTimer)
      interactionTimer = null
      interactionStatus = { enabled: true, paused: true, sentToday: previous.daily.count, message: previous.pausedReason }
      return
    }
    if (previous.daily.count >= config.dailyLimit) {
      if (interactionTimer) clearInterval(interactionTimer)
      interactionTimer = null
      interactionStatus = { enabled: true, paused: false, sentToday: previous.daily.count, message: '今日互动发送上限已达到。' }
      return
    }
    const credential = await readBiliCredential()
    if (expectedGeneration !== interactionGeneration) return
    if (!credential) { interactionStatus = { enabled: true, paused: false, sentToday: previous.daily.count, message: 'B站未登录，互动监听未运行。' }; return }
    const account = await getAccountStatus(credential)
    if (expectedGeneration !== interactionGeneration) return
    if (!account.loggedIn || !account.mid) { interactionStatus = { enabled: true, paused: false, sentToday: previous.daily.count, message: 'B站登录态无效，互动监听未运行。' }; return }

    const result = await runInteractionCycle({
      settings: config,
      previousState: previous,
      statePath: INTERACTION_STATE_PATH(),
      credential,
      selfMid: account.mid,
      isCurrent: () => expectedGeneration === interactionGeneration,
      saveState: (state) => writeInteractionState(INTERACTION_STATE_PATH(), state),
      getNow: () => new Date(),
      fetchEvents: async () => {
        if (expectedGeneration !== interactionGeneration) return { events: [], warnings: [] }
        const events = []
        const warnings = []
        let diagnostics = {}
        if (config.commentsEnabled) {
          try {
            const inbox = await fetchCommentTriggers(credential, account.mid)
            events.push(...inbox.events)
            warnings.push(...inbox.warnings.map((kind) => `comments:${kind}`))
          } catch (error) { warnings.push(`comments:${errorSummary(error)}`) }
        }
        if (config.dmEnabled) {
          try {
            const inbox = await fetchDmTriggers(credential, account.mid, { identityDirectory })
            events.push(...inbox.events)
            diagnostics = inbox.diagnostics || diagnostics
            warnings.push(...inbox.warnings.map((kind) => `dm:${kind}`))
          } catch (error) { warnings.push(`dm:${errorSummary(error)}`) }
        }
        return { events, warnings, diagnostics }
      },
      generateReply: async (event) => {
        // 先按“历史 + 触发消息”的顺序收集所有图片引用，再逐张取回；取图失败只少一张图，不阻断回复。
        const refs = []
        for (const entry of Array.isArray(event.context) ? event.context : []) refs.push(...(entry.images || []))
        refs.push(...(event.images || []))
        const imageParts = refs.length
          // 带上登录态重试：部分会话图片要求 Cookie 才能取到；匿名先试，避免默认外发。
          ? await loadImageParts(refs, { transform: downscaleImage, cookie: bilibiliCookieHeader(credential) })
          : []
        // 之前识过图的结论随请求带上，让模型在追问时能引用，而不是重新猜。
        const knownNotes = {}
        for (const ref of refs) {
          const note = imageNoteFor(ref.url)
          if (note) knownNotes[ref.url] = note
        }
        // 私信才提供配图候选：图片库文件名就是含义，无意义文件名的图已在扫描时过滤掉。
        let libraryImages = []
        if (event.source === 'dm') {
          try { libraryImages = await listLibraryImages({ dir: DATA_LAYOUT.imagesDir }) }
          catch (error) { logDiagnostic('warn', 'image-library-read-failed', errorSummary(error)) }
        }
        // 推送台账：把「自己推过哪几条视频」交给模型，私信被挤出窗口也认得出。
        let pushLog = { version: 1, pushes: [] }
        if (event.source === 'dm') {
          pushLog = await readPushLog(PUSH_LOG_PATH())
        }
        const pushedVideos = buildPushedVideoPayload(pushLog)
        const { result } = await runWithModelChain(appSettings, async (profile) => {
          const outcome = await generateInteractionReplyDetailed({
            baseUrl: profile.baseUrl,
            model: profile.model,
            apiKey: profile.apiKey,
            temperature: profile.temperature,
            event,
            persona: appSettings.persona,
            images: imageParts,
            vision: resolveVisionEnabled(profile.visionMode, profile.model),
            imageNotes: knownNotes,
            libraryImages,
            pushedVideos,
          })
          // 模型这次看图的结论存进内存记忆，下一轮追问同一张图就有据可回。
          for (const note of outcome.imageNotes || []) {
            if (note?.url && note?.description) rememberImageNote(note.url, note.description)
          }
          return {
            reply: outcome.reply,
            attached: outcome.attached,
            described: (outcome.imageNotes || []).length,
            libraryImage: outcome.libraryImage,
            libraryCount: libraryImages.length,
            actions: outcome.actions || [],
          }
        })
        // 只记录条数/张数/失败原因，不记录任何消息正文、文件名和图片地址。
        const attached = result.attached || 0
        const described = result.described || 0
        // 附了图却一条识图结论都没拿到，通常意味着该服务把 image_url 片段丢了（不是我们没发出去）。
        const verdict = attached && !described && !result.downgraded ? '｜注意：已附图但模型未返回识图结论，该服务可能未转发图片' : (result.downgraded ? '｜已自动降级为纯文本重试' : '')
        const libraryNote = event.source === 'dm' ? `｜${describeImageLibrary(libraryImages)}，模型${result.libraryImage ? '选择配图' : '未配图'}` : ''
        // 昵称只记“有没有查到”，不记昵称本身（那是对方的个人信息）。
        const identityNote = `｜对方昵称${event.senderName ? '已取得' : '未取得'}`
        const pushNote = event.source === 'dm' ? `｜推送台账 ${describePushLog(pushLog)}` : ''
        logDiagnostic('info', 'interaction-context', `${event.source}:${describeInteractionContext(event.context)}｜图片 ${countImages(event.context, event.images)} 张，${summarizeImageParts(imageParts)}，本次附上 ${attached} 张，新增识图结论 ${described} 条${identityNote}${pushNote}${libraryNote}${verdict}`)

        // 主人明确要求点赞/收藏时，模型会在 actions 里请求；这里只对「最近推送过的视频」执行。
        // 失败不回滚已发出的回复，只记日志。
        let actionOutcome = { done: [], skipped: [], failed: [] }
        if (result.actions.length && event.source === 'dm') {
          actionOutcome = await executeRequestedActions({
            actions: result.actions,
            pushLog,
            like: (bvid) => likeVideo(bvid, credential),
            favorite: (bvid) => favoriteVideo(bvid, { ...credential, mid: account.mid }),
            now: new Date(),
            recordAction: ({ bvid, action, now }) => recordPushAction(PUSH_LOG_PATH(), { bvid, action, now }),
            log: (level, name, detail) => logDiagnostic(level, name, detail),
          })
          const summary = describeActionOutcome(actionOutcome)
          if (summary) logDiagnostic('info', 'interaction-actions', summary)
        }
        // 带配图时返回结构化结果，worker 会先发文字再发图（各计一次发送）。
        const reply = result.libraryImage ? { reply: result.reply, image: result.libraryImage } : result.reply
        return actionOutcome.done.length || actionOutcome.failed.length
          ? { ...(typeof reply === 'string' ? { reply } : reply), actionOutcome }
          : reply
      },
      sendDmImage: async (event, image) => {
        // 先上传到 B站图床：私信图片消息的 content.url 只接受图床地址，否则返回 21037。
        const bytes = await readLibraryImage(image)
        const uploaded = await uploadImageToBilibili(credential, {
          bytes,
          fileName: image.fileName,
          contentType: imageContentType(image.fileName),
        })
        logDiagnostic('info', 'interaction-image-uploaded', `${uploaded.width}x${uploaded.height}`)
        return sendPrivateImageToTalker(credential, account.mid, event, {
          ...uploaded,
          imageType: imageContentType(image.fileName).replace('image/', ''),
        })
      },
      sendComment: (event, text) => sendCommentReply(credential, event, text),
      sendDm: (event, text) => sendPrivateMessage(credential, account.mid, event, text),
      saveState: (state) => writeInteractionState(INTERACTION_STATE_PATH(), state),
      now,
      getNow: () => new Date(),
      log: (event, detail) => logDiagnostic(event === 'interaction-sent' ? 'info' : event.includes('risk') ? 'fatal' : event.includes('save-failed') ? 'warn' : 'error', event, detail),
    })
    if (expectedGeneration !== interactionGeneration) return
    const persisted = await readInteractionState(INTERACTION_STATE_PATH(), new Date()).catch(() => previous)
    const inboxWarnings = Array.isArray(result.warnings) ? result.warnings.slice(0, 4) : []
    const dmDiagnostics = result.diagnostics || {}
    if (inboxWarnings.length) logDiagnostic('warn', 'interaction-inbox-warning', inboxWarnings.join('; '))
    if (Object.keys(dmDiagnostics).length) logDiagnostic('info', 'interaction-dm-poll', JSON.stringify(dmDiagnostics))
    const sentDm = Array.isArray(result.sentSources) && result.sentSources.includes('dm')
    const sentComments = Array.isArray(result.sentSources) && result.sentSources.includes('comments')
    const sentDescription = sentDm && sentComments ? '私信和评论' : sentDm ? '私信' : '评论'
    const commentReceipt = Array.isArray(result.sentReceipts) ? result.sentReceipts.find((receipt) => receipt.source === 'comments') : null
    const receiptNote = commentReceipt ? ` 回复ID ${commentReceipt.id || '未知'}，状态 ${commentReceipt.state ?? '未知'}。` : ''
    const statusMessage = persisted.pausedReason || result.reason || (inboxWarnings.length ? `收件箱读取异常：${inboxWarnings.join('；')}` : result.baseline ? '已建立监听基线；只处理之后收到的新消息。' : result.sent ? `B站已接受${sentDescription}回复请求 ${result.sent} 条（不代表对方通知已送达）。${receiptNote}` : result.skipped ? `本轮 ${result.skipped} 条互动未发送：${(result.failureReasons || []).slice(0, 2).join('；') || '请检查安全诊断日志。'}` : '监听中，暂无新消息。')
    const interceptNote = dmDiagnostics.interceptedSessions > 0 && !result.sent ? `另有 ${dmDiagnostics.interceptedSessions} 个被 B 站拦截的私信会话；需在 B 站先接受或信任后才能自动回复。` : ''
    interactionStatus = {
      enabled: true,
      paused: Boolean(persisted.pausedReason || result.paused),
      sentToday: persisted.daily.count,
      message: [statusMessage, interceptNote].filter(Boolean).join(' '),
    }
  } catch (error) {
    interactionStatus = { enabled: true, paused: false, sentToday: 0, message: '互动监听检查失败；请查看本机诊断日志。' }
    logDiagnostic('error', 'interaction-poll-failed', errorSummary(error))
  } finally { interactionInFlight = false }
}

function configureInteractionMonitor(settings, generation = interactionGeneration) {
  if (interactionTimer) clearInterval(interactionTimer)
  interactionTimer = null
  const config = normalizeInteractionConfig(settings?.interaction)
  if (!interactionEnabled(config)) {
    interactionStatus = { enabled: false, paused: false, sentToday: 0, message: '互动监听已关闭。' }
    return
  }
  interactionStatus = { enabled: true, paused: false, sentToday: 0, message: '互动监听已开启；正在检查收件箱。' }
  void runInteractionPoll(generation)
  interactionTimer = setInterval(() => void runInteractionPoll(generation), config.intervalMinutes * 60_000)
  interactionTimer.unref?.()
}

function interactionStatusSnapshot() {
  return { ...interactionStatus }
}

function registerIpc() {
  const rendererUrl = pathToFileURL(RENDERER_PATH).href
  const handle = (channel, callback) => ipcMain.handle(channel, async (event, ...args) => {
    if (event.senderFrame?.url !== rendererUrl) throw new Error('拒绝非应用界面的请求。')
    try { return await callback(...args) }
    catch (error) {
      logDiagnostic('error', `ipc:${channel}`, errorSummary(error))
      throw error
    }
  })
  handle('app:data-info', () => dataInfo())
  handle('app:open-data-folder', async () => {
    await fs.mkdir(DATA_LAYOUT.rootDir, { recursive: true })
    const error = await shell.openPath(DATA_LAYOUT.rootDir)
    if (error) throw new Error(error)
    return { ok: true }
  })
  handle('update:status', () => UPDATER.status())
  handle('update:check', () => UPDATER.check())
  handle('update:download', (version) => UPDATER.download({ version: String(version || '') }))
  handle('update:cancel', () => UPDATER.cancel())
  handle('update:discard', () => UPDATER.discard())
  handle('update:apply', async () => {
    const status = await UPDATER.apply()
    // 安装脚本在等本进程退出；这里留一点时间把回执送回界面再退出。
    if (status.phase === 'applying') setTimeout(() => app.quit(), 900)
    return status
  })
  handle('update:open-folder', async () => {
    await fs.mkdir(UPDATER.updateDirectory(), { recursive: true })
    const error = await shell.openPath(UPDATER.updateDirectory())
    if (error) throw new Error(error)
    return { ok: true }
  })
  handle('update:open-releases', async () => {
    await shell.openExternal(RELEASES_PAGE_URL)
    return { ok: true }
  })
  handle('settings:read', async () => {
    const settings = await readSettings()
    return { ...settings, ...modelState(settings) }
  })
  handle('settings:save', async (input) => {
    const settings = await saveSettings(input)
    return { ...settings, ...modelState(settings) }
  })
  handle('prompt:read', () => readPrompts())
  handle('prompt:save-persona', (value) => savePersona(value))
  handle('prompt:save-preferences', (value) => saveContentPreferences(value))
  handle('settings:delete-api-key', (id) => deleteModelApiKey(id))
  handle('model:profile-save', (input) => saveModelProfile(input))
  handle('model:profile-delete', (id) => deleteModelProfile(id))
  handle('model:chain-save', (input) => setModelChain(input))
  handle('interaction:status', () => interactionStatusSnapshot())
  handle('interaction:resume', async () => {
    const state = await readInteractionState(INTERACTION_STATE_PATH())
    state.pausedReason = ''
    await writeInteractionState(INTERACTION_STATE_PATH(), state)
    configureInteractionMonitor(await readSettings())
    return interactionStatusSnapshot()
  })
  handle('model:test', (input) => testModelConnection(input))
  handle('model:list', (input) => listProviderModels(input))
  handle('report:save', (input) => saveReportAndDeliver(input))
  handle('report:list', () => listReports())
  handle('report:read', (name) => readReport(name))
  handle('report:delete', (name) => deleteReport(name))
  handle('report:open-folder', async () => {
    await fs.mkdir(REPORT_DIR(), { recursive: true })
    const error = await shell.openPath(REPORT_DIR())
    if (error) throw new Error(error)
    return { ok: true }
  })
  handle('bili:status', async () => {
    const credential = await readBiliCredential()
    if (!credential) return { loggedIn: false }
    return getAccountStatus(credential)
  })
  handle('bili:login-start', async () => {
    clearActiveQr()
    const login = await beginQrLogin({ qrcode: QRCode })
    activeQrKey = login.key
    activeQrTimer = setTimeout(clearActiveQr, 180_000)
    activeQrTimer.unref?.()
    return { image: login.image, expiresInSeconds: 180 }
  })
  handle('bili:login-poll', async () => {
    if (!activeQrKey) return { state: 'expired' }
    const result = await pollQrLogin(activeQrKey)
    if (result.state === 'ok') {
      await saveBiliCredential(result.credential)
      clearActiveQr()
      return { state: 'ok' }
    }
    if (result.state === 'expired' || result.state === 'error') clearActiveQr()
    return result.state === 'error' ? { state: 'error', message: result.message } : { state: result.state }
  })
  handle('bili:logout', async () => {
    clearActiveQr()
    await fs.rm(BILI_CREDENTIAL_PATH(), { force: true })
    return { loggedIn: false }
  })
  handle('bili:reading-status', () => readingStatus())
  handle('bili:reading-config-save', (value) => saveReadingConfig(value))
  handle('diary:status', () => diaryStatus())
  handle('diary:config-save', (value) => saveDiaryConfig(value))
  handle('diary:list', () => diaryEntries())
  handle('diary:write', () => writeDiaryNow())
  handle('diary:delete-entry', (kind, date) => deleteDiaryEntry(kind, date))
  handle('diary:open-folder', async () => {
    await fs.mkdir(DIARY_DIR(), { recursive: true })
    const error = await shell.openPath(DIARY_DIR())
    if (error) throw new Error(error)
    return { ok: true }
  })
  handle('bili:search', async (keyword, page, sources) => {
    const credential = await readBiliCredential()
    if (!credential) throw new Error('请先扫码登录 B站。')
    const result = await discoverVideos(keyword, credential, { page, sources })
    try {
      const current = await readSettings()
      await writeConfig({ ...current, readingLastRead: normalizeReadingLastRead({ keyword, sources }) })
    } catch (error) {
      logDiagnostic('warn', 'bili-last-read-save-failed', errorSummary(error))
    }
    let history = []
    const retentionDays = await historyRetentionSetting()
    try { history = await readHistory(HISTORY_PATH(), { retentionDays }) }
    catch (error) { logDiagnostic('error', 'analysis-history-read-failed', errorSummary(error)) }
    return { ...result, items: decorateWithHistory(result.items, history, { retentionDays }) }
  })
  handle('bili:analyze', (input) => analyzeSelection(input))
  handle('bili:open-video', async (bvid) => {
    if (!/^BV[0-9A-Za-z]{10}$/.test(String(bvid || ''))) throw new Error('视频编号格式无效。')
    await shell.openExternal(`https://www.bilibili.com/video/${bvid}/`)
    return { ok: true }
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: '#f3f5f7',
    webPreferences: {
      preload: path.join(APP_DIR, 'src', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const rendererPath = path.join(APP_DIR, 'src', 'renderer', 'index.html')
  const rendererUrl = pathToFileURL(rendererPath).href
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, isMainFrame) => {
    if (isMainFrame) logDiagnostic('error', 'renderer-load-failed', `code=${errorCode} ${errorDescription}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    logDiagnostic('error', 'renderer-process-gone', `reason=${details?.reason || 'unknown'} exitCode=${details?.exitCode ?? 'unknown'}`)
  })
  win.webContents.on('will-navigate', (event, target) => {
    if (target !== rendererUrl) event.preventDefault()
  })
  win.loadFile(rendererPath)
}

const PROFILE_RESET_FLAG = '--whaleagent-profile-reset'

// 便携数据目录被复制到另一台电脑/另一个 Windows 用户后，runtime\Local State 里的
// DPAPI 密钥解不开，safeStorage 会整体不可用（连新 Key 都存不进去）。此时把损坏的
// Local State 备份改名并重启一次，让 Electron 为当前用户生成新的密钥；旧密钥文件
// 保留在原处，界面上会提示重新填写。
async function ensureUsableSafeStorage() {
  if (DATA_LAYOUT.mode !== 'portable' && DATA_LAYOUT.mode !== 'custom') return
  if (!DATA_LAYOUT.runtimeDir) return
  if (process.argv.includes(PROFILE_RESET_FLAG)) return
  if (safeStorage.isEncryptionAvailable()) return
  const localState = path.join(DATA_LAYOUT.runtimeDir, 'Local State')
  try { await fs.access(localState) } catch { return }
  try {
    const backup = `${localState}.unusable-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await fs.rename(localState, backup)
    markProfileReset(DATA_LAYOUT, { reason: 'safeStorage unavailable', backup: path.basename(backup) })
    logDiagnostic('warn', 'profile-reset', `backup=${path.basename(backup)}`)
    app.relaunch({ args: [...process.argv.slice(1), PROFILE_RESET_FLAG] })
    app.exit(0)
  } catch (error) {
    logDiagnostic('error', 'profile-reset-failed', errorSummary(error))
  }
}

app.whenReady().then(async () => {
  // 没有拿到单实例锁的进程已经退出，不要再初始化任何东西。
  if (!HAS_SINGLE_INSTANCE) return
  process.on('unhandledRejection', (reason) => logDiagnostic('error', 'unhandled-rejection', errorSummary(reason)))
  process.on('uncaughtException', (error) => {
    logDiagnostic('fatal', 'uncaught-exception', errorSummary(error))
    app.quit()
  })
  // 先确认系统加密可用；必要时重启一次，避免到用户保存 Key 时才发现存不进去。
  await ensureUsableSafeStorage()
  // 先把旧版本的设置/密钥/报告/日记搬进 WhaleagentData，再让界面读设置，
  // 否则窗口会在迁移完成前读到空配置。
  try {
    dataMigration = await migrateLegacyData({
      layout: DATA_LAYOUT,
      legacyUserDataDir: DEFAULT_USER_DATA_DIR,
      legacyDocumentsDir: path.join(DEFAULT_DOCUMENTS_DIR, 'Whaleagent'),
      logger: (level, event, detail) => logDiagnostic(level, event, detail),
    })
    if (dataMigration.failed) logDiagnostic('warn', 'portable-migration-incomplete', `failed=${dataMigration.failed}`)
  } catch (error) {
    logDiagnostic('error', 'portable-migration-failed', errorSummary(error))
  }
  registerIpc()
  createWindow()
  // 恢复上次下载并校验通过、还没安装的更新包：界面启动时就显示「待重启」。
  void UPDATER.restore()
  configureInteractionMonitor(await readSettings())
  void tickReadingAuto()
  readingAutoTimer = setInterval(() => void tickReadingAuto(), 30_000)
  readingAutoTimer.unref?.()
  void (async () => {
    await backfillPushLog()
    await pruneDiaryFiles()
    await tickDiaryAuto()
  })()
  diaryAutoTimer = setInterval(() => void tickDiaryAuto(), 30_000)
  diaryAutoTimer.unref?.()
  logDiagnostic('info', 'app-start', `version=${app.getVersion()} platform=${process.platform} dataMode=${DATA_LAYOUT.mode} dataDir=${DATA_LAYOUT.rootDir}`)
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('before-quit', () => {
  if (interactionTimer) clearInterval(interactionTimer)
  interactionTimer = null
  if (readingAutoTimer) clearInterval(readingAutoTimer)
  readingAutoTimer = null
  if (diaryAutoTimer) clearInterval(diaryAutoTimer)
  diaryAutoTimer = null
  clearActiveQr()
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

