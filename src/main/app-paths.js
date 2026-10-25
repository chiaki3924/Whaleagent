// 便携版数据目录：所有设置、密钥、报告、日记、历史与日志都放在程序目录下的
// WhaleagentData 文件夹里，整个程序文件夹复制走就能带走数据。
//
// 若程序放在不可写的位置（例如 Program Files、只读光盘），自动退化到
// 用户数据目录下的 WhaleagentData，并在界面上标明当前实际位置。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const DATA_DIR_NAME = 'WhaleagentData'

// 子目录含义：
// - config：程序设置与各种运行状态（settings.json、*-state.json）
// - secrets：API Key 和 B站登录态（safeStorage 加密后的二进制）
// - history：已分析视频记录
// - reports：生成的 Markdown 报告
// - diaries：两本日记的正文
// - logs：运行诊断日志
// - images：私信配图用的图片库（用户自己放图，文件名即含义）
// - runtime：Electron/Chromium 自己的缓存与配置（仅便携模式使用）
export const DATA_SUBDIRS = ['config', 'secrets', 'history', 'reports', 'diaries', 'logs', 'images', 'runtime']

export function buildDataLayout(rootDir, { runtime = true } = {}) {
  return {
    rootDir,
    configDir: path.join(rootDir, 'config'),
    secretsDir: path.join(rootDir, 'secrets'),
    historyDir: path.join(rootDir, 'history'),
    reportsDir: path.join(rootDir, 'reports'),
    diariesDir: path.join(rootDir, 'diaries'),
    logsDir: path.join(rootDir, 'logs'),
    imagesDir: path.join(rootDir, 'images'),
    runtimeDir: runtime ? path.join(rootDir, 'runtime') : '',
  }
}

export function layoutDirectories(layout) {
  return DATA_SUBDIRS.map((name) => `${name}Dir`)
    .map((key) => layout[key])
    .filter(Boolean)
}

