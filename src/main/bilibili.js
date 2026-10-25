import { createHash } from 'node:crypto'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const QR_GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const QR_POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
const NAV = 'https://api.bilibili.com/x/web-interface/nav'
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi'
const SEARCH = 'https://api.bilibili.com/x/web-interface/wbi/search/type'
const LIKE_VIDEO = 'https://api.bilibili.com/x/web-interface/archive/like'
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]

async function readLimitedText(response, maxBytes) {
  const announcedLength = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(announcedLength) && announcedLength > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new Error('字幕文件超过 1 MB 限制。')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error('字幕文件超过 1 MB 限制。')
      }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, total).toString('utf8')
}

async function getJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), ...options })
  if (!response.ok) throw new Error(`B站请求失败（HTTP ${response.status}）。`)
  return response.json()
}

function keyOf(url) {
  const name = String(url || '').slice(String(url || '').lastIndexOf('/') + 1)
  return name.replace(/\.[^.]*$/, '')
}

export function pickLoginCookies(setCookieHeaders = []) {
  const wanted = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid', buvid3: 'buvid3' }
  const result = {}
  for (const header of setCookieHeaders) {
    const pair = String(header).split(';', 1)[0]
    const split = pair.indexOf('=')
    if (split <= 0) continue
    const key = pair.slice(0, split).trim()
    if (wanted[key]) result[wanted[key]] = pair.slice(split + 1).trim()
  }
  return result
}

