import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  APPLY_UPDATE_SCRIPT,
  MANIFEST_URL,
  RELEASES_LATEST_API_URL,
  UPDATE_ASSET_NAME,
  UPDATE_REPOSITORY,
  applyScriptFileContent,
  buildApplyInvocation,
  buildApplyLaunchCommand,
  compareVersions,
  createUpdater,
  isSafeZipEntry,
  manifestFromRelease,
  manifestUrlForTag,
  normalizeReleaseList,
  normalizeVersion,
  parseVersion,
  readyMarkerPath,
  updateDirectory,
  validateManifest,
} from '../src/main/updater.js'

const PACKAGE_BYTES = 1024 * 1024 + 32
const PACKAGE = Buffer.alloc(PACKAGE_BYTES, 7)
const SHA = crypto.createHash('sha256').update(PACKAGE).digest('hex')

function manifest(overrides = {}) {
  return {
    schema: 1,
    repository: UPDATE_REPOSITORY,
    version: '0.12.0',
    tag: 'v0.12.0',
    asset: UPDATE_ASSET_NAME,
    size: PACKAGE_BYTES,
    sha256: SHA,
    published_at: '2026-10-25T08:00:00Z',
    release_notes: ['新增软件更新页', '更新时保留数据目录'],
    ...overrides,
  }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'whaleagent-update-test-'))
}

test('版本号比较：主次修订与预发布', () => {
  assert.deepEqual(parseVersion('v0.12.0'), { major: 0, minor: 12, patch: 0, prerelease: '' })
  assert.equal(normalizeVersion('V0.12.0'), '0.12.0')
  assert.equal(normalizeVersion('0.12'), '')
  assert.equal(compareVersions('0.12.0', '0.11.0'), 1)
  assert.equal(compareVersions('0.11.0', '0.12.0'), -1)
  assert.equal(compareVersions('v0.12.0', '0.12.0'), 0)
  assert.equal(compareVersions('0.13.0-beta', '0.13.0'), -1)
  assert.equal(compareVersions('0.13.0', '0.13.0-beta'), 1)
  assert.equal(compareVersions('乱写', '0.12.0'), 0)
})

test('清单逐字校验：仓库、资产名、校验值、大小任何一项不符都拒绝', () => {
  const ok = validateManifest(manifest())
  assert.equal(ok.version, '0.12.0')
  assert.equal(ok.downloadUrl, `https://github.com/${UPDATE_REPOSITORY}/releases/download/v0.12.0/${UPDATE_ASSET_NAME}`)
  assert.deepEqual(ok.notes, ['新增软件更新页', '更新时保留数据目录'])

  const rejects = [
    [{ repository: 'someone/else' }, '仓库不匹配'],
    [{ schema: 2 }, '格式不支持'],
    [{ version: 'latest' }, '版本号无效'],
    [{ asset: 'other.zip' }, '文件名无效'],
    [{ sha256: 'abc' }, '校验值无效'],
    [{ size: 10 }, '大小无效'],
    [{ tag: 'v0.12.0 beta' }, '版本标签无效'],
  ]
  for (const [patch, expected] of rejects) {
    assert.throws(() => validateManifest(manifest(patch)), new RegExp(expected), JSON.stringify(patch))
  }
})

test('zip 条目路径必须落在解压目录内', () => {
  assert.equal(isSafeZipEntry('Whaleagent.exe'), true)
  assert.equal(isSafeZipEntry('resources/app.asar'), true)
  assert.equal(isSafeZipEntry('locales\\zh-CN.pak'), true)
  assert.equal(isSafeZipEntry('../evil.exe'), false)
  assert.equal(isSafeZipEntry('resources/../../evil.exe'), false)
  assert.equal(isSafeZipEntry('C:/Windows/system32/evil.dll'), false)
  assert.equal(isSafeZipEntry('/etc/passwd'), false)
  assert.equal(isSafeZipEntry(''), false)
})

test('发行版列表按版本倒序，缺程序包的标成不可安装', () => {
  const releases = normalizeReleaseList([
    { tag_name: 'v0.11.0', draft: false, assets: [{ name: UPDATE_ASSET_NAME }], body: '旧版' },
    { tag_name: 'v0.12.0', draft: false, assets: [{ name: UPDATE_ASSET_NAME }], body: '新版本\n第二行' },
    { tag_name: 'v0.13.0', draft: false, assets: [] },
    { tag_name: 'v0.10.0', draft: true, assets: [{ name: UPDATE_ASSET_NAME }] },
  ], { currentVersion: '0.12.0' })

  assert.deepEqual(releases.map((item) => item.version), ['0.13.0', '0.12.0', '0.11.0'])
  assert.equal(releases[0].installable, false)
  assert.equal(releases[1].current, true)
  assert.equal(releases[2].newer, false)
  assert.deepEqual(releases[1].notes, ['新版本', '第二行'])
})

