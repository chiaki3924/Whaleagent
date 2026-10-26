// 软件更新：从 GitHub 本项目的发行版拉取新版，下载并校验后交给 Windows 自带的
// PowerShell 脚本替换程序文件。
//
// 为什么是这套做法（改之前先读）：
// 1. 便携版的数据目录 `WhaleagentData` 就在程序目录里。任何“删掉旧目录再展开新包”的
//    更新方式都会把用户的报告、日记、密钥一起删掉。所以这里只**覆盖**新包里存在的文件，
//    并且把数据目录的绝对路径作为 robocopy 的排除项传进安装脚本；包内若真带了
//    `WhaleagentData` 也会被拒绝安装。
// 2. 不引入 electron-updater / electron-builder：它们要求自己的 latest.yml 发布清单和
//    electron-builder 打包链，而本项目用 @electron/packager 直接产出目录。更新包就是一个
//    目录的 zip，清单是几十行的 JSON，自己维护反而更少依赖、更容易测。
// 3. 解压与替换只用 Windows 自带的 PowerShell 5.1 + robocopy，运行期零新增依赖。
//    检查与下载用调用方注入的 fetch（正式运行传 Electron 的 net.fetch，走系统代理）。
//
// 这个模块不 import electron：单元测试可以在纯 Node 下直接跑。

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { parallelDownload, parseProxyString, probeRemote, sequentialDownload } from './download.js'

export const UPDATE_REPOSITORY = 'chiaki3924/Whaleagent'
export const UPDATE_MANIFEST_NAME = 'whaleagent-update.json'
export const UPDATE_ASSET_NAME = 'Whaleagent-win32-x64.zip'
export const UPDATE_SCHEMA = 1
// 更新相关文件都放在数据目录下：换版本、重装都不会丢，也不会被安装脚本的排除规则挡住。
export const UPDATE_DIR_NAME = 'update'
export const RELEASES_PAGE_URL = `https://github.com/${UPDATE_REPOSITORY}/releases`
export const MANIFEST_URL = `https://github.com/${UPDATE_REPOSITORY}/releases/latest/download/${UPDATE_MANIFEST_NAME}`
export const RELEASES_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=20`
export const RELEASES_LATEST_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`
// 程序目录里必须存在的两个文件：缺任何一个都说明这个包不是 Whaleagent。
export const REQUIRED_PACKAGE_FILES = ['Whaleagent.exe', 'resources/app.asar']
// 安装脚本要等的旧进程上限。Electron 的子进程通常几百毫秒内退完。
const APPLY_WAIT_SECONDS = 45
const MIN_PACKAGE_BYTES = 1024 * 1024
// 断点续传：网络抖动断开后从已写入的位置接着要，最多试这么多次。
const DOWNLOAD_ATTEMPTS = 6
// 超过这个时间没有收到新字节，就把状态标成“停滞”，让界面说实话而不是装作在动。
const STALL_AFTER_MS = 15_000
const SPEED_WINDOW_MS = 6000

export function updateDirectory(dataDir) {
  return path.join(dataDir, UPDATE_DIR_NAME)
}

export function readyMarkerPath(dataDir) {
  return path.join(updateDirectory(dataDir), 'ready.json')
}

export function applyLogPath(dataDir) {
  return path.join(updateDirectory(dataDir), 'apply.log')
}

export function manifestUrlForTag(tag) {
  return `https://github.com/${UPDATE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${UPDATE_MANIFEST_NAME}`
}

// ---- 版本号 ----

// 只接受 0.12.0 / v0.12.0 / 0.12.0-beta.1 这种形式：GitHub 上的 tag 可以随便起，
// 这里宁可解析失败也不猜。
export function parseVersion(value) {
  const text = String(value ?? '').trim().replace(/^v/i, '')
  const match = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-([0-9A-Za-z.-]{1,40}))?$/.exec(text)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || '',
  }
}

export function normalizeVersion(value) {
  const parsed = parseVersion(value)
  if (!parsed) return ''
  return `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease ? `-${parsed.prerelease}` : ''}`
}

// 返回 -1 / 0 / 1。预发布版（0.13.0-beta）小于同号的正式版，这是 semver 的约定。
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  }
  if (a.prerelease === b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  return a.prerelease > b.prerelease ? 1 : -1
}

// ---- 清单 ----

