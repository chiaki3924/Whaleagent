import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSearchResults, pickLoginCookies, signedWbiQuery, beginQrLogin, pollQrLogin, fetchVideoForAnalysis, searchVideos, fetchFollowingVideos, fetchHomepageVideos, discoverVideos, likeVideo, favoriteVideo } from '../src/main/bilibili.js'

const IMG = `https://i0.hdslb.com/bfs/wbi/${'a'.repeat(32)}.png`
const SUB = `https://i0.hdslb.com/bfs/wbi/${'b'.repeat(32)}.png`

test('extracts only expected login cookies and preserves values containing equals', () => {
  assert.deepEqual(pickLoginCookies([
    'SESSDATA=abc==; Path=/; HttpOnly',
    'bili_jct=csrf; Path=/',
    'DedeUserID=42; Path=/',
    'unrelated=value; Path=/',
  ]), { sessdata: 'abc==', bili_jct: 'csrf', dedeuserid: '42' })
})

test('creates deterministic WBI signature query', () => {
  const query = signedWbiQuery({ search_type: 'video', keyword: '猫 & AI', page: 1 }, IMG, SUB, 1700000000)
  assert.match(query, /^keyword=%E7%8C%AB%20%26%20AI&page=1&search_type=video&wts=1700000000&w_rid=[a-f0-9]{32}$/)
})

test('normalizes and bounds search results, stripping markup', () => {
  const list = normalizeSearchResults({ result: [
    { bvid: 'BV1234567890', title: '<em>猫</em> &amp; AI', author: '<b>作者</b>', description: '<i>简介</i>', play: 12, duration: '2:10', pubdate: 1700000000 },
    { title: 'missing id' },
  ] })
  assert.equal(list.length, 1)
  assert.equal(list[0].title, '猫 & AI')
  assert.equal(list[0].author, '作者')
  assert.equal(list[0].url, 'https://www.bilibili.com/video/BV1234567890/')
  assert.deepEqual(normalizeSearchResults({ result: { unexpected: true } }), [])
  assert.equal(normalizeSearchResults({ results: [{ bvid: 'BVabcdefghij', title: 'ok', pubdate: 1e99 }] })[0].publishedAt, '')
})

test('searches the requested read-only page and returns bounded pagination metadata', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    const target = String(url)
    urls.push(target)
    if (target.includes('/x/web-interface/nav')) return new Response(JSON.stringify({ code: 0, data: { wbi_img: { img_url: IMG, sub_url: SUB } } }), { status: 200 })
    if (target.includes('/x/web-interface/wbi/search/type?')) return new Response(JSON.stringify({ code: 0, data: {
      numPages: 4,
      result: [{ bvid: 'BV1234567890', title: '第二页结果', author: 'UP', duration: '1:00' }],
    } }), { status: 200 })
    throw new Error('Unexpected URL')
  }
  const result = await searchVideos('AI 工具', { sessdata: 'cookie', bili_jct: 'csrf' }, { fetchImpl, page: 2 })
  assert.equal(result.page, 2)
  assert.equal(result.totalPages, 4)
  assert.equal(result.hasNext, true)
  assert.equal(result.items[0].title, '第二页结果')
  const searchUrl = new URL(urls.find((url) => url.includes('/x/web-interface/wbi/search/type?')))
  assert.equal(searchUrl.searchParams.get('page'), '2')
  assert.equal(searchUrl.searchParams.get('search_type'), 'video')
})

test('bounds search page input', async () => {
  await assert.rejects(searchVideos('keyword', { sessdata: 's', bili_jct: 'j' }, { page: 0, fetchImpl: async () => { throw new Error('should not fetch') } }), /页码必须在 1 到 50/)
  await assert.rejects(searchVideos('keyword', { sessdata: 's', bili_jct: 'j' }, { page: 51, fetchImpl: async () => { throw new Error('should not fetch') } }), /页码必须在 1 到 50/)
})