test('安装脚本只覆盖、不删除程序目录，并把数据目录排除在复制范围外', () => {
  assert.match(APPLY_UPDATE_SCRIPT, /robocopy/)
  assert.match(APPLY_UPDATE_SCRIPT, /'\/XD', \$DataDir/)
  assert.match(APPLY_UPDATE_SCRIPT, /Wait-Process/)
  assert.match(APPLY_UPDATE_SCRIPT, /Restore-Backup/)
  // 唯一允许删除的目录是 staging / backup / 更新包本身，程序目录不能被整体删除。
  const removals = APPLY_UPDATE_SCRIPT.match(/Remove-Item[^\r\n]*/g) || []
  assert.ok(removals.length > 0)
  for (const line of removals) {
    assert.doesNotMatch(line, /-LiteralPath \$Target\b/, line)
    assert.doesNotMatch(line, /-LiteralPath \$DataDir\b/, line)
  }
  // 包里带数据目录必须拒绝安装。
  assert.match(APPLY_UPDATE_SCRIPT, /含数据目录 WhaleagentData/)
  // 不能用 -WindowStyle Hidden 启动新版本，否则主窗口会被一起隐藏。
  assert.doesNotMatch(APPLY_UPDATE_SCRIPT, /WindowStyle Hidden/)
  // robocopy 必须用调用运算符传参：Start-Process -ArgumentList 会按空格拼接、
  // 不给含空格的路径加引号，安装目录一旦带空格就报 "Invalid Parameter #3"。
  assert.doesNotMatch(APPLY_UPDATE_SCRIPT, /Start-Process[^\r\n]*robocopy/)
  assert.match(APPLY_UPDATE_SCRIPT, /& robocopy\.exe @arguments/)
})

test('安装脚本落盘时必须带 UTF-8 BOM，否则 PowerShell 5.1 会把中文读成乱码', () => {
  const content = applyScriptFileContent()
  assert.equal(content[0], '\ufeff')
  assert.ok(content.slice(1).startsWith('\nparam('))
})

test('命令行参数按 PowerShell 参数名逐个传递', () => {
  const args = buildApplyInvocation({
    scriptPath: 'C:\\x\\apply.ps1',
    processId: 4321,
    packagePath: 'C:\\x\\pkg.zip',
    programDir: 'C:\\app',
    dataDir: 'C:\\app\\WhaleagentData',
    version: '0.12.0',
    logPath: 'C:\\app\\WhaleagentData\\update\\apply.log',
  })
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-ExecutionPolicy', 'Bypass'])
  assert.equal(args[args.indexOf('-ProcessId') + 1], '4321')
  assert.equal(args[args.indexOf('-Target') + 1], 'C:\\app')
  assert.equal(args[args.indexOf('-DataDir') + 1], 'C:\\app\\WhaleagentData')
})

function createTestUpdater(options = {}) {
  const root = options.root
  const calls = []
  const spawned = []
  const updater = createUpdater({
    programDir: path.join(root, 'app'),
    dataDir: path.join(root, 'app', 'WhaleagentData'),
    currentVersion: options.currentVersion || '0.11.0',
    isPackaged: options.isPackaged !== false,
    platform: options.platform || 'win32',
    now: () => 1_700_000_000_000,
    spawnImpl: (command, args, spawnOptions) => {
      spawned.push({ command, args, spawnOptions })
      return { unref() {} }
    },
    logger: (level, event, detail) => calls.push({ level, event, detail }),
    fetchImpl: options.fetchImpl,
    // 单元测试不碰真实网络：传 null 让下载只走注入的 fetchImpl。
    network: null,
  })
  return { updater, calls, spawned }
}

