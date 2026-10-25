// 并行分片下载器：绕开 Chromium 网络栈，直接用 Node 的 net/tls 走 HTTP/1.1。
//
// 为什么不能只用 Electron 的 net.fetch（改之前先读）：
// Chromium 会把同一主机的所有请求多路复用到一条 HTTP/2 连接上，所以并发 8 条
// Range 请求的实测吞吐和单条一样（都是 ~80 KB/s）。强行 disable-http2 之后
// GitHub 直接返回 429。而 curl 用 8 条连接能到 ~670 KB/s，Node 的 tls 直连
// （自己开 8 条 HTTP/1.1 连接）实测 ~560 KB/s——同一个网络，差 6 倍。
// 128 MB 的更新包因此从 24 分钟降到 4 分钟左右。
//
// 这个模块只做“把远端文件的分片可靠地写进本地文件”这一件事：
// - 每段自己 CONNECT 隧道 + TLS + Range 请求，互不干扰；
// - 每段记录已写偏移，断了从断点续传，不会整包重来；
// - 进度按累计字节汇报，取消时立刻关闭所有 socket；
// - 不新增依赖，只用 node:net / node:tls / node:fs。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import tls from 'node:tls'

const DEFAULT_SEGMENTS = 8
// 每块 2 MB：块小一点，尾部才不会因为“最后几段特别长”而拖慢整体速度。
const DEFAULT_CHUNK_BYTES = 2 * 1024 * 1024
// 每段启动之间错开一点：同时开 8 条握手容易触发对端的并发限制（实测会拿到 429）。
const STAGGER_MS = 180
const SEGMENT_ATTEMPTS = 5
const MAX_REDIRECTS = 5
const USER_AGENT = 'whaleagent-updater'

// Electron 的 resolveProxy 返回 "PROXY host:port" / "DIRECT" / "SOCKS5 host:port" 这类字符串。
// 这里只支持 HTTP/HTTPS 代理（Windows 系统代理的常见形态）；SOCKS 与 DIRECT 都按直连处理，
// 直连失败时调用方会退回 net.fetch，所以不必在这里硬啃 SOCKS 握手。
export function parseProxyString(value) {
  const text = String(value || '').trim()
  const match = /^(PROXY|HTTPS?)\s+([^\s;]+)/i.exec(text)
  if (!match) return null
  const target = match[2]
  const [host, portText] = target.includes(']')
    ? [target.slice(0, target.indexOf(']') + 1), target.slice(target.indexOf(']') + 2)]
    : target.split(':')
  const port = Number(portText)
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host: host.replace(/^\[|\]$/g, ''), port }
}

// 通过 HTTP 代理建立到目标主机的 TLS 连接（标准 CONNECT 隧道）。
function connectViaProxy(proxy, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port })
    const fail = (error) => { socket.destroy(); reject(error) }
    const timer = setTimeout(() => fail(new Error('代理连接超时')), timeoutMs)
    socket.on('error', fail)
    socket.once('connect', () => {
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nUser-Agent: ${USER_AGENT}\r\n\r\n`)
    })
    let buffered = Buffer.alloc(0)
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      const index = buffered.indexOf('\r\n\r\n')
      if (index === -1) {
        if (buffered.length > 16 * 1024) fail(new Error('代理响应过长'))
        return
      }
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', fail)
      const head = buffered.subarray(0, index).toString('latin1')
      if (!/^HTTP\/1\.[01]\s+200/.test(head)) {
        fail(new Error(`代理拒绝隧道：${head.split('\r\n')[0]}`))
        return
      }
      const rest = buffered.subarray(index + 4)
      if (rest.length) socket.unshift(rest)
      resolve(tls.connect({ socket, servername: host }))
    }
    socket.on('data', onData)
  })
}

function connectDirect(host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 443, servername: host })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('连接超时')) }, timeoutMs)
    socket.once('secureConnect', () => { clearTimeout(timer); resolve(socket) })
    socket.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

function connectTo(host, proxy, timeoutMs) {
  return proxy ? connectViaProxy(proxy, host, timeoutMs) : connectDirect(host, timeoutMs)
}

function parseHead(text) {
  const lines = text.split('\r\n')
  const status = Number((lines[0] || '').split(/\s+/)[1])
  const headers = {}
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':')
    if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
  }
  return { status, headers }
}

// 发一个 GET 并只读响应头，返回还没消费的 body 字节（可能已经跟在同一批数据里）。
function openRequest({ host, path, rangeStart, rangeEnd, proxy, timeoutMs }) {
  return connectTo(host, proxy, timeoutMs).then((socket) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('请求超时')) }, timeoutMs)
    const cleanup = () => { clearTimeout(timer); socket.removeListener('data', onData); socket.removeListener('error', onError) }
    const onError = (error) => { cleanup(); socket.destroy(); reject(error) }
    let buffered = Buffer.alloc(0)
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      const index = buffered.indexOf('\r\n\r\n')
      if (index === -1) {
        if (buffered.length > 64 * 1024) onError(new Error('响应头过长'))
        return
      }
      cleanup()
      const { status, headers } = parseHead(buffered.subarray(0, index).toString('latin1'))
      resolve({ status, headers, socket, leftover: buffered.subarray(index + 4) })
    }
    socket.on('data', onData)
    socket.on('error', onError)
    const range = Number.isInteger(rangeStart) && Number.isInteger(rangeEnd)
      ? `Range: bytes=${rangeStart}-${rangeEnd}\r\n`
      : ''
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: ${USER_AGENT}\r\nAccept: */*\r\n` +
      `Accept-Encoding: identity\r\n${range}Connection: close\r\n\r\n`,
    )
  }))
}

