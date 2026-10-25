import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appendDiagnostic, errorSummary, sanitizeDiagnosticText } from '../src/main/diagnostics.js'

test('redacts cookies, API keys, QR keys, subtitle URLs and image data', () => {
  const input = 'SESSDATA=secret-cookie Authorization: Bearer model-secret qrcode_key=qr-secret https://passport.bilibili.com/poll?qrcode_key=qr-secret https://cdn.example/sub?auth_key=subtitle-secret data:image/png;base64,AAAA'
  const output = sanitizeDiagnosticText(input)
  for (const secret of ['secret-cookie', 'model-secret', 'qr-secret', 'subtitle-secret', 'AAAA']) assert.equal(output.includes(secret), false)
  assert.match(output, /QUERY REDACTED/)
})

test('formats errors without including URL query data', () => {
  assert.equal(errorSummary({ name: 'TypeError', message: 'GET https://example.test/path?token=top-secret failed' }), 'TypeError: GET https://example.test/path[QUERY REDACTED] failed')
})

test('never logs a bare "Error" with no usable detail', () => {
  // 日志里曾经的 "comments:Error" 就是这种：message 为空，等于什么都没记。
  const empty = errorSummary(new Error(''))
  assert.doesNotMatch(empty, /^Error: ?$/)
  assert.match(empty, /无错误信息/)

  // 有状态码和错误码时补进摘要，便于定位。
  const withStatus = new Error('')
  withStatus.status = 403
  withStatus.code = 'EACCES'
  assert.match(errorSummary(withStatus), /HTTP 403/)
  assert.match(errorSummary(withStatus), /code=EACCES/)

  // cause 也带上，链式错误不会丢根因。
  const causal = new Error('上传失败', { cause: new Error('socket hang up') })
  assert.match(errorSummary(causal), /上传失败/)
  assert.match(errorSummary(causal), /cause=socket hang up/)

  // 非 Error 值同样有兜底，且敏感串照旧被打码。
  assert.equal(errorSummary('boom'), 'boom')
  assert.match(errorSummary({ status: 401, message: 'Authorization: Bearer leaked-key' }), /QUERY|REDACTED|401/)
})

test('writes bounded JSON lines to the app-local diagnostic file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whaleagent-log-'))
  const file = path.join(dir, 'logs', 'whaleagent.log')
  try {
    await appendDiagnostic(file, 'error', 'ipc:model:test', 'Authorization: Bearer private-key')
    const line = await fs.readFile(file, 'utf8')
    const entry = JSON.parse(line)
    assert.equal(entry.event, 'ipc:model:test')
    assert.doesNotMatch(line, /private-key/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('rotates the diagnostic file before exceeding its size bound', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whaleagent-log-'))
  const file = path.join(dir, 'logs', 'whaleagent.log')
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'x'.repeat(1024 * 1024))
    await appendDiagnostic(file, 'info', 'test-event', 'small')
    assert.equal((await fs.stat(`${file}.1`)).size, 1024 * 1024)
    assert.match(await fs.readFile(file, 'utf8'), /test-event/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