test('检查更新：清单可用时报出可用的新版本', async () => {
  const root = await tempDir()
  const { updater } = createTestUpdater({
    root,
    fetchImpl: async (url) => {
      if (url === MANIFEST_URL) return jsonResponse(manifest())
      throw new Error(`unexpected url ${url}`)
    },
  })
  const status = await updater.check()
  assert.equal(status.phase, 'available')
  assert.equal(status.updateAvailable, true)
  assert.equal(status.latest.version, '0.12.0')
  // API 列表拿不到时也要能给出一个可安装的条目，界面不至于空着。
  assert.equal(status.releases.length, 1)
  assert.equal(status.releases[0].installable, true)
})

test('检查更新：已是最新版本时不报可更新', async () => {
  const root = await tempDir()
  const { updater } = createTestUpdater({
    root,
    currentVersion: '0.12.0',
    fetchImpl: async () => jsonResponse(manifest()),
  })
  const status = await updater.check()
  assert.equal(status.phase, 'idle')
  assert.equal(status.updateAvailable, false)
  assert.match(status.error, /最新/)
})

function latestRelease(overrides = {}) {
  return {
    tag_name: 'v0.13.0',
    draft: false,
    prerelease: false,
    published_at: '2026-10-25T12:49:08Z',
    body: 'Whaleagent 0.13.0\n- 开机启动',
    assets: [{ name: UPDATE_ASSET_NAME, size: PACKAGE_BYTES, digest: `sha256:${SHA}` }],
    ...overrides,
  }
}

test('清单缺失时从发行版资产摘要生成清单', () => {
  const manifestFromApi = manifestFromRelease(latestRelease())
  assert.equal(manifestFromApi.version, '0.13.0')
  assert.equal(manifestFromApi.tag, 'v0.13.0')
  assert.equal(manifestFromApi.size, PACKAGE_BYTES)
  assert.equal(manifestFromApi.sha256, SHA)
  assert.equal(manifestFromApi.downloadUrl, `https://github.com/${UPDATE_REPOSITORY}/releases/download/v0.13.0/${UPDATE_ASSET_NAME}`)
  assert.deepEqual(manifestFromApi.notes, ['Whaleagent 0.13.0', '- 开机启动'])

  const rejects = [
    [{ draft: true }, /草稿/],
    [{ tag_name: 'latest' }, /版本号无效/],
    [{ assets: [] }, /缺少程序包/],
    [{ assets: [{ name: UPDATE_ASSET_NAME, size: 10, digest: `sha256:${SHA}` }] }, /大小无效/],
    [{ assets: [{ name: UPDATE_ASSET_NAME, size: PACKAGE_BYTES }] }, /没有可用的 SHA-256/],
    [{ assets: [{ name: UPDATE_ASSET_NAME, size: PACKAGE_BYTES, digest: 'sha256:xyz' }] }, /没有可用的 SHA-256/],
  ]
  for (const [patch, expected] of rejects) {
    assert.throws(() => manifestFromRelease(latestRelease(patch)), expected, JSON.stringify(patch))
  }
})

test('检查更新：静态清单 404 时用 API 资产摘要继续检查', async () => {
  const root = await tempDir()
  const requested = []
  const { updater, calls } = createTestUpdater({
    root,
    currentVersion: '0.12.0',
    fetchImpl: async (url) => {
      requested.push(url)
      if (url === MANIFEST_URL) return new Response('Not Found', { status: 404 })
      if (url === RELEASES_LATEST_API_URL) return jsonResponse(latestRelease())
      throw new Error(`unexpected url ${url}`)
    },
  })
  const status = await updater.check()
  assert.equal(status.phase, 'available')
  assert.equal(status.updateAvailable, true)
  assert.equal(status.latest.version, '0.13.0')
  assert.equal(status.latest.sha256, SHA)
  assert.equal(status.releases.length, 1)
  assert.equal(status.releases[0].installable, true)
  assert.ok(requested.includes(RELEASES_LATEST_API_URL))
  assert.ok(calls.some((entry) => entry.event === 'update-manifest-fallback'))
})

test('检查更新：清单存在但格式错误时直接失败，不静默改用 API', async () => {
  const root = await tempDir()
  let apiCalls = 0
  const { updater } = createTestUpdater({
    root,
    fetchImpl: async (url) => {
      if (url === MANIFEST_URL) return jsonResponse(manifest({ sha256: 'not-a-hash' }))
      apiCalls += 1
      return jsonResponse(latestRelease())
    },
  })
  const status = await updater.check()
  assert.equal(status.phase, 'error')
  assert.match(status.error, /校验值/)
  assert.equal(apiCalls, 0)
})