// 跟随重定向：GitHub 的 release 资产会跳到 objects.githubusercontent.com。
async function openFollowing({ url, rangeStart, rangeEnd, proxy, timeoutMs }) {
  let current = new URL(url)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await openRequest({
      host: current.host,
      path: `${current.pathname}${current.search}`,
      rangeStart,
      rangeEnd,
      proxy,
      timeoutMs,
    })
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      response.socket.destroy()
      current = new URL(response.headers.location, current)
      continue
    }
    return response
  }
  throw new Error('重定向次数过多')
}

// 把一段字节写进文件：从 offset 开始，最多 length 字节。
// 每写成功一块就通过 onWritten 汇报，让调用方随时知道真实进度——
// 出错时靠这个偏移续传，不会把已经写过的字节再写一遍、再数一遍。
//
// 写入必须串行、并且 **end 事件要等最后一块写完**：socket 的 'end' 可能比最后一个
// 写盘回调更早触发，直接 resolve 会少写最后几百字节（实测每段都差 245 字节左右）。
async function readIntoFile({ response, file, offset, length, onWritten, shouldAbort }) {
  let written = 0
  let chain = Promise.resolve()
  const writeChunk = (buffer) => {
    const remaining = length - written
    if (remaining <= 0) return chain
    const slice = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer
    written += slice.length
    const position = offset + written - slice.length
    chain = chain.then(async () => {
      await file.write(slice, 0, slice.length, position)
      onWritten(slice.length)
    })
    return chain
  }

  if (response.leftover.length) writeChunk(response.leftover)
  if (written >= length) {
    await chain
    response.socket.destroy()
    return written
  }

  await new Promise((resolve, reject) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      response.socket.removeListener('data', onData)
      response.socket.removeListener('end', onEnd)
      response.socket.removeListener('error', onError)
      // 不管成功还是失败，都等已排队的写入落盘再结束。
      chain.then(() => (error ? reject(error) : resolve()), reject)
    }
    const onData = (chunk) => {
      if (shouldAbort()) { response.socket.destroy(); finish(new Error('cancelled')); return }
      writeChunk(chunk)
      if (written >= length) { response.socket.destroy(); finish() }
    }
    const onEnd = () => finish()
    const onError = (error) => finish(error)
    response.socket.on('data', onData)
    response.socket.on('end', onEnd)
    response.socket.on('error', onError)
  })
  return written
}

// 下载一个分片，失败按退避重试，每次都从已写入的位置续传。
async function fetchSegment({ url, file, segment, proxy, timeoutMs, onChunk, shouldAbort, logger }) {
  let lastError = null
  for (let attempt = 1; attempt <= SEGMENT_ATTEMPTS; attempt += 1) {
    if (shouldAbort()) throw new Error('cancelled')
    if (segment.done >= segment.length) return
    const offset = segment.start + segment.done
    const remaining = segment.length - segment.done
    try {
      const response = await openFollowing({
        url,
        rangeStart: offset,
        rangeEnd: offset + remaining - 1,
        proxy,
        timeoutMs,
      })
      if (response.status !== 206) {
        response.socket.destroy()
        // 服务器不认 Range 就不能分片下载，交给调用方退回单连接。
        throw new Error(`range-unsupported:${response.status}`)
      }
      await readIntoFile({
        response,
        file,
        offset,
        length: remaining,
        // 写一块记一块：中途断开时 segment.done 就是真实断点。
        onWritten: (bytes) => {
          segment.done += bytes
          onChunk(bytes)
        },
        shouldAbort,
      })
      if (segment.done >= segment.length) return
      // 流正常结束但字节不够：连接被中间掐断，继续续传。
      lastError = new Error(`分片不完整（${segment.done}/${segment.length}）`)
      logger('warn', 'download-segment-short', `start=${segment.start} ${segment.done}/${segment.length}`)
    } catch (error) {
      const message = String(error?.message || error)
      if (message === 'cancelled' || message.startsWith('range-unsupported')) throw error
      lastError = error
      logger('warn', 'download-segment-retry', `start=${segment.start} attempt=${attempt} ${message.slice(0, 120)}`)
    }
    if (attempt < SEGMENT_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 900 * attempt))
    }
  }
  // 用完所有重试仍然不完整：必须报错，不能默默返回一个缺字节的文件。
  throw lastError || new Error(`分片下载失败（${segment.done}/${segment.length}）`)
}

