import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SEGMENTS, parseProxyString } from '../src/main/download.js'

async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whaleagent-download-test-'))
  return path.join(dir, 'file.bin')
}

test('解析系统代理字符串：只认 HTTP 代理，其余按直连处理', () => {
  assert.deepEqual(parseProxyString('PROXY 127.0.0.1:7897'), { host: '127.0.0.1', port: 7897 })
  assert.deepEqual(parseProxyString('PROXY 10.0.0.1:8080; DIRECT'), { host: '10.0.0.1', port: 8080 })
  assert.deepEqual(parseProxyString('HTTPS proxy.local:3128'), { host: 'proxy.local', port: 3128 })
  // IPv6 代理地址带方括号。
  assert.deepEqual(parseProxyString('PROXY [::1]:7897'), { host: '::1', port: 7897 })
  // SOCKS 和直连都返回 null：调用方据此走直连 / 退回 net.fetch。
  assert.equal(parseProxyString('SOCKS5 127.0.0.1:1080'), null)
  assert.equal(parseProxyString('DIRECT'), null)
  assert.equal(parseProxyString(''), null)
  assert.equal(parseProxyString('PROXY nonsense'), null)
})

test('分片数量有上限，避免小文件被切成几十段', () => {
  assert.equal(DEFAULT_SEGMENTS, 8)
})

test('并行下载：总大小未知时直接拒绝，不去猜', async () => {
  const { parallelDownload } = await import('../src/main/download.js')
  const target = await tempFile()
  await assert.rejects(
    parallelDownload({ url: 'https://example.com/x', filePath: target, totalSize: 0 }),
    /缺少文件总大小/,
  )
  await assert.rejects(
    parallelDownload({ url: 'https://example.com/x', filePath: target, totalSize: Number.NaN }),
    /缺少文件总大小/,
  )
})
