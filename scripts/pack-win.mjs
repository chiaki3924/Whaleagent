// 打包入口：**先备份再打包，打包后原样还回去**。
//
// 为什么需要这个包装：electron-packager 的 --overwrite 会把整个输出目录删掉重建，
// 而便携版的真实数据目录 `release\Whaleagent-win32-x64\WhaleagentData` 正好就在里面。
// 直接跑 pack:win 会把用户的设置、密钥、登录态、已回复记录、报告和配图库一起删掉
// （0.9.1 开发时就这样误删过一次）。这里在打包前把它复制到临时目录，打包完再搬回来。
//
// 走 packager 的 JS API 而不是 CLI：--ignore 的正则里有 `^`、`|`、`\` 这些字符，
// 经过 Windows 的 cmd 一层解析会被吃掉（实测报 “'release' is not recognized”）。
//
// 跑法：pnpm run pack:win
import { packager } from '@electron/packager'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = path.join(APP_DIR, 'release')
const APP_OUT = path.join(OUT_DIR, 'Whaleagent-win32-x64')
const DATA_DIR = path.join(APP_OUT, 'WhaleagentData')
const { version } = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'))

// 本机已经下载过 electron 的 zip 时直接用，避免打包时再联网（网络受限时会直接 fetch failed）。
// 注意 packager 的 electronZipDir 要的是**目录**，它会自己在该目录里找 zip。
function findElectronZipDir() {
  const cache = process.env.WHALEAGENT_ELECTRON_ZIP_DIR || path.join(os.tmpdir(), 'whaleagent-electron-cache')
  if (!fs.existsSync(cache)) return ''
  const zip = fs.readdirSync(cache).find((name) => /^electron-v[\d.]+-win32-x64\.zip$/.test(name))
  return zip ? cache : ''
}

function countFiles(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1
  }
  return total
}

const hasData = fs.existsSync(DATA_DIR)
let backupDir = ''
if (hasData) {
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whaleagent-data-backup-'))
  fs.cpSync(DATA_DIR, backupDir, { recursive: true, force: true })
  console.log(`已备份数据目录（${countFiles(backupDir)} 个文件）→ ${backupDir}`)
} else {
  console.log('输出目录里没有 WhaleagentData，无需备份。')
}

let status = 0
try {
  const electronZipDir = findElectronZipDir()
  if (electronZipDir) console.log(`使用本机缓存的 electron 包：${electronZipDir}`)
  const [outputPath] = await packager({
    dir: APP_DIR,
    name: 'Whaleagent',
    platform: 'win32',
    arch: 'x64',
    out: 'release',
    overwrite: true,
    asar: true,
    prune: true,
    executableName: 'Whaleagent',
    appVersion: version,
    ...(electronZipDir ? { electronZipDir } : {}),
    // 不把测试、输出目录本身、便携数据目录和开发期脚本（含它们写出的结果文件）打进 asar。
    ignore: [/^\/(test|release|WhaleagentData|scripts)(\/|$)/, /^\/交接文档\.md$/],
  })
  console.log(`打包完成 → ${outputPath}`)
} catch (error) {
  status = 1
  console.error(`打包失败：${String(error?.message || error).slice(0, 400)}`)
} finally {
  // 无论打包成功与否都要还回去：失败时用户的数据同样不能丢。
  if (hasData) {
    if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true })
    fs.mkdirSync(APP_OUT, { recursive: true })
    fs.cpSync(backupDir, DATA_DIR, { recursive: true, force: true })
    console.log(`已还原数据目录（${countFiles(DATA_DIR)} 个文件）→ ${DATA_DIR}`)
    fs.rmSync(backupDir, { recursive: true, force: true })
  }
}

process.exit(status)