test('reads following video updates through one read-only request and normalizes archives', async () => {
  let request
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options }
    return new Response(JSON.stringify({ code: 0, data: { items: [
      { type: 'DYNAMIC_TYPE_AV', modules: { module_author: { name: '关注UP', pub_ts: 1700000000 }, module_dynamic: { major: { archive: { bvid: 'BV1234567890', title: '关注更新', desc: '简介', duration_text: '05:23', stat: { play: 123 } } } } } },
      { type: 'DYNAMIC_TYPE_FORWARD', modules: { module_author: { name: '关注UP' }, module_dynamic: { major: { archive: { bvid: 'BVforward000', title: '转发的视频', desc: '简介', duration_text: '01:00' } } } } },
      { modules: { module_author: { name: '非视频' }, module_dynamic: { desc: { text: '动态文本' } } } },
    ] } }), { status: 200 })
  }
  const items = await fetchFollowingVideos({ sessdata: 'cookie', bili_jct: 'csrf' }, { fetchImpl })
  assert.equal(new URL(request.url).pathname, '/x/polymer/web-dynamic/v1/feed/all')
  assert.equal(request.options.method, undefined)
  assert.match(request.options.headers.Cookie, /SESSDATA=cookie/)
  assert.equal(items.length, 1)
  assert.equal(items[0].source, '关注动态')
  assert.equal(items[0].followed, true)
  assert.equal(items[0].duration, '5:23')
  assert.ok(!items.some((item) => item.title === '转发的视频'))
})

test('reads homepage recommendations but excludes live rooms, ads and invalid videos', async () => {
  const urls = []
  const fetchImpl = async (url, options) => {
    const target = String(url)
    urls.push({ target, options })
    if (target.includes('/x/web-interface/nav')) return new Response(JSON.stringify({ code: 0, data: { wbi_img: { img_url: IMG, sub_url: SUB } } }), { status: 200 })
    if (target.includes('/x/web-interface/wbi/index/top/feed/rcmd?')) return new Response(JSON.stringify({ code: 0, data: { item: [
      { goto: 'av', show_info: 1, bvid: 'BV1234567890', title: '首页视频', owner: { name: 'UP' }, stat: { view: 8 }, duration: 90 },
      { goto: 'live', show_info: 0, bvid: '', title: '直播' },
      { goto: 'av', show_info: 1, bvid: 'BVabcdefghij', title: '广告', business_info: { is_ad_loc: true } },
      { goto: 'av', show_info: 1, is_stock: 1, bvid: 'BVstock00000', title: '库存卡片' },
      { goto: 'av', show_info: 1, bvid: '', title: '无 BV 视频' },
    ] } }), { status: 200 })
    throw new Error('Unexpected URL')
  }
  const items = await fetchHomepageVideos({ sessdata: 'cookie', bili_jct: 'csrf' }, { fetchImpl })
  assert.equal(items.length, 1)
  assert.equal(items[0].source, '首页推荐')
  assert.ok(urls.every((call) => call.options.method === undefined))
  assert.equal(urls[1].options.headers.Cookie.includes('cookie'), true)
})

test('aggregates selected sources, deduplicates BV ids, and tolerates one source failing', async () => {
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/x/web-interface/nav')) return new Response(JSON.stringify({ code: 0, data: { wbi_img: { img_url: IMG, sub_url: SUB } } }), { status: 200 })
    if (target.includes('/x/web-interface/wbi/search/type?')) return new Response(JSON.stringify({ code: 0, data: { numPages: 3, result: [
      { bvid: 'BV1234567890', title: '关键词结果' },
      { bvid: 'BVabcdefghij', title: '另一个结果' },
    ] } }), { status: 200 })
    if (target.includes('/x/polymer/web-dynamic/v1/feed/all')) return new Response('unavailable', { status: 503 })
    throw new Error('Unexpected URL')
  }
  const result = await discoverVideos('关注主题', { sessdata: 'cookie', bili_jct: 'csrf' }, { fetchImpl, page: 1, sources: ['keyword', 'following'] })
  assert.equal(result.items.length, 2)
  assert.deepEqual(result.sourceWarnings, ['following'])
  assert.equal(result.hasNext, true)
  await assert.rejects(discoverVideos('', { sessdata: 'cookie', bili_jct: 'csrf' }, { sources: ['unknown'] }), /来源选项无效/)
})

