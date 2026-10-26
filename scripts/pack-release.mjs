// 发行打包：产出更新包 + 更新清单，可选直接发到 GitHub Release。
//
// 产出（都在 release/ 下）：
//   Whaleagent-win32-x64.zip         程序目录打包，**不含 WhaleagentData**
//   whaleagent-update.json           更新清单（版本、大小、SHA-256、更新说明）
//
// 用法：
//   node scripts/pack-release.mjs                  # 只本地出包
//   node scripts/pack-release.mjs --skip-pack      # 复用已有的 release/Whaleagent-win32-x64
//   node scripts/pack-release.mjs --publish --notes-file release-notes.md
//
// 发布需要环境变量 GH_TOKEN（或 GITHUB_TOKEN）。token 只在本次进程内使用，不写进任何文件。
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { UPDATE_ASSET_NAME, UPDATE_MANIFEST_NAME, UPDATE_REPOSITORY, UPDATE_SCHEMA } from '../src/main/updater.js'

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const RELEASE_DIR = path.join(APP_DIR, 'release')
const APP_OUT = path.join(RELEASE_DIR, 'Whaleagent-win32-x64')
const DATA_DIR_NAME = 'WhaleagentData'

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : true
}

const version = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version
const tag = `v${version}`

function log(message) { console.log(message) }

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

// 复制一份不含数据目录的 staging：绝不能让本机的 WhaleagentData 进更新包。
async function buildStaging() {
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'whaleagent-release-'))
  for (const entry of await fsp.readdir(APP_OUT, { withFileTypes: true })) {
    if (entry.name === DATA_DIR_NAME) continue
    await fsp.cp(path.join(APP_OUT, entry.name), path.join(staging, entry.name), { recursive: true, force: true })
  }
  const names = (await fsp.readdir(staging)).sort()
  if (!names.includes('Whaleagent.exe')) throw new Error('staging 里没有 Whaleagent.exe，先跑 pnpm run pack:win。')
  if (!fs.existsSync(path.join(staging, 'resources', 'app.asar'))) throw new Error('staging 里没有 resources/app.asar。')
  if (names.includes(DATA_DIR_NAME)) throw new Error('staging 里混进了 WhaleagentData，拒绝出包。')
  return { staging, names }
}

