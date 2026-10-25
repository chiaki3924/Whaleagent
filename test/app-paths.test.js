import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  DATA_DIR_NAME,
  buildDataLayout,
  ensureDataLayout,
  layoutDirectories,
  markProfileReset,
  migrateLegacyData,
  profileResetBlocked,
  resolveDataLayout,
  seedRuntimeProfile,
} from '../src/main/app-paths.js'

const tempDirs = []
async function makeTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

test.after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

test('builds every portable subdirectory under one root', () => {
  const layout = buildDataLayout(path.join('C:', 'Apps', 'Whaleagent', DATA_DIR_NAME))
  assert.equal(layout.rootDir, path.join('C:', 'Apps', 'Whaleagent', DATA_DIR_NAME))
  assert.equal(layout.configDir, path.join(layout.rootDir, 'config'))
  assert.equal(layout.reportsDir, path.join(layout.rootDir, 'reports'))
  assert.equal(layout.imagesDir, path.join(layout.rootDir, 'images'))
  assert.equal(layout.runtimeDir, path.join(layout.rootDir, 'runtime'))
  assert.deepEqual(layoutDirectories(layout).sort(), [
    layout.configDir, layout.diariesDir, layout.historyDir, layout.imagesDir, layout.logsDir,
    layout.reportsDir, layout.runtimeDir, layout.secretsDir,
  ].sort())
})

test('fallback layout has no runtime dir because Electron keeps its own userData', () => {
  const layout = buildDataLayout('C:\\Users\\me\\AppData\\Roaming\\whaleagent\\WhaleagentData', { runtime: false })
  assert.equal(layout.runtimeDir, '')
  assert.equal(layoutDirectories(layout).includes(''), false)
})

test('prefers a writable data dir set by WHALEAGENT_DATA_DIR', () => {
  const programDir = path.join('C:', 'Apps', 'Whaleagent')
  const layout = resolveDataLayout({
    programDir,
    defaultUserData: path.join('C:', 'Users', 'me', 'AppData', 'Roaming', 'whaleagent'),
    env: { WHALEAGENT_DATA_DIR: 'D:\\WhaleData' },
    writable: () => true,
  })
  assert.equal(layout.mode, 'custom')
  assert.equal(layout.rootDir, 'D:\\WhaleData')
  assert.equal(layout.runtimeDir, path.join('D:\\WhaleData', 'runtime'))
})

test('relative WHALEAGENT_DATA_DIR resolves against the program directory', () => {
  const layout = resolveDataLayout({
    programDir: path.join('C:', 'Apps', 'Whaleagent'),
    defaultUserData: 'C:\\Users\\me\\AppData\\Roaming\\whaleagent',
    env: { WHALEAGENT_DATA_DIR: 'mydata' },
    writable: () => true,
  })
  assert.equal(layout.rootDir, path.join('C:', 'Apps', 'Whaleagent', 'mydata'))
})

test('uses WhaleagentData next to the program when it is writable', () => {
  const programDir = path.join('C:', 'Apps', 'Whaleagent')
  const layout = resolveDataLayout({
    programDir,
    defaultUserData: 'C:\\Users\\me\\AppData\\Roaming\\whaleagent',
    env: {},
    writable: () => true,
  })
  assert.equal(layout.mode, 'portable')
  assert.equal(layout.rootDir, path.join(programDir, DATA_DIR_NAME))
  assert.equal(layout.reason, '')
})

test('falls back to the user data directory when the program directory is read-only', () => {
  const defaultUserData = 'C:\\Users\\me\\AppData\\Roaming\\whaleagent'
  const layout = resolveDataLayout({
    programDir: 'C:\\Program Files\\Whaleagent',
    defaultUserData,
    env: {},
    writable: (dir) => dir.startsWith(defaultUserData),
  })
  assert.equal(layout.mode, 'fallback')
  assert.equal(layout.rootDir, path.join(defaultUserData, DATA_DIR_NAME))
  assert.equal(layout.runtimeDir, '')
  assert.match(layout.reason, /程序目录不可写/)
})