test('aggregates homepage and following sources with BV de-duplication', async () => {
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/x/web-interface/nav')) return new Response(JSON.stringify({ code: 0, data: { wbi_img: { img_url: IMG, sub_url: SUB } } }), { status: 200 })
    if (target.includes('/x/polymer/web-dynamic/v1/feed/all')) return new Response(JSON.stringify({ code: 0, data: { items: [
      { modules: { module_author: { name: '关注UP' }, module_dynamic: { major: { archive: { bvid: 'BV1234567890', title: '共享视频' } } } } },
    ] } }), { status: 200 })
    if (target.includes('/x/web-interface/wbi/index/top/feed/rcmd?')) return new Response(JSON.stringify({ code: 0, data: { item: [
      { goto: 'av', show_info: 1, bvid: 'BV1234567890', title: '共享视频', owner: { name: '首页UP' } },
      { goto: 'av', show_info: 1, bvid: 'BVabcdefghij', title: '首页独有', owner: { name: '另一UP' } },
    ] } }), { status: 200 })
    throw new Error('Unexpected URL')
  }
  const result = await discoverVideos('', { sessdata: 'cookie', bili_jct: 'csrf' }, { fetchImpl, sources: ['following', 'homepage'] })
  assert.equal(result.items.length, 2)
  assert.deepEqual(result.items.map((item) => item.bvid), ['BV1234567890', 'BVabcdefghij'])
  assert.deepEqual(result.items.map((item) => item.source), ['关注动态', '首页推荐'])
  assert.equal(result.hasNext, false)
})

test('likes a selected video with login cookies and CSRF token', async () => {
  let request
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options }
    return new Response(JSON.stringify({ code: 0, message: '0' }), { status: 200 })
  }
  const result = await likeVideo('BV1234567890', { sessdata: 'cookie', bili_jct: 'csrf' }, { fetchImpl })
  assert.equal(new URL(request.url).pathname, '/x/web-interface/archive/like')
  assert.equal(request.options.method, 'POST')
  assert.match(request.options.headers.Cookie, /SESSDATA=cookie/)
  assert.match(request.options.headers.Cookie, /bili_jct=csrf/)
  assert.deepEqual(Object.fromEntries(new URLSearchParams(request.options.body)), { bvid: 'BV1234567890', like: '1', csrf: 'csrf' })
  assert.deepEqual(result, { liked: true, already: false, bvid: 'BV1234567890' })
})

test('treats a duplicate like as already liked instead of a failure', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ code: 65006, message: '重复点赞' }), { status: 200 })
  const result = await likeVideo('BV1234567890', { sessdata: 'cookie', bili_jct: 'csrf' }, { fetchImpl })
  assert.deepEqual(result, { liked: true, already: true, bvid: 'BV1234567890' })
})

test('favorites a video by resolving its avid and the default favorite folder', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const target = String(url)
    calls.push({ target, options })
    if (target.includes('/x/web-interface/view?')) {
      return new Response(JSON.stringify({ code: 0, data: { aid: 778899 } }), { status: 200 })
    }
    if (target.includes('/x/v3/fav/folder/created/list-all')) {
      return new Response(JSON.stringify({ code: 0, data: { list: [{ id: 12345, title: '默认收藏夹', attr: 0 }] } }), { status: 200 })
    }
    if (target.includes('/x/v3/fav/resource/deal')) {
      return new Response(JSON.stringify({ code: 0, message: '0' }), { status: 200 })
    }
    throw new Error(`Unexpected URL: ${target}`)
  }
  const result = await favoriteVideo('BV1234567890', { sessdata: 'cookie', bili_jct: 'csrf', mid: '42' }, { fetchImpl })
  assert.equal(result.favorited, true)
  assert.equal(result.mediaId, '12345')
  const deal = calls.find((call) => call.target.includes('/x/v3/fav/resource/deal'))
  assert.equal(deal.options.method, 'POST')
  // rid 必须是 avid，不是 BV；add_media_ids 是收藏夹 id。
  assert.deepEqual(Object.fromEntries(new URLSearchParams(deal.options.body)), {
    rid: '778899', type: '2', add_media_ids: '12345', del_media_ids: '', csrf: 'csrf',
  })
})

test('refuses to favorite without CSRF or a usable folder', async () => {
  await assert.rejects(favoriteVideo('BV1234567890', { sessdata: 'cookie' }), /缺少 CSRF/)
  const noFolder = async (url) => {
    if (String(url).includes('/x/web-interface/view?')) return new Response(JSON.stringify({ code: 0, data: { aid: 1 } }), { status: 200 })
    return new Response(JSON.stringify({ code: 0, data: { list: [] } }), { status: 200 })
  }
  await assert.rejects(favoriteVideo('BV1234567890', { sessdata: 'cookie', bili_jct: 'csrf', mid: '42' }, { fetchImpl: noFolder }), /没有找到可用的默认收藏夹/)
})

