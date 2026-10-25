import test from 'node:test'
import assert from 'node:assert/strict'
import {
  IMAGE_FETCH_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
  countImages,
  imagePart,
  loadImageParts,
  normalizeImageRefs,
  normalizeImageUrl,
  summarizeImageParts,
} from '../src/main/interaction-images.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC', 'base64')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])

test('recovers an image whose content-type is not an image type', async () => {
  // 日志里“取回 0 张”的真实成因之一：CDN 回 image/jpg、application/octet-stream，
  // 早期只认 /^image\// 的白名单会把它当成“不是图片”丢掉。
  const looksLikeJpeg = await loadImageParts([{ url: 'https://i0.hdslb.com/a.jpg' }], {
    fetchImpl: async () => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpg' } }),
  })
  assert.equal(looksLikeJpeg[0].ok, true)
  assert.match(looksLikeJpeg[0].dataUrl, /^data:image\/jpg;base64,/)

  const octet = await loadImageParts([{ url: 'https://i0.hdslb.com/b.png' }], {
    fetchImpl: async () => new Response(PNG, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
  })
  assert.equal(octet[0].ok, true)
  // 靠文件头嗅探把类型纠正成 png。
  assert.match(octet[0].dataUrl, /^data:image\/png;base64,/)
})

test('rejects an HTML anti-hotlink page served with HTTP 200', async () => {
  const items = await loadImageParts([{ url: 'https://i0.hdslb.com/a.jpg' }], {
    fetchImpl: async () => new Response('<html>denied</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  })
  assert.equal(items[0].ok, false)
  assert.equal(items[0].reason, 'not an image')
})

test('retries with credentials when the CDN demands a login, and stops early otherwise', async () => {
  let calls = 0
  const guarded = await loadImageParts([{ url: 'https://i0.hdslb.com/a.png' }], {
    cookie: 'SESSDATA=x',
    fetchImpl: async (url, options) => {
      calls += 1
      return options.headers.Cookie
        ? new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
        : new Response('forbidden', { status: 403 })
    },
  })
  assert.equal(guarded[0].ok, true)
  // 403 → 带 Cookie 重试一次即成功；不应该把 3 个 Referer 都轮一遍。
  assert.equal(calls, 2)

  // 404 说明资源没了，换 Referer 或带 Cookie 都不会变好，只应请求一次。
  let missing = 0
  const gone = await loadImageParts([{ url: 'https://i0.hdslb.com/gone.jpg' }], {
    cookie: 'SESSDATA=x',
    fetchImpl: async () => { missing += 1; return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } }) },
  })
  assert.equal(gone[0].ok, false)
  assert.equal(gone[0].reason, 'HTTP 404')
  assert.equal(missing, 1)
})

test('never sends credentials unless a retry actually needs them', async () => {
  const seen = []
  await loadImageParts([{ url: 'https://i0.hdslb.com/a.png' }], {
    cookie: 'SESSDATA=x',
    fetchImpl: async (url, options) => {
      seen.push(options.headers.Cookie || '')
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
    },
  })
  // 第一次成功就不该出现 Cookie。
  assert.deepEqual(seen, [''])
})

test('summarizes failures without leaking any URL', () => {
  const summary = summarizeImageParts([
    { ref: { url: 'https://i0.hdslb.com/a.jpg' }, ok: true },
    { ref: { url: 'https://i0.hdslb.com/b.jpg' }, ok: false, reason: 'HTTP 404' },
    { ref: { url: 'https://i0.hdslb.com/c.jpg' }, ok: false, reason: 'HTTP 404' },
    { ref: { url: 'https://i0.hdslb.com/d.jpg' }, ok: false, reason: 'timeout' },
  ])
  assert.match(summary, /取回 1\/4 张/)
  assert.match(summary, /HTTP 404×2/)
  assert.match(summary, /timeout×1/)
  assert.doesNotMatch(summary, /hdslb\.com/)
  // 全成功时不追加失败明细。
  assert.equal(summarizeImageParts([{ ok: true }]), '取回 1/1 张')
  assert.equal(summarizeImageParts([]), '取回 0/0 张')
})

test('only accepts https URLs on Bilibili image hosts', () => {
  assert.equal(normalizeImageUrl('https://i0.hdslb.com/bfs/a.jpg'), 'https://i0.hdslb.com/bfs/a.jpg')
  assert.equal(normalizeImageUrl('//message.biliimg.com/a.jpg'), 'https://message.biliimg.com/a.jpg')
  // http 自动升级；其他域名、非 https 协议、空值都拒绝。
  assert.equal(normalizeImageUrl('http://i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg')
  assert.equal(normalizeImageUrl('https://example.com/a.jpg'), '')
  assert.equal(normalizeImageUrl('https://hdslb.com.evil.test/a.jpg'), '')
  assert.equal(normalizeImageUrl('ftp://i0.hdslb.com/a.jpg'), '')
  assert.equal(normalizeImageUrl(''), '')
  assert.equal(normalizeImageUrl(`https://i0.hdslb.com/${'a'.repeat(900)}.jpg`), '')
})

test('normalizes image refs, dedupes and caps the count', () => {
  const refs = normalizeImageRefs([
    { url: 'https://i0.hdslb.com/a.jpg', width: 640, height: 480 },
    { img_src: 'https://i0.hdslb.com/a.jpg' },
    { pic_url: 'https://i1.hdslb.com/b.png' },
    { url: 'https://example.com/c.jpg' },
    { url: 'https://i2.hdslb.com/d.jpg' },
    { url: 'https://i3.hdslb.com/e.jpg' },
    { url: 'https://i4.hdslb.com/f.jpg' },
  ])
  // 默认上限 3 张：多余的第 4 张之后被截断。
  assert.deepEqual(refs.map((ref) => ref.url), [
    'https://i0.hdslb.com/a.jpg',
    'https://i1.hdslb.com/b.png',
    'https://i2.hdslb.com/d.jpg',
  ])
  assert.equal(refs[0].width, 640)
  assert.equal(refs[1].width, 0)
  // 单条目（例如评论里发了 4 张图）允许放宽到 4 张。
  assert.equal(normalizeImageRefs(Array.from({ length: 6 }, (_, index) => ({ url: `https://i0.hdslb.com/${index}.jpg` })), { max: 4 }).length, 4)
})

test('counts images from both the context and the trigger message', () => {
  assert.equal(countImages([], []), 0)
  assert.equal(countImages([{ images: [{ url: 'a' }, { url: 'b' }] }, { images: [] }], [{ url: 'c' }]), 3)
})

test('loads images as base64 data URLs and keeps binary out of logs', async () => {
  const fetchImpl = async () => new Response(Buffer.from('fake-jpeg'), {
    status: 200, headers: { 'content-type': 'image/jpeg' },
  })
  const parts = await loadImageParts([{ url: 'https://i0.hdslb.com/a.jpg' }], { fetchImpl })
  assert.equal(parts.length, 1)
  assert.equal(parts[0].ok, true)
  assert.match(parts[0].dataUrl, /^data:image\/jpeg;base64,/)
  assert.equal(Buffer.from(parts[0].dataUrl.split(',')[1], 'base64').toString(), 'fake-jpeg')
  assert.equal(imagePart(parts[0].dataUrl).type, 'image_url')
})

test('drops a failed image without failing the whole reply', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('ok')) return new Response(Buffer.from('x'), { status: 200, headers: { 'content-type': 'image/png' } })
    if (String(url).includes('404')) return new Response('nope', { status: 404 })
    if (String(url).includes('html')) return new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
    if (String(url).includes('huge')) return new Response(Buffer.alloc(MAX_IMAGE_BYTES + 1), { status: 200, headers: { 'content-type': 'image/jpeg' } })
    throw new Error(`boom https://i0.hdslb.com/secret.jpg`)
  }
  const parts = await loadImageParts([
    { url: 'https://i0.hdslb.com/ok.jpg' },
    { url: 'https://i0.hdslb.com/404.jpg' },
    { url: 'https://i0.hdslb.com/html.jpg' },
    { url: 'https://i0.hdslb.com/huge.jpg' },
    { url: 'https://i0.hdslb.com/throw.jpg' },
  ], { fetchImpl })
  assert.deepEqual(parts.map((part) => part.ok), [true, false, false, false, false])
  assert.equal(parts[1].reason, 'HTTP 404')
  assert.equal(parts[2].reason, 'not an image')
  assert.equal(parts[3].reason, 'too large')
  // 异常信息里的 URL 必须被替换，否则日志会带上 B站 资源地址。
  assert.equal(parts[4].reason, 'boom [url]')
})