test('检查更新：清单和 API 都不可用时报出两边原因', async () => {
  const root = await tempDir()
  const { updater } = createTestUpdater({
    root,
    fetchImpl: async (url) => {
      if (url === MANIFEST_URL) return new Response('Not Found', { status: 404 })
      if (url === RELEASES_LATEST_API_URL) return new Response('Forbidden', { status: 403 })
      throw new Error(`unexpected url ${url}`)
    },
  })
  const status = await updater.check()
  assert.equal(status.phase, 'error')
  assert.match(status.error, /HTTP 404/)
  assert.match(status.error, /HTTP 403/)
})

test('检查更新：清单格式错误直接失败，不做降级', async () => {
  const root = await tempDir()
  const { updater } = createTestUpdater({
    root,
    fetchImpl: async (url) => (url === MANIFEST_URL
      ? jsonResponse(manifest({ sha256: 'not-a-hash' }))
      : jsonResponse([])),
  })
  const status = await updater.check()
  assert.equal(status.phase, 'error')
  assert.equal(status.latest, null)
  assert.match(status.error, /校验值/)
})

test('下载：校验通过后写入待安装标记，校验失败则删包', async () => {
  const root = await tempDir()
  let served = PACKAGE
  const { updater } = createTestUpdater({
    root,
    fetchImpl: async (url) => {
      if (url === MANIFEST_URL) return jsonResponse(manifest())
      return new Response(served, { status: 200, headers: { 'content-length': String(served.length) } })
    },
  })
  await updater.check()
  const ready = await updater.download()
  assert.equal(ready.phase, 'ready')
  assert.equal(ready.error, '')
  assert.equal(ready.ready.version, '0.12.0')
  assert.equal(ready.progress.received, PACKAGE_BYTES)
  const packagePath = path.join(updateDirectory(path.join(root, 'app', 'WhaleagentData')), `Whaleagent-win32-x64-0.12.0.zip`)
  assert.equal((await fs.stat(packagePath)).size, PACKAGE_BYTES)
  const marker = JSON.parse(await fs.readFile(readyMarkerPath(path.join(root, 'app', 'WhaleagentData')), 'utf8'))
  assert.equal(marker.sha256, SHA)

  // 换一个被篡改的包，必须拒绝并清理残留。
  served = Buffer.alloc(PACKAGE_BYTES, 9)
  const { updater: second } = createTestUpdater({
    root,
    fetchImpl: async (url) => {
      if (url === MANIFEST_URL) return jsonResponse(manifest())
      return new Response(served, { status: 200, headers: { 'content-length': String(served.length) } })
    },
  })
  await second.check()
  const rejected = await second.download()
  assert.equal(rejected.phase, 'error')
  assert.match(rejected.error, /校验失败/)
  await assert.rejects(fs.stat(packagePath))
  await assert.rejects(fs.stat(`${packagePath}.download`))
})

// 支持 Range 的假服务器：返回 206 + content-range，用来覆盖分段并发下载这条路径。
function rangedResponse(buffer, headers) {
  const range = String(headers?.Range || '')
  const match = /^bytes=(\d+)-(\d+)$/.exec(range)
  if (!match) {
    return new Response(buffer, { status: 200, headers: { 'content-length': String(buffer.length) } })
  }
  const start = Number(match[1])
  const end = Math.min(Number(match[2]), buffer.length - 1)
  const slice = buffer.subarray(start, end + 1)
  return new Response(slice, {
    status: 206,
    headers: {
      'content-length': String(slice.length),
      'content-range': `bytes ${start}-${end}/${buffer.length}`,
    },
  })
}