/**
 * 并行分片下载 url 到 filePath。
 *
 * 分块策略：把文件切成很多小块（默认每块 2 MB），再由固定数量的 worker 从共享队列里
 * 领活。**不用“固定 8 段各下一整段”**——那样先下完的段会让连接空转，实测尾部速度
 * 从 700 KB/s 掉到 118 KB/s。队列模式下连接一直满载到最后一字节。
 *
 * @returns {Promise<{ bytes: number, segments: number, ranged: boolean }>}
 *   ranged=false 表示服务器不支持 Range，调用方需要用别的办法整包下载。
 */
export async function parallelDownload({
  url,
  filePath,
  totalSize,
  segments = DEFAULT_SEGMENTS,
  chunkSize = DEFAULT_CHUNK_BYTES,
  proxy = null,
  timeoutMs = 60_000,
  onProgress = () => {},
  shouldAbort = () => false,
  logger = () => {},
} = {}) {
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) throw new Error('缺少文件总大小，无法分片下载。')

  const file = await fsp.open(filePath, 'w')
  let received = 0
  const onChunk = (bytes) => {
    received += bytes
    onProgress(received, totalSize)
  }

  try {
    // 切块：小文件退化成 1 块，worker 数不超过块数。
    const queue = []
    for (let start = 0; start < totalSize; start += chunkSize) {
      queue.push({ start, length: Math.min(chunkSize, totalSize - start), done: 0 })
    }
    const workers = Math.max(1, Math.min(segments, queue.length))
    let cursor = 0

    const worker = async (index) => {
      // 错峰启动，避免同一瞬间开太多握手被对端限流（实测会拿到 429）。
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, index * STAGGER_MS))
      while (true) {
        if (shouldAbort()) throw new Error('cancelled')
        const chunk = queue[cursor]
        cursor += 1
        if (!chunk) return
        await fetchSegment({ url, file, segment: chunk, proxy, timeoutMs, onChunk, shouldAbort, logger })
      }
    }

    await Promise.all(Array.from({ length: workers }, (_, index) => worker(index)))
    return { bytes: received, segments: workers, ranged: true }
  } catch (error) {
    if (String(error?.message || '').startsWith('range-unsupported')) {
      return { bytes: received, segments: 0, ranged: false }
    }
    throw error
  } finally {
    try { await file.close() } catch {}
  }
}

// 整包顺序下载（服务器不支持 Range 时的兜底）。
export async function sequentialDownload({
  url,
  filePath,
  proxy = null,
  timeoutMs = 60_000,
  onProgress = () => {},
  shouldAbort = () => false,
} = {}) {
  const file = await fsp.open(filePath, 'w')
  let received = 0
  try {
    const response = await openFollowing({ url, proxy, timeoutMs })
    if (response.status !== 200) {
      response.socket.destroy()
      throw new Error(`HTTP ${response.status}`)
    }
    const declared = Number(response.headers['content-length'] || 0)
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        response.socket.removeListener('data', onData)
        response.socket.removeListener('end', onEnd)
        response.socket.removeListener('error', onError)
        if (error) reject(error); else resolve()
      }
      const onData = (chunk) => {
        if (shouldAbort()) { response.socket.destroy(); finish(new Error('cancelled')); return }
        file.write(chunk, 0, chunk.length, received).then(() => {
          received += chunk.length
          onProgress(received, declared || received)
        }, (error) => { response.socket.destroy(); finish(error) })
      }
      const onEnd = () => finish()
      const onError = (error) => finish(error)
      if (response.leftover.length) onData(response.leftover)
      response.socket.on('data', onData)
      response.socket.on('end', onEnd)
      response.socket.on('error', onError)
    })
    return { bytes: received }
  } finally {
    try { await file.close() } catch {}
  }
}

// 探测总大小与是否支持 Range。返回 { total, ranged }。
export async function probeRemote({ url, proxy = null, timeoutMs = 20_000 } = {}) {
  const response = await openFollowing({ url, rangeStart: 0, rangeEnd: 0, proxy, timeoutMs })
  response.socket.destroy()
  if (response.status !== 206) {
    const total = Number(response.headers['content-length'] || 0)
    return { total: Number.isSafeInteger(total) ? total : 0, ranged: false }
  }
  const match = /\/(\d+)\s*$/.exec(String(response.headers['content-range'] || ''))
  return { total: match ? Number(match[1]) : 0, ranged: true }
}

export { DEFAULT_CHUNK_BYTES, DEFAULT_SEGMENTS }
