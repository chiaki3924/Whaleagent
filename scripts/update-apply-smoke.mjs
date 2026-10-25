// 安装脚本实机验证：在临时目录里造一个假程序目录 + 假数据目录，用真实 zip 跑一遍
// src/main/updater.js 里的 APPLY_UPDATE_SCRIPT（带 -SkipLaunch，不启动假 exe）。
//
// 验证目标只有一个：更新只覆盖程序文件，数据目录一个字节都不能少；包内若混进
// WhaleagentData 必须被拒绝安装。
//
// 跑法：node scripts/update-apply-smoke.mjs
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { APPLY_UPDATE_SCRIPT, applyScriptFileContent } from '../src/main/updater.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPORT = path.join(HERE, 'update-apply-smoke-result.txt')
const lines = []
function step(message) {
  lines.push(String(message))
  try { fs.writeFileSync(REPORT, `${lines.join('\n')}\n`, 'utf8') } catch {}
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

function zipDirectory(sourceDir, zipPath, { includeData = false } = {}) {
  const entries = fs.readdirSync(sourceDir).filter((name) => includeData || name !== 'WhaleagentData')
  const result = spawnSync('tar', ['-a', '-c', '-f', zipPath, ...entries], { cwd: sourceDir, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`打包失败（tar ${result.status}）`)
}

function runApply({ root, zipName, version }) {
  const script = path.join(root, 'apply-update.ps1')
  fs.writeFileSync(script, applyScriptFileContent(), 'utf8')
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-ProcessId', '999999',
    '-Package', path.join(root, 'app', 'WhaleagentData', 'update', zipName),
    '-Target', path.join(root, 'app'),
    '-DataDir', path.join(root, 'app', 'WhaleagentData'),
    '-Version', version,
    '-LogFile', path.join(root, 'app', 'WhaleagentData', 'update', 'apply.log'),
    '-SkipLaunch',
  ]
  return spawnSync('powershell.exe', args, { stdio: 'inherit' })
}

async function buildFixture(root) {
  const appDir = path.join(root, 'app')
  write(path.join(appDir, 'Whaleagent.exe'), 'old-exe')
  write(path.join(appDir, 'resources', 'app.asar'), 'old-asar')
  write(path.join(appDir, 'locales', 'zh-CN.pak'), 'old-locale')
  write(path.join(appDir, 'icudtl.dat'), 'old-icu')
  write(path.join(appDir, 'whaleagent-stale.txt'), 'stale-file-kept')
  // 数据目录：报告、日记、密钥、设置，全部必须原样保留。
  write(path.join(appDir, 'WhaleagentData', 'reports', 'Whaleagent-自动-20261025-120000.md'), '# 报告正文\n')
  write(path.join(appDir, 'WhaleagentData', 'diaries', 'diary-public.md'), '## 2026-10-25\n今天也在读视频。\n')
  write(path.join(appDir, 'WhaleagentData', 'config', 'settings.json'), '{"models":[]}')
  fs.mkdirSync(path.join(appDir, 'WhaleagentData', 'secrets'), { recursive: true })
  fs.writeFileSync(path.join(appDir, 'WhaleagentData', 'secrets', 'model-keys.bin'), crypto.randomBytes(64))

  const packageRoot = path.join(root, 'package')
  write(path.join(packageRoot, 'Whaleagent.exe'), 'new-exe-0.12.0')
  write(path.join(packageRoot, 'resources', 'app.asar'), 'new-asar')
  write(path.join(packageRoot, 'locales', 'zh-CN.pak'), 'new-locale')
  write(path.join(packageRoot, 'icudtl.dat'), 'new-icu')
  write(path.join(packageRoot, 'new-runtime.dll'), 'brand-new-dll')

  const updateDir = path.join(appDir, 'WhaleagentData', 'update')
  fs.mkdirSync(updateDir, { recursive: true })
  const zipPath = path.join(updateDir, 'Whaleagent-win32-x64-0.12.0.zip')
  zipDirectory(packageRoot, zipPath)
  return { appDir, packageRoot, updateDir, zipPath }
}

// 临时目录名故意带空格和中文：真实安装位置就是 "F:\Deepseek Harness工作区\..."，
// 而 Start-Process -ArgumentList 遇到含空格的路径会把参数拆开（robocopy 报 Invalid Parameter #3）。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whaleagent apply 冒烟-'))
step(`临时目录: ${root}`)

let failures = 0
function check(label, condition) {
  step(`  ${condition ? '✔' : '✘'} ${label}`)
  if (!condition) failures += 1
}

// ---- 正常更新 ----
const { appDir, packageRoot, updateDir, zipPath } = await buildFixture(root)
step('\n[1] 正常更新')
const secretBefore = read(path.join(appDir, 'WhaleagentData', 'secrets', 'model-keys.bin'))
const reportBefore = read(path.join(appDir, 'WhaleagentData', 'reports', 'Whaleagent-自动-20261025-120000.md'))
const settingsBefore = read(path.join(appDir, 'WhaleagentData', 'config', 'settings.json'))
const diaryBefore = read(path.join(appDir, 'WhaleagentData', 'diaries', 'diary-public.md'))

const okRun = runApply({ root, zipName: path.basename(zipPath), version: '0.12.0' })
check(`安装脚本退出码 0（实际 ${okRun.status}）`, okRun.status === 0)
check('Whaleagent.exe 已换成新版本', read(path.join(appDir, 'Whaleagent.exe')) === 'new-exe-0.12.0')
check('resources/app.asar 已换成新版本', read(path.join(appDir, 'resources', 'app.asar')) === 'new-asar')
check('新版新增的 dll 已落地', read(path.join(appDir, 'new-runtime.dll')) === 'brand-new-dll')
check('旧版遗留文件没有被删（只覆盖不删除）', read(path.join(appDir, 'whaleagent-stale.txt')) === 'stale-file-kept')
check('数据目录：报告未变', read(path.join(appDir, 'WhaleagentData', 'reports', 'Whaleagent-自动-20261025-120000.md')) === reportBefore)
check('数据目录：日记未变', read(path.join(appDir, 'WhaleagentData', 'diaries', 'diary-public.md')) === diaryBefore)
check('数据目录：设置未变', read(path.join(appDir, 'WhaleagentData', 'config', 'settings.json')) === settingsBefore)
check('数据目录：密钥字节未变', read(path.join(appDir, 'WhaleagentData', 'secrets', 'model-keys.bin')) === secretBefore)
check('旧版本已备份（回滚用）', read(path.join(updateDir, 'backup-0.12.0', 'Whaleagent.exe')) === 'old-exe')
check('staging 已清理', !fs.existsSync(path.join(updateDir, 'staging')))
check('更新包已清理', !fs.existsSync(zipPath))
const log = read(path.join(updateDir, 'apply.log')) || ''
check('安装日志记录了完成', log.includes('更新完成'))
step(`  日志末尾：${log.trim().split(/\r?\n/).slice(-1)[0] || '（空）'}`)

// ---- 包里夹带数据目录：必须拒绝 ----
step('\n[2] 更新包夹带 WhaleagentData 时必须拒绝安装')
const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'whaleagent-apply-bad-'))
const bad = await buildFixture(root2)
write(path.join(bad.packageRoot, 'WhaleagentData', 'config', 'settings.json'), '{"evil":true}')
fs.rmSync(bad.zipPath, { force: true })
zipDirectory(bad.packageRoot, bad.zipPath, { includeData: true })
const exeBefore = read(path.join(bad.appDir, 'Whaleagent.exe'))
const badRun = runApply({ root: root2, zipName: path.basename(bad.zipPath), version: '0.12.0' })
check(`安装脚本拒绝并返回非 0（实际 ${badRun.status}）`, badRun.status !== 0)
check('程序文件未被改动', read(path.join(bad.appDir, 'Whaleagent.exe')) === exeBefore)
const badLog = read(path.join(bad.appDir, 'WhaleagentData', 'update', 'apply.log')) || ''
check('日志说明了拒绝原因', badLog.includes('含数据目录') || badLog.includes('含不安全的路径'))

step(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exitCode = failures === 0 ? 0 : 1