test('下载：服务器支持 Range 时能断点续传，断开后不从头重来', async () => {
  const root = await tempDir()
  // 4 MB 分两半：第一半故意在读到一半时断开，验证第二次从断点继续。
  const big = Buffer.alloc(4 * 1024 * 1024, 5)
  const bigSha = crypto.createHash('sha256').update(big).digest('hex')
  let rangeRequests = []
  let failOnce = true
  const { updater, calls } = createTestUpdater({
    root,
    fetchImpl: async (url, init) => {
      if (url === MANIFEST_URL) return jsonResponse(manifest({ size: big.length, sha256: bigSha }))
      const headers = init?.headers || {}
      // 只有程序包下载请求才计入；发行版列表请求（无 Range）不算。
      if (!url.endsWith('.zip')) return jsonResponse([])
      rangeRequests.push(String(headers.Range || '(none)'))
      // 第一次正式请求（非探测）只吐 1 MB 就断，模拟网络中断。
      if (failOnce && String(headers.Range || '') !== 'bytes=0-0') {
        failOnce = false
        const start = Number(/bytes=(\d+)-/.exec(headers.Range)[1])
        const partial = big.subarray(start, start + 1024 * 1024)
        return new Response(partial, {
          status: 206,
          headers: { 'content-range': `bytes ${start}-${start + partial.length - 1}/${big.length}` },
        })
      }
      return rangedResponse(big, headers)
    },
  })
  await updater.check()
  const status = await updater.download()
  assert.equal(status.phase, 'ready', status.error)
  assert.equal(status.ready.size, big.length)
  const packagePath = path.join(updateDirectory(path.join(root, 'app', 'WhaleagentData')), 'Whaleagent-win32-x64-0.12.0.zip')
  const onDisk = await fs.readFile(packagePath)
  assert.equal(crypto.createHash('sha256').update(onDisk).digest('hex'), bigSha)
  // 第二次请求必须从 1 MB 处接着要，而不是 bytes=0-。
  assert.ok(rangeRequests.some((range) => range.startsWith('bytes=1048576-')), rangeRequests.join(' | '))
  // 兜底路径（fetch 单连接）里续传成功即算通过；日志事件名随实现走，这里只要求真的续传了。
  assert.equal(onDisk.length, big.length)
})

test('下载：服务器不支持 Range 时退化成一次性顺序下载', async () => {
  const root = await tempDir()
  const { updater } = createTestUpdater({
    root,
    fetchImpl: async (url) => {
      if (url === MANIFEST_URL) return jsonResponse(manifest())
      // 完全不认 Range：一律 200 + 全量。
      return new Response(PACKAGE, { status: 200, headers: { 'content-length': String(PACKAGE_BYTES) } })
    },
  })
  await updater.check()
  const status = await updater.download()
  assert.equal(status.phase, 'ready', status.error)
  assert.equal(status.ready.size, PACKAGE_BYTES)
})

test('下载：可以取消，取消后不留半成品', async () => {
  const root = await tempDir()
  const { updater } = createTestUpdater({
    root,
    fetchImpl: async (url) => {
      if (url === MANIFEST_URL) return jsonResponse(manifest())
      return new Response(PACKAGE, { status: 200 })
    },
  })
  await updater.check()
  // 下载是异步的：先发起，再在第一个数据块到来前取消。
  const pending = updater.download()
  updater.cancel()
  const status = await pending
  assert.ok(['available', 'idle'].includes(status.phase), status.phase)
  await assert.rejects(fs.stat(path.join(updateDirectory(path.join(root, 'app', 'WhaleagentData')), 'Whaleagent-win32-x64-0.12.0.zip')))
})

test('安装：把已校验的包交给独立 PowerShell 进程，不自己替换文件', async () => {
  const root = await tempDir()
  const { updater, spawned } = createTestUpdater({
    root,
    fetchImpl: async (url) => {
      if (url === MANIFEST_URL) return jsonResponse(manifest())
      return new Response(PACKAGE, { status: 200, headers: { 'content-length': String(PACKAGE_BYTES) } })
    },
  })
  await updater.check()
  await updater.download()
  const status = await updater.apply()
  assert.equal(status.phase, 'applying')
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].command, 'cmd.exe')
  // 必须通过 cmd 的 start 派生，而且必须 detached：
  // 直接 detached spawn powershell.exe 会静默退出（DETACHED_PROCESS 没有控制台），
  // 不 detached 又会跟着本进程一起结束。
  assert.equal(spawned[0].spawnOptions.detached, true)
  assert.equal(spawned[0].spawnOptions.windowsHide, true)
  const launch = spawned[0].args
  // 整条命令是单个参数 + windowsVerbatimArguments，否则 Node 会再包一层引号，
  // cmd 解析时把含空格的路径截断。
  assert.equal(launch.length, 1)
  assert.equal(spawned[0].spawnOptions.windowsVerbatimArguments, true)
  assert.match(launch[0], /^\/c start "" \/b powershell\.exe /)
  const command = launch[0]
  assert.ok(command.includes(`-Target ${path.join(root, 'app')}`), command)
  assert.ok(command.includes(`-DataDir ${path.join(root, 'app', 'WhaleagentData')}`), command)
  assert.ok(command.includes(`-Package ${path.join(root, 'app', 'WhaleagentData', 'update', 'Whaleagent-win32-x64-0.12.0.zip')}`), command)
  assert.ok(command.includes(`-ProcessId ${process.pid}`), command)
  assert.ok(command.includes('-Version 0.12.0'), command)
})