export function signedWbiQuery(params, imgUrl, subUrl, nowSeconds = Math.floor(Date.now() / 1000)) {
  const raw = keyOf(imgUrl) + keyOf(subUrl)
  if (raw.length < 64) throw new Error('B站 WBI 签名密钥格式异常。')
  const mixin = MIXIN_TAB.map((index) => raw[index]).join('').slice(0, 32)
  const all = { ...params, wts: nowSeconds }
  const query = Object.keys(all).sort().map((key) => {
    const value = String(all[key]).replace(/[!'()*]/g, '')
    return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
  }).join('&')
  const signature = createHash('md5').update(query + mixin).digest('hex')
  return `${query}&w_rid=${signature}`
}

function cleanText(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
}

export function normalizeSearchResults(data) {
  const results = Array.isArray(data?.result) ? data.result : Array.isArray(data?.results) ? data.results : []
  return results.slice(0, 10).map((item) => {
    const timestamp = Number(item?.pubdate)
    const publishedAt = Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8_640_000_000_000
      ? new Date(timestamp * 1000).toISOString()
      : ''
    return {
      bvid: String(item?.bvid || '').slice(0, 20),
      title: cleanText(item?.title).slice(0, 300),
      author: cleanText(item?.author).slice(0, 120),
      description: cleanText(item?.description).slice(0, 500),
      play: String(item?.play ?? '').slice(0, 32),
      duration: String(item?.duration ?? '').slice(0, 32),
      publishedAt,
      url: item?.bvid ? `https://www.bilibili.com/video/${encodeURIComponent(String(item.bvid).slice(0, 20))}/` : '',
    }
  }).filter((item) => item.bvid && item.title)
}

export async function beginQrLogin({ fetchImpl = fetch, qrcode }) {
  const data = await getJson(fetchImpl, QR_GENERATE, { headers: { 'User-Agent': UA } })
  if (data.code !== 0 || !data.data?.qrcode_key || !data.data?.url) throw new Error(`生成 B 站二维码失败：${data.message || '响应数据不完整'}`)
  const loginUrl = new URL(data.data.url)
  if (loginUrl.protocol !== 'https:' || !loginUrl.hostname.endsWith('.bilibili.com')) throw new Error('B站返回的登录链接不是可信 HTTPS 地址。')
  const image = await qrcode.toDataURL(loginUrl.href, { errorCorrectionLevel: 'M', margin: 1, width: 280 })
  return { key: String(data.data.qrcode_key), image }
}

export async function pollQrLogin(key, { fetchImpl = fetch } = {}) {
  const url = new URL(QR_POLL)
  url.searchParams.set('qrcode_key', key)
  url.searchParams.set('source', 'main-fe-header')
  const response = await fetchImpl(url, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`扫码状态请求失败（HTTP ${response.status}）。`)
  const payload = await response.json()
  const code = payload?.data?.code
  if (code === 86101) return { state: 'waiting' }
  if (code === 86090) return { state: 'scanned' }
  if (code === 86038) return { state: 'expired' }
  if (code !== 0) return { state: 'error', message: String(payload?.message || 'B站返回未知扫码状态。') }
  const cookies = pickLoginCookies(response.headers.getSetCookie?.() ?? [])
  if (!cookies.sessdata || !cookies.bili_jct) return { state: 'error', message: '扫码已确认，但 B站没有返回完整登录凭据。' }
  if (!cookies.buvid3) {
    try {
      const spi = await getJson(fetchImpl, SPI, { headers: { 'User-Agent': UA } })
      cookies.buvid3 = String(spi?.data?.b_3 || '')
    } catch { /* buvid3 is optional for the read-only endpoints used here */ }
  }
  return { state: 'ok', credential: cookies }
}

export async function getAccountStatus(credential, { fetchImpl = fetch } = {}) {
  const data = await getJson(fetchImpl, NAV, { headers: { 'User-Agent': UA, Cookie: cookieHeader(credential) } })
  if (data.code !== 0 || !data.data?.isLogin) return { loggedIn: false }
  return { loggedIn: true, name: cleanText(data.data.uname), mid: String(data.data.mid || '') }
}

function cookieHeader(credential) {
  return `SESSDATA=${credential.sessdata}; bili_jct=${credential.bili_jct}; buvid3=${credential.buvid3 || ''}`
}

// 图片下载需要同一份登录态（部分会话图片匿名取会 403），导出给主进程复用，
// 避免两处各拼一份 Cookie 字符串、字段名改了还漏改一处。
export function bilibiliCookieHeader(credential) {
  return credential ? cookieHeader(credential) : ''
}

export async function fetchVideoForAnalysis(bvid, credential, { fetchImpl = fetch } = {}) {
  const id = String(bvid || '')
  if (!/^BV[0-9A-Za-z]{10}$/.test(id)) throw new Error('视频编号格式无效。')
  const headers = {
    'User-Agent': UA,
    Referer: `https://www.bilibili.com/video/${id}/`,
    Cookie: cookieHeader(credential),
  }
  const viewUrl = new URL('https://api.bilibili.com/x/web-interface/view')
  viewUrl.searchParams.set('bvid', id)
  const view = await getJson(fetchImpl, viewUrl, { headers })
  if (view.code !== 0 || !view.data?.cid) throw new Error(`读取 ${id} 视频信息失败：${String(view.message || view.code || '响应数据缺失').slice(0, 100)}`)

  const nav = await getJson(fetchImpl, NAV, { headers })
  const img = nav?.data?.wbi_img?.img_url
  const sub = nav?.data?.wbi_img?.sub_url
  if (nav.code !== 0 || !img || !sub) throw new Error('无法获取 B站字幕读取所需的签名信息。')
  const chooseTrack = (tracks) => {
    if (!Array.isArray(tracks)) return null
    return tracks.find((item) => item.lan === 'ai-zh')
      ?? tracks.find((item) => item.lan === 'zh-CN')
      ?? tracks.find((item) => String(item.lan || '').startsWith('zh'))
      ?? tracks[0]
      ?? null
  }
  let track = null
  try {
    const playerUrl = new URL('https://api.bilibili.com/x/player/wbi/v2')
    playerUrl.search = signedWbiQuery({ bvid: id, cid: view.data.cid }, img, sub)
    const player = await getJson(fetchImpl, playerUrl, { headers })
    track = chooseTrack(player?.data?.subtitle?.subtitles)
  } catch { /* try the official subtitle web endpoint below */ }
  if (!track) {
    try {
      const subtitleViewUrl = new URL('https://api.bilibili.com/x/v2/subtitle/web/view')
      subtitleViewUrl.search = new URLSearchParams({
        oid: String(view.data.aid || ''),
        pid: String(view.data.aid || ''),
        context_ext: JSON.stringify({ video_type: 1 }),
        type: '1',
        cur_production_type: '0',
        preferred_language: 'ai-zh',
        playlist_switch: '0',
      }).toString()
      const subtitleView = await getJson(fetchImpl, subtitleViewUrl, { headers })
      track = chooseTrack(subtitleView?.data?.subtitle?.subtitles)
    } catch { /* metadata remains useful even if both subtitle endpoints are unavailable */ }
  }
  let subtitle = ''
  if (track?.subtitle_url) {
    const subtitleUrl = new URL(String(track.subtitle_url).startsWith('//') ? `https:${track.subtitle_url}` : track.subtitle_url)
    const host = subtitleUrl.hostname
    const trustedHost = host.endsWith('.hdslb.com') || host.endsWith('.bilivideo.com') || host.endsWith('.bilibili.com')
    if (subtitleUrl.protocol !== 'https:' || !trustedHost) throw new Error('B站字幕地址不是受信任的 HTTPS 地址。')
    const response = await fetchImpl(subtitleUrl, { headers: { 'User-Agent': UA, Referer: `https://www.bilibili.com/video/${id}/` }, redirect: 'error', signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`下载 ${id} 字幕失败（HTTP ${response.status}）。`)
    const raw = await readLimitedText(response, 1_000_000)
    let body
    try { body = JSON.parse(raw)?.body } catch { throw new Error('B站字幕格式无法解析。') }
    if (Array.isArray(body)) subtitle = body.slice(0, 2500).map((line) => {
      const seconds = Math.max(0, Math.floor(Number(line.from) || 0))
      const stamp = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
      return `[${stamp}] ${cleanText(line.content).slice(0, 500)}`
    }).join('\n').slice(0, 40_000)
  }

  return {
    bvid: id,
    title: cleanText(view.data.title).slice(0, 300),
    author: cleanText(view.data.owner?.name).slice(0, 120),
    description: cleanText(view.data.desc).slice(0, 2000),
    duration: String(view.data.duration ?? ''),
    // 权威发布时间：候选列表里偶尔缺 pubdate，详情接口一定有。
    publishedAt: Number(view.data.pubdate) > 0 ? new Date(Number(view.data.pubdate) * 1000).toISOString() : '',
    subtitle,
  }
}

// 点赞：写操作，必须带登录态和 CSRF。
//
// **不再在推送时自动调用**。以前自动读取会在报告落盘后顺手给选中的 3 条点赞，
// 导致主人不喜欢的视频也被点赞。现在只在主人于私信里明确要求时执行，
// 且 BV 必须先通过推送台账校验（见 interaction-actions.js）。
// 65006 = 重复点赞，对用户来说就是“已经赞过了”，按成功处理。
export async function likeVideo(bvid, credential, { fetchImpl = fetch } = {}) {
  const id = String(bvid || '')
  if (!/^BV[0-9A-Za-z]{10}$/.test(id)) throw new Error('视频编号格式无效。')
  const csrf = String(credential?.bili_jct || '')
  if (!csrf) throw new Error('缺少 CSRF 凭据，拒绝点赞。')
  const response = await fetchImpl(LIKE_VIDEO, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: `https://www.bilibili.com/video/${id}/`,
      Origin: 'https://www.bilibili.com',
      Cookie: cookieHeader(credential),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ bvid: id, like: '1', csrf }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  let result
  try { result = await response.json() }
  catch { throw new Error(`点赞 ${id} 返回了非 JSON 响应（HTTP ${response.status}）。`) }
  // 65006：重复点赞。主人此前手动赞过、或台账没记上，都按“已点赞”处理。
  if (Number(result.code) === 65006) return { liked: true, already: true, bvid: id }
  if (!response.ok || result.code !== 0) {
    throw new Error(`点赞 ${id} 失败：${String(result.message || `HTTP ${response.status}`).slice(0, 100)}`)
  }
  return { liked: true, already: false, bvid: id }
}

// 收藏：`add_media_ids` 是收藏夹 id（mlid），不是 BV。所以先读主人的默认收藏夹。
// 这一步是只读的，拿不到默认收藏夹就拒绝收藏，而不是随便挑一个夹子往里塞。
export async function fetchDefaultFavoriteFolder(credential, { fetchImpl = fetch } = {}) {
  const url = new URL('https://api.bilibili.com/x/v3/fav/folder/created/list-all')
  url.searchParams.set('up_mid', String(credential?.mid || ''))
  const data = await getJson(fetchImpl, url, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: cookieHeader(credential) },
  })
  if (data.code !== 0) throw new Error(`读取收藏夹失败：${String(data.message || data.code).slice(0, 80)}`)
  const folders = Array.isArray(data.data?.list) ? data.data.list : []
  // B站 的“默认收藏夹”排在第一位，attr=0 表示普通收藏夹（非私密/非默认以外）。
  // 拿不到任何可用收藏夹就拒绝，不猜一个夹子往里塞。
  const usable = folders.filter((folder) => /^\d+$/.test(String(folder?.id ?? '')))
  const folder = usable.find((item) => Number(item?.attr ?? 0) === 0) || usable[0]
  if (!folder) throw new Error('没有找到可用的默认收藏夹，收藏已跳过。')
  return { id: String(folder.id), title: String(folder.title || '').slice(0, 60) }
}

// 收藏视频：`/x/v3/fav/resource/deal`，`rid` 要 avid，所以先从 BV 换 avid。
export async function favoriteVideo(bvid, credential, { fetchImpl = fetch, folderId = '' } = {}) {
  const id = String(bvid || '')
  if (!/^BV[0-9A-Za-z]{10}$/.test(id)) throw new Error('视频编号格式无效。')
  const csrf = String(credential?.bili_jct || '')
  if (!csrf) throw new Error('缺少 CSRF 凭据，拒绝收藏。')
  const headers = {
    'User-Agent': UA,
    Referer: `https://www.bilibili.com/video/${id}/`,
    Cookie: cookieHeader(credential),
  }
  const viewUrl = new URL('https://api.bilibili.com/x/web-interface/view')
  viewUrl.searchParams.set('bvid', id)
  const view = await getJson(fetchImpl, viewUrl, { headers })
  const aid = Number(view?.data?.aid)
  if (view.code !== 0 || !Number.isFinite(aid) || aid <= 0) throw new Error(`读取 ${id} 的 avid 失败，收藏已取消。`)
  let mediaId = String(folderId || '')
  if (!/^\d+$/.test(mediaId)) {
    const folder = await fetchDefaultFavoriteFolder({ ...credential, mid: credential?.mid }, { fetchImpl })
    mediaId = folder.id
  }
  const response = await fetchImpl('https://api.bilibili.com/x/v3/fav/resource/deal', {
    method: 'POST',
    headers: {
      ...headers,
      Origin: 'https://www.bilibili.com',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ rid: String(aid), type: '2', add_media_ids: mediaId, del_media_ids: '', csrf }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  let result
  try { result = await response.json() }
  catch { throw new Error(`收藏 ${id} 返回了非 JSON 响应（HTTP ${response.status}）。`) }
  // 11201 = 已经收藏过了：对用户来说是“已经是收藏状态”，不算失败。
  if (!response.ok || (result.code !== 0 && Number(result.code) !== 11201)) {
    throw new Error(`收藏 ${id} 失败：${String(result.message || `HTTP ${response.status}`).slice(0, 100)}`)
  }
  return { favorited: true, already: Number(result.code) === 11201, bvid: id, mediaId }
}

export async function fetchFollowingVideos(credential, { fetchImpl = fetch } = {}) {
  const endpoint = new URL('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all')
  endpoint.search = new URLSearchParams({ type: 'video', page: '1' }).toString()
  const payload = await getJson(fetchImpl, endpoint, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: cookieHeader(credential) },
  })
  if (payload.code !== 0) throw new Error(`关注动态读取失败（${payload.code}）。`)
  const items = Array.isArray(payload.data?.items) ? payload.data.items : []
  // 只保留被关注 UP 主自己的投稿；转发卡片的作者是转发者，视频内容并不是他做的。
  return items.filter((entry) => entry?.type !== 'DYNAMIC_TYPE_FORWARD').slice(0, 20).map((entry) => {
    const author = entry?.modules?.module_author
    const archive = entry?.modules?.module_dynamic?.major?.archive
    const duration = String(archive?.duration_text || '')
    const parts = duration.split(':').map(Number)
    const seconds = parts.length === 2 ? parts[0] * 60 + parts[1] : parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : 0
    return {
      bvid: String(archive?.bvid || ''),
      title: cleanText(archive?.title).slice(0, 300),
      author: cleanText(author?.name).slice(0, 120),
      description: cleanText(archive?.desc).slice(0, 500),
      play: String(archive?.stat?.play ?? ''),
      duration: seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : duration,
      publishedAt: Number(author?.pub_ts) > 0 ? new Date(Number(author.pub_ts) * 1000).toISOString() : '',
      url: archive?.bvid ? `https://www.bilibili.com/video/${encodeURIComponent(archive.bvid)}/` : '',
      source: '关注动态',
      followed: true,
    }
  }).filter((item) => /^BV[0-9A-Za-z]{10}$/.test(item.bvid) && item.title)
}

export async function fetchHomepageVideos(credential, { fetchImpl = fetch } = {}) {
  const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: cookieHeader(credential) }
  const nav = await getJson(fetchImpl, NAV, { headers })
  const img = nav?.data?.wbi_img?.img_url
  const sub = nav?.data?.wbi_img?.sub_url
  if (nav.code !== 0 || !img || !sub) throw new Error('无法获取首页推荐签名信息。')
  const endpoint = new URL('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd')
  endpoint.search = signedWbiQuery({
    fresh_type: 4,
    ps: 12,
    fresh_idx: 1,
    fresh_idx_1h: 1,
    fetch_row: 1,
    web_location: 1430650,
    feed_version: 'V8',
    homepage_ver: 1,
  }, img, sub)
  const payload = await getJson(fetchImpl, endpoint, { headers })
  if (payload.code !== 0) throw new Error(`首页推荐读取失败（${payload.code}）。`)
  const items = Array.isArray(payload.data?.item) ? payload.data.item : []
  return items.filter((entry) => entry?.goto === 'av' && entry?.show_info !== 0 && !entry?.business_info?.is_ad_loc && !entry?.is_stock)
    .slice(0, 20).map((entry) => ({
      bvid: String(entry.bvid || ''),
      title: cleanText(entry.title).slice(0, 300),
      author: cleanText(entry.owner?.name).slice(0, 120),
      description: '',
      play: String(entry.stat?.view ?? ''),
      duration: String(entry.duration ?? ''),
      publishedAt: Number(entry.pubdate) > 0 ? new Date(Number(entry.pubdate) * 1000).toISOString() : '',
      url: entry.bvid ? `https://www.bilibili.com/video/${encodeURIComponent(entry.bvid)}/` : '',
      source: '首页推荐',
    })).filter((item) => /^BV[0-9A-Za-z]{10}$/.test(item.bvid) && item.title)
}