// 用 Windows 自带的 tar（bsdtar）打 zip，不引入 archiver 之类的依赖。
// 只传顶层条目，包内路径就是 Whaleagent.exe 这种相对路径，解压脚本好处理。
function buildZip(staging, names, zipPath) {
  fs.rmSync(zipPath, { force: true })
  const result = spawnSync('tar', ['-a', '-c', '-f', zipPath, ...names], { cwd: staging, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`打包 zip 失败（tar ${result.status}）`)
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'whaleagent-release',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`GitHub API ${response.status}：${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : {}
}

async function uploadAsset(token, uploadUrl, filePath, name) {
  const url = `${uploadUrl.replace(/\{.*$/, '')}?name=${encodeURIComponent(name)}`
  const size = (await fsp.stat(filePath)).size
  log(`  上传 ${name}（${(size / 1024 / 1024).toFixed(1)} MB）…`)
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'whaleagent-release',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
    },
    body: fs.createReadStream(filePath),
    duplex: 'half',
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`上传 ${name} 失败：HTTP ${response.status} ${text.slice(0, 300)}`)
  log(`  已上传 ${name}`)
  return JSON.parse(text)
}

async function publish({ zipPath, manifestPath, sha256, notes }) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) throw new Error('缺少 GH_TOKEN 环境变量；也可以不带 --publish，手动在网页上传两个文件。')
  const existing = await fetchJson(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/tags/${tag}`, {
    headers: { Authorization: `token ${token}` },
  }).catch(() => null)

  let release = existing
  if (release) {
    log(`发行版 ${tag} 已存在，沿用并替换同名资产。`)
  } else {
    log(`创建发行版 ${tag}…`)
    release = await fetchJson(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases`, {
      method: 'POST',
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        name: version,
        body: notes,
        draft: false,
        prerelease: false,
        target_commitish: 'main',
      }),
    })
  }

  // GitHub 不允许同名资产重复上传：先删掉旧的同名文件。
  for (const asset of release.assets || []) {
    if (asset.name === UPDATE_ASSET_NAME || asset.name === UPDATE_MANIFEST_NAME) {
      log(`  删除旧资产 ${asset.name}`)
      await fetchJson(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/assets/${asset.id}`, {
        method: 'DELETE',
        headers: { Authorization: `token ${token}` },
      })
    }
  }

  await uploadAsset(token, release.upload_url, zipPath, UPDATE_ASSET_NAME)
  // 清单最后上传：先有大包再有小清单，正在检查更新的客户端不会拿到指向半成品的地址。
  await uploadAsset(token, release.upload_url, manifestPath, UPDATE_MANIFEST_NAME)

  // 上传接口返回成功不代表发行版里两个资产都齐：0.13.0 就出现过只有 zip、
  // 客户端检查更新一直 404 的情况。发布后按发行版实际状态再核对一遍。
  const published = await fetchJson(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/tags/${tag}`, {
    headers: { Authorization: `token ${token}` },
  })
  const assets = Array.isArray(published.assets) ? published.assets : []
  const expected = [
    { name: UPDATE_ASSET_NAME, filePath: zipPath, sha256 },
    { name: UPDATE_MANIFEST_NAME, filePath: manifestPath, sha256: '' },
  ]
  for (const item of expected) {
    const asset = assets.find((entry) => entry.name === item.name)
    if (!asset) throw new Error(`发布后自检失败：发行版 ${tag} 里没有 ${item.name}。`)
    const size = (await fsp.stat(item.filePath)).size
    if (Number(asset.size) !== size) throw new Error(`发布后自检失败：${item.name} 大小不一致（${asset.size} ≠ ${size}）。`)
    if (item.sha256 && asset.digest && asset.digest !== `sha256:${item.sha256}`) {
      throw new Error(`发布后自检失败：${item.name} 摘要不一致。`)
    }
    log(`  自检通过 ${item.name}`)
  }
  return release.html_url
}

const skipPack = arg('skip-pack', false) === true
if (!skipPack) {
  log('先打程序目录（pnpm run pack:win）…')
  const pack = spawnSync(process.execPath, [path.join(APP_DIR, 'scripts', 'pack-win.mjs')], { cwd: APP_DIR, stdio: 'inherit' })
  if (pack.status !== 0) process.exit(pack.status ?? 1)
}
if (!fs.existsSync(APP_OUT)) throw new Error('没有 release/Whaleagent-win32-x64，先跑 pnpm run pack:win。')

const notesFile = String(arg('notes-file', '') || '')
const notesArg = arg('notes', '')
const notes = notesFile && fs.existsSync(path.resolve(APP_DIR, notesFile))
  ? fs.readFileSync(path.resolve(APP_DIR, notesFile), 'utf8').trim()
  : typeof notesArg === 'string' && notesArg
    ? notesArg
    : `Whaleagent ${version}`

await fsp.mkdir(RELEASE_DIR, { recursive: true })
const { staging, names } = await buildStaging()
const zipPath = path.join(RELEASE_DIR, UPDATE_ASSET_NAME)
const manifestPath = path.join(RELEASE_DIR, UPDATE_MANIFEST_NAME)
try {
  log(`打包 ${names.length} 个顶层条目…`)
  buildZip(staging, names, zipPath)
  const size = (await fsp.stat(zipPath)).size
  const sha256 = await hashFile(zipPath)
  const manifest = {
    schema: UPDATE_SCHEMA,
    repository: UPDATE_REPOSITORY,
    version,
    tag,
    asset: UPDATE_ASSET_NAME,
    size,
    sha256,
    published_at: new Date().toISOString(),
    release_notes: notes.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  }
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await fsp.writeFile(`${zipPath}.sha256`, `${sha256}  ${UPDATE_ASSET_NAME}\n`, 'utf8')
  log(`更新包 ${(size / 1024 / 1024).toFixed(1)} MB → ${zipPath}`)
  log(`SHA-256 ${sha256}`)
  log(`更新清单 → ${manifestPath}`)

  if (arg('publish', false) === true) {
    const htmlUrl = await publish({ zipPath, manifestPath, sha256, notes })
    log(`已发布：${htmlUrl}`)
  } else {
    log('未发布（加 --publish 并设置 GH_TOKEN 可直接上传）。')
  }
} finally {
  await fsp.rm(staging, { recursive: true, force: true })
}