// 真写一个探针文件，比只看 fs.access 可靠：Windows 上目录权限、只读属性、
// 被安全软件拦截都能在这里暴露出来。
export function probeWritableDirectory(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true })
    const probe = path.join(directory, `.write-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    fs.writeFileSync(probe, 'ok', { flag: 'wx' })
    fs.rmSync(probe, { force: true })
    return true
  } catch { return false }
}

export function ensureDataLayout(layout) {
  for (const directory of layoutDirectories(layout)) fs.mkdirSync(directory, { recursive: true })
}

// Windows 上 Electron 的 safeStorage 用 Chromium 配置目录里的 Local State 保存
// DPAPI 包装过的密钥。便携版要换一个新的 userData，就必须在 Electron 读取它之前
// 把旧 Local State 复制过去，否则旧的 API Key / B站登录态会解不开。
// 必须在 app.setPath('userData') 之前同步调用。
export function seedRuntimeProfile({ runtimeDir, legacyUserDataDir, blocked = false }) {
  if (blocked || !runtimeDir || !legacyUserDataDir) return false
  const source = path.join(legacyUserDataDir, 'Local State')
  const target = path.join(runtimeDir, 'Local State')
  try {
    fs.mkdirSync(runtimeDir, { recursive: true })
    if (fs.existsSync(target) || !fs.existsSync(source)) return false
    fs.copyFileSync(source, target)
    return true
  } catch { return false }
}

// 把数据目录复制到另一台电脑/另一个 Windows 用户后，runtime\Local State 里的
// DPAPI 密钥解不开，safeStorage 会整体不可用，连新 Key 都存不进去。这种情况下
// 需要把损坏的 Local State 挪走并重启一次，让 Electron 生成新的本机密钥。
// 标记文件用来阻止下一次启动又把它从旧 profile 播回来（否则会无限重启）。
export function profileResetMarkerPath(layout) {
  return path.join(layout.configDir, 'profile-reset.json')
}

export function profileResetBlocked(layout) {
  try { return fs.existsSync(profileResetMarkerPath(layout)) } catch { return false }
}

export function markProfileReset(layout, detail = {}) {
  try {
    fs.mkdirSync(layout.configDir, { recursive: true })
    fs.writeFileSync(profileResetMarkerPath(layout), JSON.stringify({
      resetAt: new Date().toISOString(),
      ...detail,
    }, null, 2), 'utf8')
    return true
  } catch { return false }
}

// 优先级：环境变量指定目录 → 程序目录/WhaleagentData → 用户数据目录/WhaleagentData。
// 只有前两种会接管 Electron 的 userData（把 Chromium 缓存也关进便携目录）；
// 退化模式继续使用系统默认 userData，避免把缓存混进业务数据。
export function resolveDataLayout({ programDir, defaultUserData, env = {}, writable = probeWritableDirectory }) {
  const custom = String(env?.WHALEAGENT_DATA_DIR || '').trim()
  if (custom) {
    const rootDir = path.resolve(programDir, custom)
    if (writable(rootDir)) {
      return { ...buildDataLayout(rootDir), mode: 'custom', reason: '数据目录由环境变量 WHALEAGENT_DATA_DIR 指定。' }
    }
  }
  const portableRoot = path.join(programDir, DATA_DIR_NAME)
  if (writable(portableRoot)) {
    return { ...buildDataLayout(portableRoot), mode: 'portable', reason: '' }
  }
  const fallbackRoot = path.join(defaultUserData, DATA_DIR_NAME)
  writable(fallbackRoot)
  return {
    ...buildDataLayout(fallbackRoot, { runtime: false }),
    mode: 'fallback',
    reason: `程序目录不可写（${portableRoot}），已改用用户数据目录保存。`,
  }
}

// 把旧版本留在 %APPDATA%\whaleagent 和「文档\Whaleagent」里的数据复制到便携目录。
// 只复制、不移动、不覆盖：旧文件留着当备份；新目录已有同名文件时以新文件为准。
function legacyFileMappings() {
  return [
    ['settings.json', 'configDir'],
    ['model-key.bin', 'secretsDir'],
    ['model-keys.bin', 'secretsDir'],
    ['bilibili-session.bin', 'secretsDir'],
    ['analyzed-videos.json', 'historyDir'],
    ['interaction-state.json', 'configDir'],
    ['reading-state.json', 'configDir'],
    ['report-dm-state.json', 'configDir'],
    ['diary-state.json', 'configDir'],
    [path.join('logs', 'whaleagent.log'), 'logsDir'],
  ]
}

function legacyFolderMappings() {
  return [
    ['reports', 'reportsDir'],
    ['diaries', 'diariesDir'],
  ]
}

function createCollector() {
  return { copied: [], skipped: [], failed: [] }
}

async function copyIfMissing(source, target, collector) {
  try {
    await fsp.access(target)
    collector.skipped.push(target)
    return
  } catch { /* 目标不存在，继续复制 */ }
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL)
    collector.copied.push(target)
  } catch (error) {
    // 旧文件本来就不存在是最常见的情况，不算失败。
    if (error.code === 'ENOENT' || error.code === 'EEXIST') return
    collector.failed.push({ path: target, message: error.message })
  }
}

async function copyLegacyFolder(sourceDir, targetDir, collector) {
  let entries
  try {
    entries = await fsp.readdir(sourceDir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return
    collector.failed.push({ path: sourceDir, message: error.message })
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    await copyIfMissing(path.join(sourceDir, entry.name), path.join(targetDir, entry.name), collector)
  }
}

function relativeToRoot(layout, filePath) {
  const relative = path.relative(layout.rootDir, filePath)
  return relative && !relative.startsWith('..') ? relative : filePath
}

// 迁移只跑一次：成功后写 config/portable-migration.json。失败（权限、占用）不写标记，
// 下次启动会重试；已复制过的文件按“目标已存在”跳过，不会重复复制或覆盖。
export async function migrateLegacyData({
  layout,
  legacyUserDataDir,
  legacyDocumentsDir,
  markerPath = path.join(layout.configDir, 'portable-migration.json'),
  logger = () => {},
}) {
  try {
    await fsp.access(markerPath)
    return { skipped: true, copied: 0, failed: 0, copiedFiles: [], failedFiles: [] }
  } catch { /* 尚未迁移过 */ }
  const collector = createCollector()
  for (const [name, dirKey] of legacyFileMappings()) {
    if (!legacyUserDataDir) continue
    await copyIfMissing(path.join(legacyUserDataDir, name), path.join(layout[dirKey], path.basename(name)), collector)
  }
  // Local State 通常在 app.setPath 之前已被 seedRuntimeProfile 复制；这里兜底补一次，
  // 保证配置文件和数据一起走时，加密密钥也有机会跟着走。
  if (layout.runtimeDir && legacyUserDataDir) {
    await copyIfMissing(path.join(legacyUserDataDir, 'Local State'), path.join(layout.runtimeDir, 'Local State'), collector)
  }
  for (const [folder, dirKey] of legacyFolderMappings()) {
    if (!legacyDocumentsDir) continue
    await copyLegacyFolder(path.join(legacyDocumentsDir, folder), layout[dirKey], collector)
  }
  const summary = {
    version: 1,
    migratedAt: new Date().toISOString(),
    mode: layout.mode,
    sourceUserData: legacyUserDataDir || '',
    sourceDocuments: legacyDocumentsDir || '',
    copied: collector.copied.map((filePath) => relativeToRoot(layout, filePath)),
    skipped: collector.skipped.map((filePath) => relativeToRoot(layout, filePath)),
    failed: collector.failed,
  }
  if (collector.failed.length === 0) {
    try {
      await fsp.mkdir(path.dirname(markerPath), { recursive: true })
      await fsp.writeFile(markerPath, JSON.stringify(summary, null, 2), 'utf8')
    } catch (error) {
      logger('warn', 'portable-migration-marker-failed', error.message)
    }
  }
  if (collector.copied.length || collector.failed.length) {
    logger('info', 'portable-migration', `copied=${collector.copied.length} skipped=${collector.skipped.length} failed=${collector.failed.length}`)
  }
  return {
    skipped: false,
    copied: collector.copied.length,
    failed: collector.failed.length,
    copiedFiles: summary.copied,
    failedFiles: collector.failed.map((item) => relativeToRoot(layout, item.path)),
  }
}
