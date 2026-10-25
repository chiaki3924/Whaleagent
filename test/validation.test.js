import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanBaseUrl, validateModelConnectionSettings, validateReport, validateReportName, normalizeReportMetadata, normalizePreferences, isModelReady } from '../src/main/validation.js'

test('requires a model service API base URL', () => {
  assert.throws(() => cleanBaseUrl(''), /请输入有效的模型服务 API 地址/)
})

test('accepts HTTPS OpenAI-compatible base URL and trims trailing slash', () => {
  assert.equal(cleanBaseUrl(' https://api.example.com/v1/ '), 'https://api.example.com/v1')
})

test('rejects credentials embedded in model service URL', () => {
  assert.throws(() => cleanBaseUrl('https://user:secret@example.com/v1'), /请勿把凭据写入服务地址/)
})

test('rejects non-http schemes', () => {
  assert.throws(() => cleanBaseUrl('file:///etc/passwd'), /必须使用 HTTP 或 HTTPS/)
})

test('requires HTTPS except for loopback development endpoints', () => {
  assert.throws(() => cleanBaseUrl('http://api.example.com/v1'), /必须使用 HTTPS/)
  assert.equal(cleanBaseUrl('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1')
})

test('rejects query strings and fragments in API base URL', () => {
  assert.throws(() => cleanBaseUrl('https://api.example.com/v1?x=1'), /不能包含查询参数或片段/)
  assert.throws(() => cleanBaseUrl('https://api.example.com/v1#other'), /不能包含查询参数或片段/)
})

test('reports the specific missing model connection setting', () => {
  assert.throws(() => validateModelConnectionSettings({ baseUrl: '', hasApiKey: false }), /先填写模型服务 API 地址/)
  assert.throws(() => validateModelConnectionSettings({ baseUrl: 'https://api.example.com/v1', hasApiKey: false }), /先填写并保存 API Key/)
  assert.equal(validateModelConnectionSettings({ baseUrl: ' https://api.example.com/v1/ ', hasApiKey: true }), 'https://api.example.com/v1')
})

test('model readiness also requires a model name', () => {
  assert.equal(isModelReady({ baseUrl: 'https://api.example.com/v1', model: '', hasApiKey: true }), false)
  assert.equal(isModelReady({ baseUrl: 'https://api.example.com/v1', model: 'm', hasApiKey: false }), false)
  assert.equal(isModelReady({ baseUrl: 'https://api.example.com/v1', model: 'm', hasApiKey: true }), true)
})

test('normalizes and bounds local screening preferences', () => {
  assert.equal(normalizePreferences('  喜欢科普  '), '喜欢科普')
  assert.equal(normalizePreferences(''), '')
  assert.throws(() => normalizePreferences('x'.repeat(1201)), /最多 1200 个字符/)
})

test('validates report names as single safe path components', () => {
  assert.equal(validateReportName('每周报告-01'), '每周报告-01')
  for (const name of ['../outside', 'folder\\report', 'bad:name', '.', '..', '']) {
    assert.throws(() => validateReportName(name), /报告名称无效/)
  }
})

test('filters oversized reports and malformed report metadata', () => {
  assert.deepEqual(normalizeReportMetadata({ name: 'ok', size: 10, modifiedAt: '2026-01-01T00:00:00.000Z' }), {
    name: 'ok', size: 10, modifiedAt: '2026-01-01T00:00:00.000Z',
  })
  assert.equal(normalizeReportMetadata({ name: 'large', size: 1024 * 1024 + 1, modifiedAt: new Date() }), null)
  assert.equal(normalizeReportMetadata({ name: 'bad-date', size: 10, modifiedAt: 'invalid' }), null)
  assert.equal(normalizeReportMetadata({ name: '../outside', size: 10, modifiedAt: new Date() }), null)
})

test('validates report path and content size', () => {
  assert.deepEqual(validateReport({ title: 'daily-01', content: '# Report' }), { title: 'daily-01', content: '# Report' })
  assert.throws(() => validateReport({ title: '../secret', content: 'x' }), /名称无效/)
  assert.throws(() => validateReport({ title: 'empty', content: '  ' }), /内容为空/)
  assert.throws(() => validateReport({ title: 'large', content: 'abcd' }, 3), /超过 1 MB/)
})