// 清单与程序逐字对齐：仓库名、资产名、校验值任何一项不符都直接拒绝。
// 这些字段是安全边界，不是展示字段——被改过的清单可能把任意 zip 装进程序目录。
export function validateManifest(input, { repository = UPDATE_REPOSITORY } = {}) {
  const data = input && typeof input === 'object' ? input : {}
  const schema = Number(data.schema ?? 0)
  if (schema !== UPDATE_SCHEMA) throw new Error(`更新清单格式不支持（schema=${schema || '缺失'}）。`)
  const manifestRepository = String(data.repository ?? '').trim()
  if (manifestRepository !== repository) throw new Error('更新清单的仓库不匹配。')
  const version = normalizeVersion(data.version)
  if (!version) throw new Error('更新清单的版本号无效。')
  const tag = String(data.tag ?? '').trim() || `v${version}`
  if (!/^[0-9A-Za-z._-]{1,60}$/.test(tag)) throw new Error('更新清单的版本标签无效。')
  const asset = String(data.asset ?? '').trim()
  if (asset !== UPDATE_ASSET_NAME) throw new Error('更新清单的程序包文件名无效。')
  const sha256 = String(data.sha256 ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('更新清单的校验值无效。')
  const size = Number(data.size ?? 0)
  if (!Number.isSafeInteger(size) || size < MIN_PACKAGE_BYTES) throw new Error('更新清单的程序包大小无效。')
  const notes = Array.isArray(data.release_notes)
    ? data.release_notes.map((note) => String(note ?? '').trim()).filter(Boolean).slice(0, 60)
    : []
  return {
    repository: manifestRepository,
    version,
    tag,
    asset,
    sha256,
    size,
    publishedAt: String(data.published_at ?? '').trim().slice(0, 40),
    notes,
    downloadUrl: `https://github.com/${manifestRepository}/releases/download/${encodeURIComponent(tag)}/${asset}`,
    pageUrl: `https://github.com/${manifestRepository}/releases/tag/${encodeURIComponent(tag)}`,
  }
}

// 发行版清单偶尔会漏传（例如 0.13.0 只上传了 zip）。此时用 GitHub API 返回的
// 资产摘要生成等价清单：资产名、大小、sha256:digest 都由 GitHub 提供，与清单里的
// 校验值同等可信。只在清单明确 404 时走这条路；清单存在但格式错误一律直接失败，
// 避免把被篡改或损坏的清单静默绕过去。
export function manifestFromRelease(release) {
  const data = release && typeof release === 'object' ? release : {}
  if (data.draft) throw new Error('最新发行版还是草稿。')
  const tag = String(data.tag_name ?? '').trim()
  const version = normalizeVersion(tag)
  if (!version) throw new Error('最新发行版的版本号无效。')
  if (!/^[0-9A-Za-z._-]{1,60}$/.test(tag)) throw new Error('最新发行版的版本标签无效。')
  const assets = Array.isArray(data.assets) ? data.assets : []
  const asset = assets.find((item) => String(item?.name ?? '') === UPDATE_ASSET_NAME)
  if (!asset) throw new Error(`最新发行版缺少程序包 ${UPDATE_ASSET_NAME}。`)
  const size = Number(asset.size ?? 0)
  if (!Number.isSafeInteger(size) || size < MIN_PACKAGE_BYTES) throw new Error('最新发行版的程序包大小无效。')
  const digest = String(asset.digest ?? '').trim().toLowerCase()
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest)
  if (!match) throw new Error('最新发行版缺少更新清单，且程序包没有可用的 SHA-256 摘要。')
  return {
    repository: UPDATE_REPOSITORY,
    version,
    tag,
    asset: UPDATE_ASSET_NAME,
    sha256: match[1],
    size,
    publishedAt: String(data.published_at ?? '').trim().slice(0, 40),
    notes: String(data.body ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 60),
    downloadUrl: `https://github.com/${UPDATE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${UPDATE_ASSET_NAME}`,
    pageUrl: `https://github.com/${UPDATE_REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`,
  }
}

// zip 条目必须落在解压目录里：绝对路径、盘符和 `..` 一律拒绝。
export function isSafeZipEntry(name) {
  const text = String(name ?? '').replace(/\\/g, '/')
  if (!text || text.length > 500) return false
  if (text.includes('\u0000')) return false
  if (text.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(text)) return false
  if (text.split('/').includes('..')) return false
  return true
}

// GitHub 的 release 列表 → 目标版本下拉用的条目。
// 只有带 Whaleagent-win32-x64.zip 的发行版才标记成可安装；旧版没有清单里的校验值时，
// 仍然允许“回退”，因为回退会按 tag 单独拉取那个版本的清单。
export function normalizeReleaseList(payload, { currentVersion = '' } = {}) {
  const list = Array.isArray(payload) ? payload : []
  const releases = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    if (item.draft) continue
    const version = normalizeVersion(item.tag_name)
    if (!version) continue
    const assets = Array.isArray(item.assets) ? item.assets : []
    const hasAsset = assets.some((asset) => String(asset?.name ?? '') === UPDATE_ASSET_NAME)
    releases.push({
      tag: String(item.tag_name ?? ''),
      version,
      publishedAt: String(item.published_at ?? ''),
      prerelease: Boolean(item.prerelease),
      installable: hasAsset,
      pageUrl: String(item.html_url ?? ''),
      notes: String(item.body ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 40),
    })
    if (releases.length >= 20) break
  }
  releases.sort((a, b) => compareVersions(b.version, a.version))
  return releases.map((release) => ({
    ...release,
    current: currentVersion ? compareVersions(release.version, currentVersion) === 0 : false,
    newer: currentVersion ? compareVersions(release.version, currentVersion) > 0 : false,
  }))
}

