// 互动消息里的图片素材：收集后的归一化、下载和转成模型可读的 data URL。
//
// 为什么不用“把 B站图片 URL 直接发给模型”：不同供应商对远端图片 URL 的支持不一致，
// 有的根本不抓取，于是图片静默变空。这里本地取回、必要时压缩后内联，行为才可控。
// 图片只存在于本次请求的内存里，不写磁盘。
export const MAX_IMAGES = 3
// 单图最终上限：压缩后仍超过这个体积就不要了。
export const MAX_IMAGE_BYTES = 2_000_000
// 允许下载的原图上限：手机直出照片常有 3–8 MB，压到 1568px 后会小很多。
// 不能拿最终上限去卡原图，否则压缩逻辑永远没机会运行。
export const MAX_RAW_IMAGE_BYTES = 20_000_000
export const MAX_TOTAL_BYTES = 6_000_000
export const IMAGE_FETCH_TIMEOUT_MS = 15_000

// 只允许 B站自己的图床：消息正文来自外部输入，不能让它把任意 URL 喂给模型服务。
const IMAGE_HOSTS = [
  /(^|\.)hdslb\.com$/i,
  /(^|\.)biliimg\.com$/i,
  /(^|\.)bilivideo\.com$/i,
  /(^|\.)bilibili\.com$/i,
]