test('安装命令：路径含空格或中文时必须逐个加引号，否则 cmd 会把参数拆开', () => {
  const [command] = buildApplyLaunchCommand([
    '-NoProfile',
    '-File', 'F:\\Deepseek Harness工作区\\whaleagent\\WhaleagentData\\update\\apply-update.ps1',
    '-Target', 'F:\\Deepseek Harness工作区\\whaleagent',
  ])
  assert.ok(command.startsWith('/c start "" /b powershell.exe '), command)
  assert.ok(command.includes('"F:\\Deepseek Harness工作区\\whaleagent\\WhaleagentData\\update\\apply-update.ps1"'), command)
  assert.ok(command.includes('"F:\\Deepseek Harness工作区\\whaleagent"'), command)
  // 不含空格的参数不加多余引号（加了 cmd 会把它当窗口标题或字面量）。
  assert.ok(command.includes('-NoProfile '), command)
  // start 的空标题占位不能丢：第一个带引号的参数会被当成窗口标题。
  assert.ok(command.includes('start "" /b'), command)
})

test('安装：没有已下载的包时直接报错', async () => {
  const root = await tempDir()
  const { updater, spawned } = createTestUpdater({ root, fetchImpl: async () => jsonResponse(manifest()) })
  const status = await updater.apply()
  assert.equal(status.phase, 'error')
  assert.match(status.error, /请先下载/)
  assert.equal(spawned.length, 0)
})

test('启动恢复：标记与文件都在才恢复成待重启', async () => {
  const root = await tempDir()
  const dataDir = path.join(root, 'app', 'WhaleagentData')
  await fs.mkdir(updateDirectory(dataDir), { recursive: true })
  await fs.writeFile(path.join(updateDirectory(dataDir), 'Whaleagent-win32-x64-0.12.0.zip'), PACKAGE)
  await fs.writeFile(readyMarkerPath(dataDir), JSON.stringify({
    version: '0.12.0',
    sha256: SHA,
    file: 'Whaleagent-win32-x64-0.12.0.zip',
    size: PACKAGE_BYTES,
    notes: [],
    downloadedAt: '2026-10-25T08:00:00Z',
  }))
  const { updater } = createTestUpdater({ root, fetchImpl: async () => jsonResponse(manifest()) })
  const status = await updater.restore()
  assert.equal(status.phase, 'ready')
  assert.equal(status.ready.version, '0.12.0')

  await fs.rm(path.join(updateDirectory(dataDir), 'Whaleagent-win32-x64-0.12.0.zip'))
  const { updater: second } = createTestUpdater({ root, fetchImpl: async () => jsonResponse(manifest()) })
  assert.equal((await second.restore()).phase, 'idle')
})

test('源码模式不支持安装，也不提供下载', async () => {
  const root = await tempDir()
  const { updater, spawned } = createTestUpdater({ root, isPackaged: false, fetchImpl: async () => jsonResponse(manifest()) })
  assert.equal(updater.supported, false)
  const checked = await updater.check()
  assert.equal(checked.phase, 'unsupported')
  const applied = await updater.apply()
  assert.equal(applied.phase, 'unsupported')
  assert.equal(spawned.length, 0)
})

test('回退：选择旧版本时按 tag 单独拉那个版本的清单', async () => {
  const root = await tempDir()
  const requested = []
  const { updater } = createTestUpdater({
    root,
    fetchImpl: async (url) => {
      requested.push(url)
      if (url === MANIFEST_URL) return jsonResponse(manifest())
      if (url === manifestUrlForTag('v0.10.0')) return jsonResponse(manifest({ version: '0.10.0', tag: 'v0.10.0' }))
      if (url.endsWith('.zip')) return new Response(PACKAGE, { status: 200, headers: { 'content-length': String(PACKAGE_BYTES) } })
      throw new Error(`unexpected ${url}`)
    },
  })
  await updater.check()
  updater.status().releases.push({ version: '0.10.0', tag: 'v0.10.0', installable: true })
  const status = await updater.download({ version: '0.10.0' })
  assert.equal(status.phase, 'ready')
  assert.equal(status.ready.version, '0.10.0')
  assert.ok(requested.includes(manifestUrlForTag('v0.10.0')))
})