test('ignores an unwritable WHALEAGENT_DATA_DIR and still tries the program directory', () => {
  const programDir = 'C:\\Apps\\Whaleagent'
  const layout = resolveDataLayout({
    programDir,
    defaultUserData: 'C:\\Users\\me\\AppData\\Roaming\\whaleagent',
    env: { WHALEAGENT_DATA_DIR: 'Z:\\readonly' },
    writable: (dir) => !dir.startsWith('Z:'),
  })
  assert.equal(layout.mode, 'portable')
  assert.equal(layout.rootDir, path.join(programDir, DATA_DIR_NAME))
})

test('ensureDataLayout creates every subdirectory', async () => {
  const dir = await makeTempDir('whaleagent-layout-')
  const layout = buildDataLayout(path.join(dir, DATA_DIR_NAME))
  ensureDataLayout(layout)
  for (const directory of layoutDirectories(layout)) {
    const stat = await fs.stat(directory)
    assert.equal(stat.isDirectory(), true)
  }
})

test('seeds the portable runtime with the legacy Chromium Local State exactly once', async () => {
  const root = await makeTempDir('whaleagent-seed-')
  const legacyUserData = path.join(root, 'appdata', 'whaleagent')
  await fs.mkdir(legacyUserData, { recursive: true })
  await fs.writeFile(path.join(legacyUserData, 'Local State'), '{"os_crypt":{"encrypted_key":"old"}}')
  const layout = buildDataLayout(path.join(root, DATA_DIR_NAME))
  assert.equal(seedRuntimeProfile({ runtimeDir: layout.runtimeDir, legacyUserDataDir: legacyUserData }), true)
  assert.equal(await fs.readFile(path.join(layout.runtimeDir, 'Local State'), 'utf8'), '{"os_crypt":{"encrypted_key":"old"}}')
  // 目标已存在时不再覆盖，避免把已经在新位置生成的密钥换掉。
  await fs.writeFile(path.join(layout.runtimeDir, 'Local State'), '{"os_crypt":{"encrypted_key":"new"}}')
  assert.equal(seedRuntimeProfile({ runtimeDir: layout.runtimeDir, legacyUserDataDir: legacyUserData }), false)
  assert.equal(await fs.readFile(path.join(layout.runtimeDir, 'Local State'), 'utf8'), '{"os_crypt":{"encrypted_key":"new"}}')
})

test('seeding is a no-op when there is no legacy profile', async () => {
  const root = await makeTempDir('whaleagent-seed-empty-')
  const layout = buildDataLayout(path.join(root, DATA_DIR_NAME))
  assert.equal(seedRuntimeProfile({ runtimeDir: layout.runtimeDir, legacyUserDataDir: path.join(root, 'missing') }), false)
  assert.equal(seedRuntimeProfile({ runtimeDir: '', legacyUserDataDir: path.join(root, 'missing') }), false)
})

test('a profile-reset marker blocks re-seeding and records why', async () => {
  const root = await makeTempDir('whaleagent-reset-')
  const legacyUserData = path.join(root, 'appdata', 'whaleagent')
  await fs.mkdir(legacyUserData, { recursive: true })
  await fs.writeFile(path.join(legacyUserData, 'Local State'), '{"os_crypt":{"encrypted_key":"old"}}')
  const layout = buildDataLayout(path.join(root, DATA_DIR_NAME))
  ensureDataLayout(layout)
  assert.equal(profileResetBlocked(layout), false)
  assert.equal(markProfileReset(layout, { reason: 'test' }), true)
  assert.equal(profileResetBlocked(layout), true)
  const marker = JSON.parse(await fs.readFile(path.join(layout.configDir, 'profile-reset.json'), 'utf8'))
  assert.equal(marker.reason, 'test')
  assert.match(marker.resetAt, /^\d{4}-\d{2}-\d{2}T/)
  // 即使旧 profile 里还有 Local State，也不再把它复制回来，避免无限重启。
  assert.equal(seedRuntimeProfile({
    runtimeDir: layout.runtimeDir,
    legacyUserDataDir: legacyUserData,
    blocked: profileResetBlocked(layout),
  }), false)
  await assert.rejects(fs.access(path.join(layout.runtimeDir, 'Local State')))
})