// ---- 安装脚本 ----

// 替换文件的 PowerShell 正文。参数由 Node 侧通过命令行传进来，脚本本身不认识任何路径常量，
// 这样同一份脚本在测试里也能指向临时目录。
//
// 关键约束（都有实际教训）：
// - 只覆盖、不删除：程序目录里的 WhaleagentData 绝不能出现在任何 Remove-Item 的路径上，
//   robocopy 一律带 /XD <数据目录绝对路径>。
// - 不用 -WindowStyle Hidden 启动新进程：它会让新版本的主窗口一起隐藏（cat-chat 踩过）。
// - 部署后要等几秒确认新进程没有立刻退出，退出了就回滚到备份。
export const APPLY_UPDATE_SCRIPT = String.raw`
param(
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [Parameter(Mandatory=$true)][string]$Package,
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$DataDir,
  [Parameter(Mandatory=$true)][string]$Version,
  [Parameter(Mandatory=$true)][string]$LogFile,
  [switch]$SkipLaunch
)

$ErrorActionPreference = 'Stop'

$Target    = [System.IO.Path]::GetFullPath($Target).TrimEnd('\')
$DataDir   = [System.IO.Path]::GetFullPath($DataDir).TrimEnd('\')
$UpdateDir = Join-Path $DataDir 'update'
$Staging   = Join-Path $UpdateDir 'staging'
$Backup    = Join-Path $UpdateDir ('backup-' + $Version)
$Exe       = Join-Path $Target 'Whaleagent.exe'
$Result    = 1

New-Item -ItemType Directory -Path $UpdateDir -Force | Out-Null
if (-not (Test-Path -LiteralPath $LogFile)) { Set-Content -LiteralPath $LogFile -Value '' -Encoding UTF8 }

function Write-Log([string]$Message) {
  $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  Add-Content -LiteralPath $LogFile -Value ('[' + $stamp + '] ' + $Message) -Encoding UTF8
}

function Get-AppProcesses {
  $found = @()
  foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
    $file = ''
    try { $file = [string]$process.Path } catch { continue }
    if (-not $file) { continue }
    if ($file.StartsWith($Target + '\', [System.StringComparison]::OrdinalIgnoreCase) -or $file.Equals($Exe, [System.StringComparison]::OrdinalIgnoreCase)) {
      $found += $process
    }
  }
  return $found
}

function Wait-ForAppExit {
  Wait-Process -Id $ProcessId -Timeout ${APPLY_WAIT_SECONDS} -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddSeconds(${APPLY_WAIT_SECONDS})
  while ((Get-Date) -lt $deadline) {
    if (@(Get-AppProcesses).Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 400
  }
  Write-Log '旧进程在等待时间内没有退出，强制结束。'
  foreach ($process in @(Get-AppProcesses)) { try { $process.Kill() } catch {} }
  Start-Sleep -Milliseconds 900
  return (@(Get-AppProcesses).Count -eq 0)
}

function Expand-Package {
  if (Test-Path -LiteralPath $Staging) { Remove-Item -LiteralPath $Staging -Recurse -Force }
  New-Item -ItemType Directory -Path $Staging -Force | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($Package)
  try {
    foreach ($entry in $archive.Entries) {
      if (-not $entry.FullName) { continue }
      $relative = $entry.FullName.Replace('/', '\')
      if ($relative.StartsWith('\') -or $relative -match '^[A-Za-z]:' -or ($relative.Split('\') -contains '..')) {
        throw ('更新包里含不安全的路径：' + $entry.FullName)
      }
      $destination = Join-Path $Staging $relative
      if ($relative.EndsWith('\')) {
        New-Item -ItemType Directory -Path $destination -Force | Out-Null
        continue
      }
      $parent = Split-Path -Parent $destination
      if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
    }
  } finally { $archive.Dispose() }
}

function Invoke-Robocopy([string]$From, [string]$To) {
  $arguments = @($From, $To, '/E', '/XD', $DataDir, '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  # 必须用调用运算符而不是 Start-Process -ArgumentList：
  # 后者会把数组用空格拼成一条命令行、不做转义，路径里只要有空格
  # （例如 "F:\Deepseek Harness工作区\..."）参数就会被拆开，robocopy 直接报
  # "Invalid Parameter #3"。调用运算符会给含空格的参数补上引号。
  & robocopy.exe @arguments 2>&1 | Out-Null
  return $LASTEXITCODE
}

function Restore-Backup {
  if (-not (Test-Path -LiteralPath $Backup)) { return $false }
  Write-Log '开始回滚到更新前的文件。'
  $code = Invoke-Robocopy $Backup $Target
  Write-Log ('回滚 robocopy 退出码 ' + $code)
  return ($code -lt 8)
}

try {
  Write-Log ('准备安装 ' + $Version + '：package=' + $Package + ' target=' + $Target + ' data=' + $DataDir)
  if (-not (Wait-ForAppExit)) { throw '旧进程仍在运行，无法替换程序文件。' }

  Expand-Package
  $source = $Staging
  if (-not (Test-Path -LiteralPath (Join-Path $source 'Whaleagent.exe'))) {
    $children = @(Get-ChildItem -LiteralPath $Staging -Directory -Force)
    if ($children.Count -eq 1) { $source = $children[0].FullName }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $source 'Whaleagent.exe'))) { throw '更新包里没有 Whaleagent.exe。' }
  if (-not (Test-Path -LiteralPath (Join-Path $source 'resources\app.asar'))) { throw '更新包里没有 resources\app.asar。' }
  if (Test-Path -LiteralPath (Join-Path $source 'WhaleagentData')) { throw '更新包里含数据目录 WhaleagentData，已拒绝安装。' }

  if (Test-Path -LiteralPath $Backup) { Remove-Item -LiteralPath $Backup -Recurse -Force }
  foreach ($old in @(Get-ChildItem -LiteralPath $UpdateDir -Directory -Force)) {
    if ($old.Name -like 'backup-*' -and $old.FullName -ne $Backup) {
      try { Remove-Item -LiteralPath $old.FullName -Recurse -Force } catch {}
    }
  }
  New-Item -ItemType Directory -Path $Backup -Force | Out-Null
  $backupCode = Invoke-Robocopy $Target $Backup
  if ($backupCode -ge 8) { throw ('备份旧版本失败，robocopy ' + $backupCode + '。') }
  Write-Log '已备份旧版本。'

  $applyCode = Invoke-Robocopy $source $Target
  if ($applyCode -ge 8) { throw ('覆盖程序文件失败，robocopy ' + $applyCode + '。') }
  Write-Log ('程序文件已更新，robocopy ' + $applyCode + '。')

  if (-not $SkipLaunch) {
    $started = Start-Process -FilePath $Exe -WorkingDirectory $Target -PassThru
    Start-Sleep -Seconds 6
    $started.Refresh()
    if ($started.HasExited) {
      Write-Log ('新版本启动后立即退出（退出码 ' + $started.ExitCode + '），回滚。')
      Restore-Backup | Out-Null
      Start-Process -FilePath $Exe -WorkingDirectory $Target | Out-Null
      throw '新版本启动失败，已回滚到更新前的版本。'
    }
    Write-Log ('新版本已启动，PID ' + $started.Id + '。')
  }

  Remove-Item -LiteralPath $Staging -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Package -Force -ErrorAction SilentlyContinue
  Write-Log '更新完成。'
  $Result = 0
} catch {
  Write-Log ('更新失败：' + $_.Exception.Message)
  try { Restore-Backup | Out-Null } catch {}
  $Result = 1
}

exit $Result
`