test('stops adding images once the total byte budget is spent', async () => {
  const fetchImpl = async () => new Response(Buffer.alloc(3), { status: 200, headers: { 'content-type': 'image/jpeg' } })
  const parts = await loadImageParts(
    [1, 2, 3, 4].map((index) => ({ url: `https://i0.hdslb.com/${index}.jpg` })),
    { fetchImpl, maxTotalBytes: 7 },
  )
  assert.deepEqual(parts.map((part) => part.ok), [true, true, false, false])
  assert.equal(parts[2].reason, 'budget')
})

test('re-checks the size after the transform, which may return a bigger image', async () => {
  const fetchImpl = async () => new Response(Buffer.alloc(40), { status: 200, headers: { 'content-type': 'image/png' } })
  const parts = await loadImageParts([{ url: 'https://i0.hdslb.com/a.png' }], {
    fetchImpl,
    maxBytes: 50,
    // 原图 40 字节合规，但 transform 返回了 80 字节：必须按压缩后的结果再判一次。
    transform: () => ({ bytes: Buffer.alloc(80), contentType: 'image/jpeg' }),
  })
  assert.equal(parts[0].ok, false)
  assert.equal(parts[0].reason, 'too large')

  // 原图超过“最终上限”但仍在“允许下载上限”内时，必须先交给 transform 压缩：
  // 手机直出的照片就是这样，压缩前就用最终上限卡掉会让压缩永远不生效。
  const big = await loadImageParts([{ url: 'https://i0.hdslb.com/b.png' }], {
    fetchImpl: async () => new Response(Buffer.alloc(100), { status: 200, headers: { 'content-type': 'image/png' } }),
    maxBytes: 50,
    maxRawBytes: 1000,
    transform: () => ({ bytes: Buffer.alloc(10), contentType: 'image/jpeg' }),
  })
  assert.equal(big[0].ok, true)
  assert.equal(big[0].bytes, 10)

  // 超过“允许下载上限”的原图才在下载阶段直接拒绝，不占内存、也不值得压缩。
  const huge = await loadImageParts([{ url: 'https://i0.hdslb.com/c.png' }], {
    fetchImpl: async () => new Response(Buffer.alloc(2000), { status: 200, headers: { 'content-type': 'image/png' } }),
    maxBytes: 50,
    maxRawBytes: 1000,
    transform: () => ({ bytes: Buffer.alloc(10), contentType: 'image/jpeg' }),
  })
  assert.equal(huge[0].ok, false)
  assert.equal(huge[0].reason, 'too large')
})