test('refuses a like without CSRF and surfaces Bilibili API failures', async () => {
  await assert.rejects(likeVideo('BV1234567890', { sessdata: 'cookie' }, { fetchImpl: async () => { throw new Error('should not fetch') } }), /缺少 CSRF/)
  await assert.rejects(likeVideo('not-a-bvid', { sessdata: 'cookie', bili_jct: 'csrf' }), /视频编号格式无效/)
  const fetchImpl = async () => new Response(JSON.stringify({ code: -101, message: '账号未登录' }), { status: 200 })
  await assert.rejects(likeVideo('BV1234567890', { sessdata: 'cookie', bili_jct: 'csrf' }, { fetchImpl }), /点赞 BV1234567890 失败：账号未登录/)
})

test('generates QR only for a trusted Bilibili HTTPS login URL', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ code: 0, data: { qrcode_key: 'secret-key', url: 'https://passport.bilibili.com/login?x=1' } }), { status: 200 })
  const result = await beginQrLogin({ fetchImpl, qrcode: { toDataURL: async (url) => `data:image/mock,${url}` } })
  assert.equal(result.key, 'secret-key')
  assert.match(result.image, /^data:image\/mock/)
  const badFetch = async () => new Response(JSON.stringify({ code: 0, data: { qrcode_key: 'k', url: 'https://evil.example/login' } }), { status: 200 })
  await assert.rejects(beginQrLogin({ fetchImpl: badFetch, qrcode: { toDataURL: async () => 'nope' } }), /不是可信 HTTPS/)
})

test('reads video metadata and subtitle without sending cookies to subtitle CDN', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const target = String(url)
    calls.push({ target, options })
    if (target.includes('/x/web-interface/view?')) return new Response(JSON.stringify({ code: 0, data: { cid: 99, title: '标题', desc: '简介', duration: 120, owner: { name: '作者' } } }), { status: 200 })
    if (target.includes('/x/web-interface/nav')) return new Response(JSON.stringify({ code: 0, data: { wbi_img: { img_url: IMG, sub_url: SUB } } }), { status: 200 })
    if (target.includes('/x/player/wbi/v2?')) return new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [{ lan: 'ai-zh', subtitle_url: 'https://aisubtitle.hdslb.com/test.json' }] } } }), { status: 200 })
    if (target.includes('aisubtitle.hdslb.com')) return new Response(JSON.stringify({ body: [{ from: 3, content: '字幕内容' }] }), { status: 200 })
    throw new Error('Unexpected URL')
  }
  const video = await fetchVideoForAnalysis('BV1234567890', { sessdata: 'secret-cookie', bili_jct: 'csrf' }, { fetchImpl })
  assert.equal(video.title, '标题')
  assert.match(video.subtitle, /字幕内容/)
  assert.ok(calls.filter((call) => call.target.includes('api.bilibili.com')).every((call) => call.options.headers.Cookie.includes('secret-cookie')))
  assert.equal(calls.find((call) => call.target.includes('aisubtitle.hdslb.com')).options.headers.Cookie, undefined)
})

test('falls back to the official subtitle web endpoint when WBI has no track', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const target = String(url)
    calls.push({ target, options })
    if (target.includes('/x/web-interface/view?')) return new Response(JSON.stringify({ code: 0, data: { aid: 77, cid: 99, title: '标题', desc: '简介', duration: 120, owner: { name: '作者' } } }), { status: 200 })
    if (target.includes('/x/web-interface/nav')) return new Response(JSON.stringify({ code: 0, data: { wbi_img: { img_url: IMG, sub_url: SUB } } }), { status: 200 })
    if (target.includes('/x/player/wbi/v2?')) return new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] } } }), { status: 200 })
    if (target.includes('/x/v2/subtitle/web/view?')) return new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: '//aisubtitle.hdslb.com/fallback.json' }] } } }), { status: 200 })
    if (target.includes('aisubtitle.hdslb.com/fallback.json')) return new Response(JSON.stringify({ body: [{ from: 12, content: '备用字幕' }] }), { status: 200 })
    throw new Error('Unexpected URL')
  }
  const video = await fetchVideoForAnalysis('BV1234567890', { sessdata: 'cookie', bili_jct: 'csrf' }, { fetchImpl })
  assert.match(video.subtitle, /备用字幕/)
  assert.ok(calls.some((call) => call.target.includes('/x/v2/subtitle/web/view?oid=77&pid=77')))
  assert.equal(calls.find((call) => call.target.includes('fallback.json')).options.headers.Cookie, undefined)
})