export async function discoverVideos(keyword, credential, { fetchImpl = fetch, page = 1, sources = ['keyword'] } = {}) {
  const selected = new Set(Array.isArray(sources) ? sources : ['keyword'])
  if (![...selected].every((source) => ['keyword', 'following', 'homepage'].includes(source))) throw new Error('视频来源选项无效。')
  const tasks = []
  if (selected.has('keyword')) tasks.push({ key: 'keyword', run: () => searchVideos(keyword, credential, { fetchImpl, page }).then((result) => ({ key: 'keyword', items: result.items, pagination: result })) })
  if (page === 1 && selected.has('following')) tasks.push({ key: 'following', run: () => fetchFollowingVideos(credential, { fetchImpl }).then((items) => ({ key: 'following', items })) })
  if (page === 1 && selected.has('homepage')) tasks.push({ key: 'homepage', run: () => fetchHomepageVideos(credential, { fetchImpl }).then((items) => ({ key: 'homepage', items })) })
  if (tasks.length === 0) throw new Error('至少选择一个视频来源。')
  const settled = await Promise.allSettled(tasks.map((task) => task.run()))
  const successful = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value)
  const failedSources = settled.flatMap((result, index) => result.status === 'rejected' ? [tasks[index].key] : [])
  if (successful.length === 0) throw settled.find((result) => result.status === 'rejected')?.reason ?? new Error('所有视频来源均不可用。')
  const seen = new Set()
  const items = []
  for (const sourceResult of successful) {
    for (const item of sourceResult.items) {
      if (seen.has(item.bvid)) continue
      seen.add(item.bvid)
      items.push({ ...item, source: item.source || (sourceResult.key === 'keyword' ? '关键词' : sourceResult.key) })
    }
  }
  const keywordResult = successful.find((result) => result.pagination)?.pagination
  return {
    items: items.slice(0, 50),
    page,
    totalPages: keywordResult?.totalPages ?? null,
    hasNext: Boolean(keywordResult?.hasNext),
    sourceWarnings: failedSources,
  }
}