async function prepareLegacy(root) {
  const userData = path.join(root, 'appdata', 'whaleagent')
  const documents = path.join(root, 'Documents', 'Whaleagent')
  await fs.mkdir(path.join(userData, 'logs'), { recursive: true })
  await fs.mkdir(path.join(documents, 'reports'), { recursive: true })
  await fs.mkdir(path.join(documents, 'diaries'), { recursive: true })
  await fs.writeFile(path.join(userData, 'settings.json'), '{"models":[]}')
  await fs.writeFile(path.join(userData, 'model-keys.bin'), 'encrypted-keys')
  await fs.writeFile(path.join(userData, 'logs', 'whaleagent.log'), 'old log\n')
  await fs.writeFile(path.join(documents, 'reports', 'Whaleagent-自动-1.md'), '# report')
  await fs.writeFile(path.join(documents, 'reports', 'notes.txt'), 'should not copy')
  await fs.writeFile(path.join(documents, 'diaries', 'diary-public.md'), '## 2026-10-01\nold')
  return { userData, documents }
}

test('migrates legacy settings, keys, log, reports and diaries once', async () => {
  const root = await makeTempDir('whaleagent-migrate-')
  const { userData, documents } = await prepareLegacy(root)
  const layout = { ...buildDataLayout(path.join(root, DATA_DIR_NAME)), mode: 'portable' }
  ensureDataLayout(layout)
  const events = []
  const result = await migrateLegacyData({
    layout,
    legacyUserDataDir: userData,
    legacyDocumentsDir: documents,
    logger: (level, event) => events.push(`${level}:${event}`),
  })
  assert.equal(result.skipped, false)
  assert.equal(result.failed, 0)
  assert.equal(result.copied, 5)
  assert.equal(await fs.readFile(path.join(layout.configDir, 'settings.json'), 'utf8'), '{"models":[]}')
  assert.equal(await fs.readFile(path.join(layout.secretsDir, 'model-keys.bin'), 'utf8'), 'encrypted-keys')
  assert.equal(await fs.readFile(path.join(layout.logsDir, 'whaleagent.log'), 'utf8'), 'old log\n')
  assert.equal(await fs.readFile(path.join(layout.reportsDir, 'Whaleagent-自动-1.md'), 'utf8'), '# report')
  await assert.rejects(fs.access(path.join(layout.reportsDir, 'notes.txt')))
  assert.equal(await fs.readFile(path.join(layout.diariesDir, 'diary-public.md'), 'utf8'), '## 2026-10-01\nold')
  const marker = JSON.parse(await fs.readFile(path.join(layout.configDir, 'portable-migration.json'), 'utf8'))
  assert.equal(marker.copied.length, 5)
  assert.ok(events.includes('info:portable-migration'))

  // 第二次启动：标记已存在，直接跳过，不再扫描旧目录。
  const again = await migrateLegacyData({ layout, legacyUserDataDir: userData, legacyDocumentsDir: documents })
  assert.equal(again.skipped, true)
})

test('migration never overwrites files already present in the portable directory', async () => {
  const root = await makeTempDir('whaleagent-migrate-keep-')
  const { userData, documents } = await prepareLegacy(root)
  const layout = { ...buildDataLayout(path.join(root, DATA_DIR_NAME)), mode: 'portable' }
  ensureDataLayout(layout)
  await fs.writeFile(path.join(layout.configDir, 'settings.json'), '{"models":[{"id":"new"}]}')
  const result = await migrateLegacyData({ layout, legacyUserDataDir: userData, legacyDocumentsDir: documents })
  assert.equal(result.failed, 0)
  assert.equal(await fs.readFile(path.join(layout.configDir, 'settings.json'), 'utf8'), '{"models":[{"id":"new"}]}')
})

test('migration with no legacy data still writes the marker', async () => {
  const root = await makeTempDir('whaleagent-migrate-empty-')
  const layout = { ...buildDataLayout(path.join(root, DATA_DIR_NAME)), mode: 'portable' }
  ensureDataLayout(layout)
  const result = await migrateLegacyData({
    layout,
    legacyUserDataDir: path.join(root, 'missing'),
    legacyDocumentsDir: path.join(root, 'missing-docs'),
  })
  assert.equal(result.skipped, false)
  assert.equal(result.copied, 0)
  assert.equal(result.failed, 0)
  await fs.access(path.join(layout.configDir, 'portable-migration.json'))
})