test('aborts subtitle streaming when actual bytes exceed the limit', async () => {
  let oversizedRequested = false
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/x/web-interface/view?')) return new Response(JSON.stringify({ code: 0, data: { cid: 99, title: 'large subtitle' } }), { status: 200 })
    if (target.includes('/x/web-interface/nav')) return new Response(JSON.stringify({ code: 0, data: { wbi_img: { img_url: IMG, sub_url: SUB } } }), { status: 200 })
    if (target.includes('/x/player/wbi/v2?')) return new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: 'https://aisubtitle.hdslb.com/large.json' }] } } }), { status: 200 })
    if (target.includes('aisubtitle.hdslb.com/large.json')) {
      oversizedRequested = true
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(900_000))
          controller.enqueue(new Uint8Array(200_000))
          controller.enqueue(new Uint8Array(900_000))
        },
      }), { status: 200 })
    }
    throw new Error('Unexpected URL')
  }
  await assert.rejects(fetchVideoForAnalysis('BV1234567890', { sessdata: 's', bili_jct: 'j' }, { fetchImpl }), /超过 1 MB/)
  assert.equal(oversizedRequested, true)
})

test('returns metadata when both official subtitle list endpoints fail', async () => {
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/x/web-interface/view?')) return new Response(JSON.stringify({ code: 0, data: { aid: 77, cid: 99, title: '无字幕视频' } }), { status: 200 })
    if (target.includes('/x/web-interface/nav')) return new Response(JSON.stringify({ code: 0, data: { wbi_img: { img_url: IMG, sub_url: SUB } } }), { status: 200 })
    if (target.includes('/x/player/wbi/v2?')) return new Response('unavailable', { status: 503 })
    if (target.includes('/x/v2/subtitle/web/view?')) return new Response('unavailable', { status: 503 })
    throw new Error('Unexpected URL')
  }
  const video = await fetchVideoForAnalysis('BV1234567890', { sessdata: 'cookie', bili_jct: 'csrf' }, { fetchImpl })
  assert.equal(video.title, '无字幕视频')
  assert.equal(video.subtitle, '')
})

test('rejects subtitle URLs outside official Bilibili/CDN domains', async () => {
  let count = 0
  const fetchImpl = async (url) => {
    count += 1
    const target = String(url)
    if (target.includes('/x/web-interface/view?')) return new Response(JSON.stringify({ code: 0, data: { cid: 99, title: '标题' } }), { status: 200 })
    if (target.includes('/x/web-interface/nav')) return new Response(JSON.stringify({ code: 0, data: { wbi_img: { img_url: IMG, sub_url: SUB } } }), { status: 200 })
    if (target.includes('/x/player/wbi/v2?')) return new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: 'https://attacker.example/sub.json' }] } } }), { status: 200 })
    throw new Error('Unexpected URL')
  }
  await assert.rejects(fetchVideoForAnalysis('BV1234567890', { sessdata: 's', bili_jct: 'j' }, { fetchImpl }), /不是受信任的 HTTPS 地址/)
  assert.equal(count, 3)
})

test('polls waiting state and only persists complete credentials', async () => {
  const waitingFetch = async () => new Response(JSON.stringify({ code: 0, data: { code: 86101 } }), { status: 200 })
  assert.deepEqual(await pollQrLogin('q', { fetchImpl: waitingFetch }), { state: 'waiting' })

  const okResponse = new Response(JSON.stringify({ code: 0, data: { code: 0 } }), { status: 200 })
  okResponse.headers.getSetCookie = () => ['SESSDATA=s; Path=/', 'bili_jct=j; Path=/']
  assert.deepEqual(await pollQrLogin('q', { fetchImpl: async () => okResponse }), { state: 'ok', credential: { sessdata: 's', bili_jct: 'j' } })

  const incomplete = new Response(JSON.stringify({ code: 0, data: { code: 0 } }), { status: 200 })
  incomplete.headers.getSetCookie = () => ['SESSDATA=s; Path=/']
  assert.deepEqual(await pollQrLogin('q', { fetchImpl: async () => incomplete }), { state: 'error', message: '扫码已确认，但 B站没有返回完整登录凭据。' })
})