// PowerShell 5.1 用系统 ANSI 代码页读取没有 BOM 的 .ps1：中文会变成乱码，引号被拆碎后
// 直接把脚本解析成语法错误（实测报 “Unexpected token”）。落盘时必须带 UTF-8 BOM。
export function applyScriptFileContent() {
  return `\ufeff${APPLY_UPDATE_SCRIPT}`
}

// 把 PowerShell 的调用参数包成 `cmd /c start "" /b powershell.exe ...`。
// start 的第一个带引号参数会被当成窗口标题，所以那个空字符串不能省。
// 路径里可能有空格和中文，逐个加引号；cmd 的引号规则比较原始，这里只做最保守的处理。
export function buildApplyLaunchCommand(args) {
  const quote = (value) => {
    const text = String(value)
    return /[\s&|<>^"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const inner = ['powershell.exe', ...args].map(quote).join(' ')
  // 整条命令是**一个**参数交给 cmd /c，配合 windowsVerbatimArguments 使用：
  // 否则 Node 会再包一层引号，cmd 解析时把含空格的路径截断
  // （实测 -Package 被截成 F:\Deepseek，脚本报“找不到文件”）。
  return [`/c start "" /b ${inner}`]
}

export function buildApplyInvocation({ scriptPath, processId, packagePath, programDir, dataDir, version, logPath }) {
  return [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-ProcessId', String(processId),
    '-Package', packagePath,
    '-Target', programDir,
    '-DataDir', dataDir,
    '-Version', version,
    '-LogFile', logPath,
  ]
}

// ---- 文件 ----

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function fileSize(filePath) {
  try { return (await fsp.stat(filePath)).size } catch { return -1 }
}

async function removeIfExists(filePath) {
  try { await fsp.rm(filePath, { force: true }) } catch {}
}

async function* readBodyChunks(body) {
  if (!body) return
  // Electron 的 net.fetch 给的流不一定有 Symbol.asyncIterator，两种读法都要支持。
  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) yield chunk
    return
  }
  const reader = body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    if (value) yield value
  }
}

