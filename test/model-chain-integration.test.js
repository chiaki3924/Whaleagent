// 端到端验证“首选请求失败后自动改用备用模型”：两个本地 HTTP 服务，真实 fetch。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { generateInteractionReply } from '../src/main/model.js'
import { runModelChain } from '../src/main/model-chain.js'

const EVENT = { source: 'comments', kind: 'reply', senderName: '测试用户', text: '这个视频讲得真清楚' }

function startServer(handler) {
  const server = http.createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function replyPayload(reply) {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ reply }) } }] })
}

async function withServers(primaryHandler, fallbackHandler, run) {
  const primary = await startServer(primaryHandler)
  const fallback = await startServer(fallbackHandler)
  try {
    return await run({
      primaryUrl: `http://127.0.0.1:${primary.port}/v1`,
      fallbackUrl: `http://127.0.0.1:${fallback.port}/v1`,
    })
  } finally {
    await new Promise((resolve) => primary.server.close(resolve))
    await new Promise((resolve) => fallback.server.close(resolve))
  }
}

test('首选返回 HTTP 500 时自动改用备用模型并给出备用模型的回复', async () => {
  const seen = []
  await withServers(
    (request, response) => { seen.push('primary'); response.writeHead(500).end('{}') },
    (request, response) => { seen.push('fallback'); response.writeHead(200, { 'Content-Type': 'application/json' }).end(replyPayload('备用模型的回复')) },
    async ({ primaryUrl, fallbackUrl }) => {
      const { result, profile, fallbackUsed, attempts } = await runModelChain({
        chain: [
          { id: 'a', providerName: '主', baseUrl: primaryUrl, model: 'primary', apiKey: 'key-a' },
          { id: 'b', providerName: '备', baseUrl: fallbackUrl, model: 'fallback', apiKey: 'key-b' },
        ],
        run: (entry) => generateInteractionReply({
          baseUrl: entry.baseUrl,
          model: entry.model,
          apiKey: entry.apiKey,
          event: EVENT,
        }),
      })
      assert.equal(result, '备用模型的回复')
      assert.equal(profile.id, 'b')
      assert.equal(fallbackUsed, true)
      assert.equal(attempts.length, 1)
      assert.match(attempts[0].message, /HTTP 500/)
      assert.deepEqual(seen, ['primary', 'fallback'])
    },
  )
})

test('首选成功时备用服务完全不会被访问', async () => {
  const seen = []
  await withServers(
    (request, response) => { seen.push('primary'); response.writeHead(200, { 'Content-Type': 'application/json' }).end(replyPayload('首选的回复')) },
    (request, response) => { seen.push('fallback'); response.writeHead(200, { 'Content-Type': 'application/json' }).end(replyPayload('不该用到')) },
    async ({ primaryUrl, fallbackUrl }) => {
      const { result, fallbackUsed } = await runModelChain({
        chain: [
          { id: 'a', baseUrl: primaryUrl, model: 'primary', apiKey: 'key-a' },
          { id: 'b', baseUrl: fallbackUrl, model: 'fallback', apiKey: 'key-b' },
        ],
        run: (entry) => generateInteractionReply({ baseUrl: entry.baseUrl, model: entry.model, apiKey: entry.apiKey, event: EVENT }),
      })
      assert.equal(result, '首选的回复')
      assert.equal(fallbackUsed, false)
      assert.deepEqual(seen, ['primary'])
    },
  )
})

test('两个服务都失败时错误里同时包含两段原因', async () => {
  await withServers(
    (request, response) => { response.writeHead(401).end('{}') },
    (request, response) => { response.writeHead(503).end('{}') },
    async ({ primaryUrl, fallbackUrl }) => {
      await assert.rejects(
        () => runModelChain({
          chain: [
            { id: 'a', providerName: '主', baseUrl: primaryUrl, model: 'primary', apiKey: 'key-a' },
            { id: 'b', providerName: '备', baseUrl: fallbackUrl, model: 'fallback', apiKey: 'key-b' },
          ],
          run: (entry) => generateInteractionReply({ baseUrl: entry.baseUrl, model: entry.model, apiKey: entry.apiKey, event: EVENT }),
        }),
        (error) => {
          assert.match(error.message, /HTTP 401/)
          assert.match(error.message, /HTTP 503/)
          assert.equal(error.attempts.length, 2)
          return true
        },
      )
    },
  )
})

test('首选返回非法 JSON 时也会降级到备用模型', async () => {
  await withServers(
    (request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"choices":[{"message":{"content":"不是 JSON"}}]}') },
    (request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }).end(replyPayload('备用救回来了')) },
    async ({ primaryUrl, fallbackUrl }) => {
      const { result, fallbackUsed } = await runModelChain({
        chain: [
          { id: 'a', baseUrl: primaryUrl, model: 'primary', apiKey: 'key-a' },
          { id: 'b', baseUrl: fallbackUrl, model: 'fallback', apiKey: 'key-b' },
        ],
        run: (entry) => generateInteractionReply({ baseUrl: entry.baseUrl, model: entry.model, apiKey: entry.apiKey, event: EVENT }),
      })
      assert.equal(result, '备用救回来了')
      assert.equal(fallbackUsed, true)
    },
  )
})