export function normalizeImageUrl(raw) {
  const text = String(raw ?? '').trim()
  if (!text || text.length > 800) return ''
  const candidate = text.startsWith('//') ? `https:${text}` : text.replace(/^http:\/\//i, 'https://')
  let url
  try { url = new URL(candidate) } catch { return '' }
  if (url.protocol !== 'https:') return ''
  if (!IMAGE_HOSTS.some((pattern) => pattern.test(url.hostname))) return ''
  return url.href
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}

export function normalizeImageRefs(list, { max = MAX_IMAGES } = {}) {
  const seen = new Set()
  const refs = []
  for (const item of Array.isArray(list) ? list : []) {
    const url = normalizeImageUrl(item?.url ?? item?.img_src ?? item?.pic_url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    refs.push({
      url,
      width: positiveNumber(item?.width ?? item?.img_width),
      height: positiveNumber(item?.height ?? item?.img_height),
    })
    if (refs.length >= max) break
  }
  return refs
}

export function countImages(context, triggerImages = []) {
  const fromContext = (Array.isArray(context) ? context : [])
    .reduce((sum, entry) => sum + (Array.isArray(entry?.images) ? entry.images.length : 0), 0)
  return fromContext + (Array.isArray(triggerImages) ? triggerImages.length : 0)
}

function safeReason(error) {
  const name = String(error?.name || '')
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout'
  const message = String(error?.message || '').replace(/[\r\n\t]+/g, ' ').slice(0, 80)
  // 失败原因里不能带上图片 URL（含 B站 资源标识）。
  return message.replace(/https?:\/\/\S+/gi, '[url]') || 'failed'
}

// B站图床对 Referer 比较敏感：私信图片在 message.bilibili.com 下正常，
// 评论图片有时只认主站。逐个试，任一成功即停。
const IMAGE_REFERERS = [
  'https://message.bilibili.com/',
  'https://www.bilibili.com/',
  'https://space.bilibili.com/',
]

// 有些 CDN 对图片返回 application/octet-stream，光看 Content-Type 会误判成“不是图片”。
// 这里再用文件头兜底嗅探，覆盖 B站 图床的常见格式。
function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return ''
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (bytes.subarray(0, 2).toString('latin1') === 'BM') return 'image/bmp'
  return ''
}

// 换 Referer 只对“防盗页”有用。401/403 说明需要登录态，404/410 说明资源本身没了——
// 这两种情况继续轮换 Referer 只会白等 3 个超时，所以直接停。
function retryWorthless(status) {
  return [401, 403, 404, 410].includes(status)
}

async function fetchImageBytes(fetchImpl, url, { timeoutMs, referer, cookie }) {
  const referers = referer ? [referer] : IMAGE_REFERERS
  let lastError = null
  for (const current of referers) {
    try {
      const requestHeaders = { Referer: current, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      // 部分会话图片要求带登录态；只在重试时带上，避免默认把 Cookie 发给 CDN。
      if (cookie) requestHeaders.Cookie = cookie
      const response = await fetchImpl(url, {
        redirect: 'follow',
        headers: requestHeaders,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`)
        lastError.status = response.status
        if (retryWorthless(response.status)) break
        continue
      }
      return response
    } catch (error) {
      const wrapped = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? new Error('timeout') : error
      // 超时也不必再换 Referer 重来一遍，代价太高。
      lastError = wrapped
      if (wrapped?.message === 'timeout') break
    }
  }
  throw lastError || new Error('failed')
}

// 逐张下载；任何一张失败都只是少一张图，不影响整条回复。
export async function loadImageParts(refs, {
  fetchImpl = fetch,
  transform,
  referer = '',
  cookie = '',
  maxBytes = MAX_IMAGE_BYTES,
  maxRawBytes = MAX_RAW_IMAGE_BYTES,
  maxTotalBytes = MAX_TOTAL_BYTES,
  timeoutMs = IMAGE_FETCH_TIMEOUT_MS,
} = {}) {
  const items = []
  let total = 0
  for (const ref of Array.isArray(refs) ? refs : []) {
    if (total >= maxTotalBytes) { items.push({ ref, ok: false, reason: 'budget' }); continue }
    // 先匿名取；只有疑似“需要登录态”时才带 Cookie 重试，避免默认把凭据外发给 CDN。
    let success = null
    let lastReason = 'failed'
    const attempt = async (useCookie) => {
      const response = await fetchImageBytes(fetchImpl, ref.url, { timeoutMs, referer, cookie: useCookie ? cookie : '' })
      const headerType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      const announced = Number(response.headers.get('content-length') || 0)
      // 下载阶段只挡“大到不该进内存”的原图；真正的 2 MB 上限在压缩之后才判断。
      // 手机直出照片常有 3–8 MB，压缩前就用 2 MB 卡掉，等于让压缩逻辑永远用不上——
      // 这正是用户看到“取回 0/N 张（失败：too large）”的原因。
      if (Number.isFinite(announced) && announced > maxRawBytes) throw new Error('too large')
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.byteLength > maxRawBytes) throw new Error('too large')
      const sniffed = sniffImageType(buffer)
      const type = headerType.startsWith('image/') ? headerType : sniffed
      // 既没有图片 Content-Type，也嗅不出图片格式：多半是防盗页或错误页。
      if (!type) throw new Error('not an image')
      let bytes = buffer
      let finalType = type
      if (typeof transform === 'function') {
        // 把最终体积上限传给压缩逻辑，让它知道要压到多小，而不是只缩长边。
        const output = await transform({ bytes: buffer, contentType: type, maxBytes })
        if (output?.bytes?.byteLength) { bytes = Buffer.from(output.bytes); finalType = String(output.contentType || type) }
      }
      // 这里只按“最终要发出去的字节”判定：压缩过就用压缩后的大小。
      if (bytes.byteLength > maxBytes) throw new Error('too large')
      if (bytes.byteLength + total > maxTotalBytes) throw new Error('budget')
      return { dataUrl: `data:${finalType};base64,${bytes.toString('base64')}`, size: bytes.byteLength }
    }
    try {
      success = await attempt(false)
    } catch (error) {
      lastReason = safeReason(error)
      const status = Number(error?.status || 0)
      // 403/401 或防盗页：带上登录态还有救。其余失败重试不会有不同结果。
      const worthCookie = cookie && (status === 401 || status === 403 || lastReason === 'not an image')
      if (worthCookie) {
        try {
          success = await attempt(true)
        } catch (retryError) {
          lastReason = safeReason(retryError)
        }
      }
    }
    if (success) {
      total += success.size
      items.push({ ref, ok: true, bytes: success.size, dataUrl: success.dataUrl })
    } else {
      items.push({ ref, ok: false, reason: lastReason })
    }
  }
  return items
}

// 日志用：只给出“失败几张、各是什么原因”，不含任何地址。
export function summarizeImageParts(items) {
  const list = Array.isArray(items) ? items : []
  const ok = list.filter((item) => item?.ok).length
  const reasons = new Map()
  for (const item of list) {
    if (item?.ok) continue
    const reason = String(item?.reason || 'failed')
    reasons.set(reason, (reasons.get(reason) || 0) + 1)
  }
  const detail = [...reasons.entries()].map(([reason, count]) => `${reason}×${count}`).join('，')
  return `取回 ${ok}/${list.length} 张${detail ? `（失败：${detail}）` : ''}`
}

export function imagePart(dataUrl) {
  return { type: 'image_url', image_url: { url: dataUrl } }
}
