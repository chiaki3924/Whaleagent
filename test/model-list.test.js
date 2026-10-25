import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchProviderModels } from '../src/main/model-list.js'

test('reads a provider model list over the configured base URL without leaking the key into the URL', async () => {
  let request
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options }
    return new Response(JSON.stringify({
      data: [
        { id: 'z-model', owned_by: 'vendor' },
        { id: 'a-vl-model', architecture: { input_modalities: ['text', 'image'] } },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const result = await fetchProviderModels({ baseUrl: 'https://api.example.com/v1/', apiKey: 'secret-key', fetchImpl })
  assert.equal(request.url, 'https://api.example.com/v1/models')
  assert.equal(request.options.method, 'GET')
  assert.equal(request.options.redirect, 'error')
  assert.equal(request.options.headers.Authorization, 'Bearer secret-key')
  assert.doesNotMatch(request.url, /secret-key/)
  assert.equal(result.count, 2)
  assert.deepEqual(result.models.map((model) => model.id), ['a-vl-model', 'z-model'])
  assert.equal(result.models[0].vision, true)
})

test('requires an API key before calling the provider', async () => {
  let called = false
  await assert.rejects(fetchProviderModels({
    baseUrl: 'https://api.example.com/v1',
    apiKey: '  ',
    fetchImpl: async () => { called = true },
  }), /请先填写 API Key/)
  assert.equal(called, false)
})

test('reports HTTP failures and the missing /models endpoint clearly', async () => {
  await assert.rejects(fetchProviderModels({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    fetchImpl: async () => new Response('nope', { status: 401 }),
  }), /HTTP 401/)
  await assert.rejects(fetchProviderModels({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    fetchImpl: async () => new Response('nope', { status: 404 }),
  }), /没有提供 \/models 接口/)
})

test('rejects invalid or empty model payloads', async () => {
  await assert.rejects(fetchProviderModels({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    fetchImpl: async () => new Response('not json', { status: 200 }),
  }), /不是有效的 JSON/)
  await assert.rejects(fetchProviderModels({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
  }), /没有返回可用模型列表/)
})

test('rejects oversized model lists before parsing', async () => {
  await assert.rejects(fetchProviderModels({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-length': String(2 * 1024 * 1024) } }),
  }), /超过 1 MB 限制/)
})

test('aborts a slow model list request', async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })
  await assert.rejects(fetchProviderModels({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    timeoutMs: 5,
    fetchImpl,
  }), /读取模型列表超时/)
})