export async function searchVideos(keyword, credential, { fetchImpl = fetch, page = 1 } = {}) {
  const term = String(keyword || '').trim()
  const pageNumber = Number(page)
  if (!term || term.length > 80) throw new Error('请输入 1 到 80 个字符的关键词。')
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 50) throw new Error('搜索页码必须在 1 到 50 之间。')
  const headers = { 'User-Agent': UA, Referer: 'https://search.bilibili.com/', Cookie: cookieHeader(credential) }
  const nav = await getJson(fetchImpl, NAV, { headers })
  const img = nav?.data?.wbi_img?.img_url
  const sub = nav?.data?.wbi_img?.sub_url
  if (nav.code !== 0 || !img || !sub) throw new Error('无法获取 B站搜索签名信息，请稍后再试。')
  const query = signedWbiQuery({ search_type: 'video', keyword: term, page: pageNumber }, img, sub)
  const endpoint = new URL(SEARCH)
  endpoint.search = query
  const result = await getJson(fetchImpl, endpoint, { headers })
  if (result.code !== 0) throw new Error(`B站搜索失败（${result.code}）：${String(result.message || '未知错误').slice(0, 120)}`)
  const items = normalizeSearchResults(result.data)
  const totalPages = Number(result.data?.numPages)
  const hasNext = Number.isFinite(totalPages) && totalPages > 0 ? pageNumber < totalPages : items.length === 10
  return { items, page: pageNumber, totalPages: Number.isFinite(totalPages) && totalPages > 0 ? Math.min(50, totalPages) : null, hasNext }
}
