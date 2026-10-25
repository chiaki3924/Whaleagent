// 验证 B站图片上传接口是否可用（开发期自检脚本，不参与打包）。
//
// 跑法（必须用 electron，不能用 node）：
//   electron scripts/upload-check.mjs
// 结果写到 scripts/upload-check-result.txt。
//
// 只上传一张 64x64 测试图，不发任何私信，也不改用户数据（登录态复制到临时目录）。
//
// 三个 Electron 坑，改这个脚本前先看：
// 1. ESM 入口不能用顶层 await 等 app ready，会和 app ready 死锁。
// 2. app.setPath('userData') 必须在 app ready 之前调用，Electron 启动早期就读 Local State，
//    所以复制登录态用同步 fs，放在模块顶层。
// 3. 不能用 fs.cpSync 复制 secrets：它在 Electron 主进程里会触发快速失败崩溃
//    （exit 0xC0000409，什么都不打印），必须逐个文件 copyFileSync。
// 另外 Windows 上 electron.exe 是 GUI 子系统程序，console.log 不会回到管道，所以结果写文件。
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { uploadImageToBilibili } from '../src/main/interaction-bilibili.js'

// 必须用 fileURLToPath：直接读 URL.pathname 会把中文目录留在百分号编码里，
// 后续 fs 操作就会 ENOENT（这个坑也踩过）。
const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SOURCE_DATA = path.join(APP_DIR, 'release', 'Whaleagent-win32-x64', 'WhaleagentData')
const REPORT = path.join(APP_DIR, 'scripts', 'upload-check-result.txt')

const lines = []
function step(message) {
  lines.push(String(message))
  try { fs.writeFileSync(REPORT, `${lines.join('\n')}\n`, 'utf8') } catch {}
}

function crc32(buffer) {
  let c = ~0
  for (const byte of buffer) {
    c ^= byte
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return (~c) >>> 0
}

// 造一张真实可解码的 PNG，确保上传的不是垃圾字节。
function tinyPng(width, height, rgb) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const offset = y * (width * 3 + 1)
    for (let x = 0; x < width; x += 1) {
      raw[offset + 1 + x * 3] = rgb[0]
      raw[offset + 2 + x * 3] = rgb[1]
      raw[offset + 3 + x * 3] = rgb[2]
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- 同步阶段：必须在 app ready 之前完成 ----
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whaleagent-upload-'))
const tempData = path.join(tempRoot, 'WhaleagentData')
fs.mkdirSync(path.join(tempData, 'secrets'), { recursive: true })
fs.mkdirSync(path.join(tempData, 'runtime'), { recursive: true })
for (const name of fs.readdirSync(path.join(SOURCE_DATA, 'secrets'))) {
  fs.copyFileSync(path.join(SOURCE_DATA, 'secrets', name), path.join(tempData, 'secrets', name))
}
fs.copyFileSync(path.join(SOURCE_DATA, 'runtime', 'Local State'), path.join(tempData, 'runtime', 'Local State'))
app.setPath('userData', path.join(tempData, 'runtime'))
step(`临时数据目录: ${tempData}`)

app.whenReady().then(async () => {
  try {
    const encrypted = fs.readFileSync(path.join(tempData, 'secrets', 'bilibili-session.bin'))
    step(`密文字节数: ${encrypted.byteLength}，加密可用: ${safeStorage.isEncryptionAvailable()}`)
    const credential = JSON.parse(safeStorage.decryptString(encrypted))
    step(`登录态可解密: ${Boolean(credential?.sessdata)} 有 csrf: ${Boolean(credential?.bili_jct)}`)

    const pngBytes = tinyPng(64, 64, [80, 160, 220])
    step(`测试图片字节数: ${pngBytes.length}`)

    const uploaded = await uploadImageToBilibili(credential, { bytes: pngBytes, fileName: '测试图.png', contentType: 'image/png' })
    step(`上传结果: ${JSON.stringify(uploaded)}`)

    // 再确认这个地址真能下载回来（说明是有效的图床地址）。
    const check = await fetch(uploaded.url)
    const bytes = (await check.arrayBuffer()).byteLength
    step(`回读 HTTP: ${check.status} Content-Type: ${check.headers.get('content-type')} 字节: ${bytes}`)
  } catch (error) {
    step(`失败: ${String(error?.message || error).slice(0, 400)}`)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    app.quit()
  }
})