test('compresses an oversized source image instead of rejecting it before the transform', async () => {
  // 回归：手机直出照片常有 3–8 MB。旧代码在压缩前就用 2 MB 的最终上限卡掉，
  // 于是日志出现「取回 0/5 张（失败：too large×5）」，模型只能回“附件没加载出来”。
  const source = Buffer.alloc(5_000_000, 7)
  const items = await loadImageParts([{ url: 'https://i0.hdslb.com/photo.png' }], {
    fetchImpl: async () => new Response(source, { status: 200, headers: { 'content-type': 'image/png' } }),
    transform: ({ maxBytes }) => ({ bytes: Buffer.alloc(Math.min(1000, maxBytes)), contentType: 'image/jpeg' }),
  })
  assert.equal(items[0].ok, true)
  assert.equal(items[0].bytes, 1000)

  // 压缩拿不到更小的结果时，才按最终上限拒绝。
  const hopeless = await loadImageParts([{ url: 'https://i0.hdslb.com/photo2.png' }], {
    fetchImpl: async () => new Response(source, { status: 200, headers: { 'content-type': 'image/png' } }),
    transform: () => null,
  })
  assert.equal(hopeless[0].ok, false)
  assert.equal(hopeless[0].reason, 'too large')
})

test('uses the configured referer and timeout when downloading', async () => {
  let seen
  const fetchImpl = async (url, options) => {
    seen = { url: String(url), options }
    return new Response(Buffer.from('x'), { status: 200, headers: { 'content-type': 'image/jpeg' } })
  }
  await loadImageParts([{ url: 'https://i0.hdslb.com/a.jpg' }], { fetchImpl })
  assert.equal(seen.url, 'https://i0.hdslb.com/a.jpg')
  assert.equal(seen.options.headers.Referer, 'https://message.bilibili.com/')
  assert.ok(seen.options.signal instanceof AbortSignal)
  assert.ok(IMAGE_FETCH_TIMEOUT_MS >= 5_000)
})