// 单条连接的流式读取：从 offset 开始，最多读 length 字节，边读边写进同一个文件句柄。
// 返回本次读到的字节数。断线时抛出，由调用方决定是否续传。
//
// 注意：这里**不做并发分段**。看起来 8 条 Range 连接能把国内直连 GitHub 的 80 KB/s
// 提到 670 KB/s（curl 实测确实如此），但 Electron 走的是 Chromium 网络栈：同一主机的
// 请求会被多路复用到一条 HTTP/2 连接上，实测并发 8 条依然只有 79 KB/s；而强行
// `disable-http2` 之后 GitHub 直接对并发连接返回 429。所以并发在这条链路上是死路，
// 真正能救的是“断点续传”：网络抖动断开后接着下，不用从 0 重来。
async function streamRange({ fetchImpl, url, offset, length, file, onChunk, shouldAbort }) {
  const headers = { Accept: 'application/octet-stream', 'User-Agent': 'whaleagent-updater' }
  // 知道总大小时一律带 Range（包括 offset=0）：这样续传和首次下载走同一条路径，
  // 服务器返回 206 时还能顺带确认字节区间对得上。
  if (length > 0) headers.Range = `bytes=${offset}-${offset + length - 1}`
  const response = await fetchImpl(url, { headers, redirect: 'follow', cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  // 服务器可能忽略 Range 直接回 200：从 0 开始重新吐，不能当成续传。
  const ranged = response.status === 206
  if (offset > 0 && !ranged) throw new Error('range-unsupported')
  let written = 0
  for await (const chunk of readBodyChunks(response.body)) {
    if (shouldAbort()) throw new Error('cancelled')
    const buffer = Buffer.from(chunk)
    const remaining = length > 0 ? length - written : buffer.length
    if (remaining <= 0) break
    const slice = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer
    await file.write(slice, 0, slice.length, offset + written)
    written += slice.length
    onChunk(slice.length)
    if (length > 0 && written >= length) break
  }
  return written
}

// 兜底下载：Node 的 tls 链路不可用时（少见代理形态、TLS 被中间设备拦），
// 退回 Electron 的 net.fetch 单连接顺序下载。慢，但能下完。
async function downloadViaFetch({ fetchImpl, url, filePath, total, noteChunk, shouldAbort }) {
  const file = await fsp.open(filePath, 'w')
  let received = 0
  try {
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
      if (shouldAbort()) throw new Error('cancelled')
      if (total > 0 && received >= total) break
      try {
        await streamRange({
          fetchImpl,
          url,
          offset: received,
          length: total > 0 ? total - received : 0,
          file,
          onChunk: (bytes) => { received += bytes; noteChunk(bytes) },
          shouldAbort,
        })
        if (total > 0 && received < total) {
          await new Promise((resolve) => setTimeout(resolve, 800))
          continue
        }
        break
      } catch (error) {
        const message = String(error?.message || error)
        if (message === 'cancelled' || message === 'range-unsupported') {
          if (message === 'cancelled') throw error
          // 不支持 Range：从头来一次。
          received = 0
          await file.truncate(0)
          continue
        }
        if (attempt === DOWNLOAD_ATTEMPTS) throw error
        await new Promise((resolve) => setTimeout(resolve, 1200 * attempt))
      }
    }
    return { bytes: received }
  } finally {
    try { await file.close() } catch {}
  }
}

// ---- 更新器 ----

const IDLE_PROGRESS = Object.freeze({ received: 0, total: 0 })

export function createUpdater({
  programDir,
  dataDir,
  currentVersion,
  isPackaged = true,
  fetchImpl = globalThis.fetch,
  logger = () => {},
  platform = process.platform,
  spawnImpl = spawn,
  now = () => Date.now(),
  // 并行下载用的系统代理。传一个返回 "PROXY host:port" / "DIRECT" 的函数
  // （正式运行接 Electron 的 session.resolveProxy），null 表示直连。
  proxyResolver = null,
  // 下载实现可注入：默认走 Node tls 的并行分片（见 download.js），
  // 测试里传 null 就只用注入的 fetchImpl，不碰真实网络。
  network = { probeRemote, parallelDownload, sequentialDownload },
} = {}) {
  const directory = updateDirectory(dataDir)
  const state = {
    // idle | checking | available | downloading | ready | applying | error | unsupported
    phase: 'idle',
    error: '',
    currentVersion: normalizeVersion(currentVersion) || String(currentVersion ?? ''),
    latest: null,
    releases: [],
    progress: { ...IDLE_PROGRESS },
    speed: 0,
    lastByteAt: 0,
    ready: null,
    checkedAt: 0,
  }
  let downloadToken = 0
  let cancelRequested = false

  const supported = Boolean(isPackaged) && platform === 'win32'
  if (!supported) {
    state.phase = 'unsupported'
    state.error = isPackaged ? '自动更新只支持 Windows 版本。' : '源码模式不支持一键更新，请在项目目录执行 git pull。'
  }

  function snapshot() {
    // 停滞判定：下载中超过 STALL_AFTER_MS 没有新字节，就把进度状态如实标出来。
    // 慢链路（国内直连 GitHub 常见）下用户看到“速度 0、已停滞”，比看到数字不动更好判断。
    const stalled = state.phase === 'downloading' && state.lastByteAt > 0 && now() - state.lastByteAt > STALL_AFTER_MS
    return {
      supported,
      phase: state.phase,
      error: state.error,
      currentVersion: state.currentVersion,
      latest: state.latest,
      releases: state.releases,
      progress: { ...state.progress },
      speed: state.speed,
      stalled,
      ready: state.ready,
      checkedAt: state.checkedAt,
      updateAvailable: Boolean(state.latest) && compareVersions(state.latest.version, state.currentVersion) > 0,
      dataDir,
      updateDir: directory,
      logPath: applyLogPath(dataDir),
      releasesUrl: RELEASES_PAGE_URL,
    }
  }

  function fail(message) {
    state.phase = 'error'
    state.error = message
    state.progress = { ...IDLE_PROGRESS }
    logger('error', 'update-failed', message)
  }

  async function fetchJson(url) {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'whaleagent-updater' },
      redirect: 'follow',
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }

  async function fetchManifest(url) {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'whaleagent-updater' },
      redirect: 'follow',
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return validateManifest(await response.json())
  }

  // 先走 releases/latest/download 静态直连（不占 GitHub API 配额、不会被限流），
  // 再取发行版列表给“目标版本”下拉用。清单明确 404 时用 API 资产摘要兜底；
  // 清单存在但内容不合法仍然直接失败，不能把损坏或被改过的清单静默绕过去。
  async function check() {
    if (!supported) return snapshot()
    state.phase = 'checking'
    state.error = ''
    try {
      let latest
      let latestRelease = null
      try {
        latest = await fetchManifest(MANIFEST_URL)
      } catch (error) {
        if (String(error?.message) !== 'HTTP 404') throw error
        logger('warn', 'update-manifest-missing', '静态清单 404，改用 GitHub API 资产摘要。')
        try {
          latestRelease = await fetchJson(RELEASES_LATEST_API_URL)
          latest = manifestFromRelease(latestRelease)
        } catch (apiError) {
          throw new Error(`更新清单不可用（HTTP 404），且无法从 GitHub API 读取资产摘要：${String(apiError?.message || apiError).slice(0, 160)}`)
        }
        logger('warn', 'update-manifest-fallback', `version=${latest.version}`)
      }
      try {
        state.releases = normalizeReleaseList(await fetchJson(RELEASES_API_URL), { currentVersion: state.currentVersion })
      } catch (error) {
        logger('warn', 'update-releases-unavailable', String(error?.message || error).slice(0, 200))
        state.releases = latestRelease
          ? normalizeReleaseList([latestRelease], { currentVersion: state.currentVersion })
          : [{
            tag: latest.tag,
            version: latest.version,
            publishedAt: latest.publishedAt,
            prerelease: false,
            installable: true,
            current: compareVersions(latest.version, state.currentVersion) === 0,
            newer: compareVersions(latest.version, state.currentVersion) > 0,
            pageUrl: latest.pageUrl,
            notes: latest.notes,
          }]
      }
      state.latest = latest
      state.checkedAt = now()
      const newer = compareVersions(latest.version, state.currentVersion) > 0
      state.phase = newer ? 'available' : 'idle'
      state.error = newer ? '' : '当前已是最新版本。'
      logger('info', 'update-checked', `current=${state.currentVersion} latest=${latest.version}`)
    } catch (error) {
      state.latest = null
      state.releases = []
      fail(`检查更新失败：${String(error?.message || error).slice(0, 200)}`)
    }
    return snapshot()
  }

  async function readReady() {
    try {
      const raw = JSON.parse(await fsp.readFile(readyMarkerPath(dataDir), 'utf8'))
      if (!raw || typeof raw !== 'object') return null
      const version = normalizeVersion(raw.version)
      const sha256 = String(raw.sha256 ?? '').toLowerCase()
      const file = path.basename(String(raw.file ?? ''))
      if (!version || !/^[0-9a-f]{64}$/.test(sha256) || !file) return null
      const size = await fileSize(path.join(directory, file))
      if (size <= 0) return null
      return {
        version,
        sha256,
        file,
        size,
        notes: Array.isArray(raw.notes) ? raw.notes.map((note) => String(note)).slice(0, 60) : [],
        downloadedAt: String(raw.downloadedAt ?? ''),
      }
    } catch { return null }
  }

  // 启动时恢复「已下载、待重启」：标记和文件都在才算数。
  async function restore() {
    if (!supported) return snapshot()
    const ready = await readReady()
    if (!ready) return snapshot()
    state.ready = ready
    state.phase = 'ready'
    if (!state.latest) {
      state.latest = {
        version: ready.version,
        tag: `v${ready.version}`,
        asset: UPDATE_ASSET_NAME,
        sha256: ready.sha256,
        size: ready.size,
        publishedAt: '',
        notes: ready.notes,
        downloadUrl: '',
        pageUrl: RELEASES_PAGE_URL,
      }
    }
    return snapshot()
  }

  async function discard() {
    await removeIfExists(readyMarkerPath(dataDir))
    state.ready = null
    if (state.phase === 'ready' || state.phase === 'applying') {
      state.phase = state.latest && compareVersions(state.latest.version, state.currentVersion) > 0 ? 'available' : 'idle'
    }
    logger('info', 'update-discarded', '')
    return snapshot()
  }

  function cancel() {
    if (state.phase !== 'downloading') return snapshot()
    cancelRequested = true
    return snapshot()
  }

  // 下载指定版本（默认最新）。选择旧版本时按 tag 单独拉那个版本的清单，
  // 所以“回退到上一个版本”走的是同一条校验路径。
  async function download({ version = '' } = {}) {
    if (!supported) return snapshot()
    if (state.phase === 'downloading') return snapshot()
    let manifest = state.latest
    if (version && (!manifest || manifest.version !== version)) {
      const release = state.releases.find((item) => item.version === version)
      if (!release) { fail('目标版本不存在，请重新检查更新。'); return snapshot() }
      if (!release.installable) { fail('该版本没有可安装的程序包。'); return snapshot() }
      try {
        manifest = await fetchManifest(manifestUrlForTag(release.tag))
      } catch (error) {
        fail(`该版本的更新清单不可用：${String(error?.message || error).slice(0, 160)}`)
        return snapshot()
      }
      state.latest = manifest
    }
    if (!manifest) { fail('请先检查更新。'); return snapshot() }
    if (state.ready && state.ready.version === manifest.version) {
      state.phase = 'ready'
      return snapshot()
    }

    const token = ++downloadToken
    cancelRequested = false
    state.phase = 'downloading'
    state.error = ''
    state.progress = { ...IDLE_PROGRESS }
    state.speed = 0
    state.lastByteAt = 0
    await fsp.mkdir(directory, { recursive: true })
    const finalName = `${UPDATE_ASSET_NAME.replace(/\.zip$/, '')}-${manifest.version}.zip`
    const finalPath = path.join(directory, finalName)
    const partialPath = `${finalPath}.download`
    const shouldAbort = () => cancelRequested || token !== downloadToken
    try {
      await removeIfExists(partialPath)

      // 进度与速度：只用于界面显示，不参与校验。
      let received = 0
      let total = manifest.size
      const samples = [{ at: now(), bytes: 0 }]
      const noteChunk = (bytes) => {
        received += bytes
        const stamp = now()
        state.lastByteAt = stamp
        samples.push({ at: stamp, bytes: received })
        while (samples.length > 2 && stamp - samples[0].at > SPEED_WINDOW_MS) samples.shift()
        const span = stamp - samples[0].at
        state.speed = span > 400 ? Math.round(((received - samples[0].bytes) / span) * 1000) : 0
        state.progress = { received, total }
      }

      // 代理：Windows 上 GitHub 基本必须走系统代理，而 Chromium 的 HTTP/2 多路复用
      // 会把并发连接压成一条，所以真正的下载用 Node 的 tls（见 download.js）。
      let proxy = null
      if (proxyResolver) {
        try { proxy = parseProxyString(await proxyResolver(manifest.downloadUrl)) } catch {}
      }

      let result = null
      try {
        if (!network) throw new Error('no-native-network')
        const probe = await network.probeRemote({ url: manifest.downloadUrl, proxy })
        if (probe.total > 0) total = probe.total
        if (!Number.isSafeInteger(total) || total <= 0) total = manifest.size
        state.progress = { received: 0, total }
        if (probe.ranged) {
          result = await network.parallelDownload({
            url: manifest.downloadUrl,
            filePath: partialPath,
            totalSize: total,
            proxy,
            onProgress: (bytes) => { noteChunk(bytes - received) },
            shouldAbort,
            logger,
          })
        } else {
          logger('warn', 'update-no-range', '服务器不支持断点续传，改为单连接下载。')
          result = await network.sequentialDownload({
            url: manifest.downloadUrl,
            filePath: partialPath,
            proxy,
            onProgress: (bytes) => { noteChunk(bytes - received) },
            shouldAbort,
          })
        }
      } catch (error) {
        if (String(error?.message) === 'cancelled') throw error
        // Node 这条链路失败（代理形态不常见、TLS 被拦等）时退回 Electron 的 net.fetch：
        // 慢，但至少能下完。
        logger('warn', 'download-fallback', String(error?.message || error).slice(0, 160))
        received = 0
        samples.length = 1
        samples[0] = { at: now(), bytes: 0 }
        state.progress = { received: 0, total }
        result = await downloadViaFetch({ fetchImpl, url: manifest.downloadUrl, filePath: partialPath, total, noteChunk, shouldAbort })
      }

      received = result?.bytes ?? received
      state.progress = { received, total: total > 0 ? total : received }
      if (received < MIN_PACKAGE_BYTES) throw new Error('下载的更新包过小，已放弃。')
      if (total > 0 && received !== total) throw new Error(`更新包没有下载完整（${received}/${total} 字节），请重试。`)
      // 整包读一遍算 SHA-256：比边下边算慢一点，但分片/续传下更可靠。
      const digest = await sha256File(partialPath)
      if (digest !== manifest.sha256) throw new Error('更新包校验失败（SHA-256 不匹配），已拒绝安装。')
      await removeIfExists(finalPath)
      await fsp.rename(partialPath, finalPath)
      const ready = {
        version: manifest.version,
        sha256: digest,
        file: finalName,
        size: received,
        notes: manifest.notes,
        downloadedAt: new Date(now()).toISOString(),
      }
      await fsp.writeFile(readyMarkerPath(dataDir), JSON.stringify(ready, null, 2), 'utf8')
      state.ready = ready
      state.phase = 'ready'
      state.error = ''
      state.speed = 0
      state.lastByteAt = 0
      logger('info', 'update-downloaded', `version=${manifest.version} bytes=${received}`)
    } catch (error) {
      await removeIfExists(partialPath)
      await removeIfExists(finalPath)
      await removeIfExists(readyMarkerPath(dataDir))
      state.ready = null
      state.progress = { ...IDLE_PROGRESS }
      state.speed = 0
      state.lastByteAt = 0
      if (String(error?.message) === 'cancelled') {
        state.phase = state.latest && compareVersions(state.latest.version, state.currentVersion) > 0 ? 'available' : 'idle'
        state.error = '已取消下载。'
        logger('info', 'update-cancelled', '')
      } else {
        fail(`下载更新失败：${String(error?.message || error).slice(0, 200)}`)
      }
    }
    return snapshot()
  }

  // 真正替换文件交给独立进程：本进程必须退出，程序目录里的文件才会解锁。
  async function apply() {
    if (!supported) return snapshot()
    const ready = state.ready || (await readReady())
    if (!ready) { fail('没有已下载的更新，请先下载。'); return snapshot() }
    const packagePath = path.join(directory, ready.file)
    state.phase = 'applying'
    state.error = ''
    try {
      const size = await fileSize(packagePath)
      if (size !== ready.size) throw new Error('更新包已被清理或损坏，请重新下载。')
      if ((await sha256File(packagePath)) !== ready.sha256) {
        await discard()
        throw new Error('更新包校验失败，已删除，请重新下载。')
      }
      await fsp.mkdir(directory, { recursive: true })
      const scriptPath = path.join(directory, 'apply-update.ps1')
      await fsp.writeFile(scriptPath, applyScriptFileContent(), 'utf8')
      const args = buildApplyInvocation({
        scriptPath,
        processId: process.pid,
        packagePath,
        programDir,
        dataDir,
        version: ready.version,
        logPath: applyLogPath(dataDir),
      })
      // 启动安装脚本。Windows 上有三个坑，都必须绕开：
      // 1) 直接 spawn('powershell.exe', ..., { detached: true }) —— PowerShell 5.1 收到
      //    DETACHED_PROCESS（没有控制台）后会立刻以 0 退出，什么都不做、连日志都不写。
      //    实测 detached 的各种 stdio 组合全部 190ms 内退出，去掉 detached 才正常。
      // 2) 去掉 detached 之后子进程会跟着父进程一起被结束，等不到本进程退出。
      // 3) 含空格的路径在 cmd 那一层会被拆开，必须配 windowsVerbatimArguments。
      // 所以用 `cmd /c start "" /b powershell.exe ...` 派生：start 会创建独立进程，
      // 既不受 DETACHED_PROCESS 影响，也能在本进程退出后继续跑。
      const child = spawnImpl('cmd.exe', buildApplyLaunchCommand(args), {
        cwd: programDir,
        detached: true,
        windowsVerbatimArguments: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref?.()
      logger('info', 'update-applying', `version=${ready.version} pid=${process.pid}`)
    } catch (error) {
      fail(`安装更新失败：${String(error?.message || error).slice(0, 200)}`)
    }
    return snapshot()
  }

  return {
    supported,
    status: snapshot,
    check,
    download,
    cancel,
    apply,
    discard,
    restore,
    updateDirectory: () => directory,
    readyPackagePath: () => (state.ready ? path.join(directory, state.ready.file) : ''),
  }
}
