import { createHash, randomUUID } from 'node:crypto'
import { signedWbiQuery } from './bilibili.js'
import { normalizeInteractionContext } from './interaction-context.js'
import { normalizeImageRefs } from './interaction-images.js'
import { cleanDisplayName } from './interaction-identity.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const ROOT = 'https://api.bilibili.com'
const VC = 'https://api.vc.bilibili.com'
// 私信窗口取多少条。
//
// 以前是 20，实测就是「失忆」的直接原因：一条推送私信本身 200–500 字，
// 主人再聊十几句，推送就被挤出窗口；而且接口是「新→旧」返回，
// 旧代码又做了 slice(-20)，等于把最新的一半砍掉、只留下最旧的 20 条。
// 50 条足够覆盖最近几轮推送（实测 20 条里就有 5 条推送私信），
// 上下文另有 20 条 / 4000 字的预算兜底，不会把请求撑大。
export const DM_WINDOW_SIZE = 50

function headers(credential, referer = 'https://www.bilibili.com/') {
  return {
    'User-Agent': UA,
    Referer: referer,
    Cookie: `SESSDATA=${credential.sessdata}; bili_jct=${credential.bili_jct}; buvid3=${credential.buvid3 || ''}`,
  }
}

async function getJson(fetchImpl, url, requestHeaders) {
  const response = await fetchImpl(url, { headers: requestHeaders, redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`B站互动收件箱请求失败（HTTP ${response.status}）。`)
  return response.json()
}

export function interactionEventKey(event) {
  return createHash('sha256').update([event?.source, event?.senderId, event?.timestamp, event?.text, event?.target?.parent, event?.messageKey].map((value) => String(value ?? '')).join('|')).digest('hex')
}

function parseCommentItem(item, kind, selfMid) {
  const senderId = String(item?.user?.mid || '')
  const target = item?.item || {}
  // 只认评论正文：source_content 是触发这条通知的评论（对方说的那句）。
  // target.title 是视频/动态标题，拿它当对方说的话会让回复答非所问，因此不再兜底。
  const text = String(target.source_content || '').replace(/\s+/g, ' ').trim().slice(0, 2000)
  const eventId = String(target.source_id || item?.id || '')
  const sourceId = String(target.source_id || '')
  const rootId = String(target.root_id && String(target.root_id) !== '0' ? target.root_id : sourceId)
  const coords = {
    oid: String(target.subject_id ?? ''),
    root: rootId,
    parent: sourceId,
    business: Number(target.business_id ?? 1),
  }
  if (!eventId || !senderId || senderId === String(selfMid) || !coords.oid || !coords.root || !coords.parent) return null
  return {
    id: `comment:${coords.business}:${coords.oid}:${coords.root}:${coords.parent}`,
    source: 'comments',
    kind,
    senderId,
    senderName: String(item?.user?.nickname || '').slice(0, 80),
    text,
    images: [],
    timestamp: Number(item?.reply_time ?? item?.at_time ?? 0),
    target: coords,
  }
}

// 楼层里的单条评论 → 上下文条目。图片走 content.pictures，纯图片评论也算有效上下文。
function commentContextEntry(reply, selfMid) {
  const isSelf = String(reply?.mid) === String(selfMid)
  const text = String(reply?.content?.message || '').replace(/\s+/g, ' ').trim().slice(0, 2000)
  const images = normalizeImageRefs(reply?.content?.pictures, { max: 4 })
  if (!text && !images.length) return null
  return {
    speaker: isSelf ? 'self' : 'other',
    // 自己那条不记昵称：提示词里只按 我/对方N 区分，避免把自己的昵称当成第三方。
    speakerId: String(reply?.mid || ''),
    name: isSelf ? '' : String(reply?.member?.uname || '').slice(0, 40),
    text,
    images,
    timestamp: Number(reply?.ctime || 0),
  }
}

// 读取这条评论所在楼层的完整对话（含自己和对方的发言），作为回复上下文。
// 楼层里可能有多个人，条目的 speakerId 让上层能给每个发言人分配“对方1/对方2”这样的稳定标签。
async function loadCommentContext(event, selfMid, requestHeaders, fetchImpl) {
  const url = new URL(`${ROOT}/x/v2/reply/reply`)
  url.search = new URLSearchParams({
    type: String(event.target.business),
    oid: event.target.oid,
    root: event.target.root,
    pn: '1',
    ps: '20',
  }).toString()
  const floor = await getJson(fetchImpl, url, requestHeaders)
  const replies = Array.isArray(floor.data?.replies) ? floor.data.replies : []
  const entries = []
  const rootEntry = commentContextEntry(floor.data?.root, selfMid)
  if (rootEntry) entries.push(rootEntry)
  for (const reply of replies) {
    const entry = commentContextEntry(reply, selfMid)
    if (entry) entries.push(entry)
  }
  // 楼层里如果没覆盖到触发评论本身，用通知里的正文补上，避免模型看不到“要回的那句”。
  const triggerText = event.text
  if (triggerText && !entries.some((entry) => entry.text === triggerText)) {
    entries.push({ speaker: 'other', speakerId: event.senderId, name: event.senderName, text: triggerText, images: [], timestamp: event.timestamp })
  }
  return normalizeInteractionContext(entries)
}

export async function fetchCommentTriggers(credential, selfMid, { fetchImpl = fetch } = {}) {
  const requestHeaders = headers(credential)
  const events = []
  const warnings = []
  const diagnostics = { listed: 0, withContext: 0, contextImages: 0 }
  for (const kind of ['reply', 'at']) {
    try {
      const url = new URL(`${ROOT}/x/msgfeed/${kind}`)
      url.search = new URLSearchParams({ platform: 'web', build: '0', mobi_app: 'web' }).toString()
      const response = await getJson(fetchImpl, url, requestHeaders)
      if (response.code !== 0) throw new Error(`code ${response.code}`)
      for (const item of (response.data?.items || []).slice(0, 30)) {
        const event = parseCommentItem(item, kind, selfMid)
        if (!event) continue
        diagnostics.listed += 1
        // 两种通知都尝试读楼层：@ 通知里也可能有多人对话，但动态/专栏楼层接口不一定可用，
        // 失败时退回只有触发评论，绝不拿视频标题或别人的评论顶替。
        try {
          event.context = await loadCommentContext(event, selfMid, requestHeaders, fetchImpl)
          diagnostics.withContext += 1
          if (!event.text) {
            // 通知没给正文时，从楼层上下文里取触发者那条，取不到就跳过这条事件。
            const own = event.context.filter((entry) => entry.speaker === 'other' && entry.text)
            event.text = own.length ? own[own.length - 1].text : ''
          }
        } catch { event.context = [] }
        // 触发的这条评论如果本身带图，图片在 floor 里随正文一起拿到；单独提示一次便于诊断。
        if (event.text) {
          diagnostics.contextImages += (Array.isArray(event.context) ? event.context : [])
            .reduce((sum, entry) => sum + (entry.images?.length || 0), 0)
          events.push(event)
        }
      }
    } catch (error) { warnings.push(`${kind}:${error?.message || 'failed'}`) }
  }
  return { events, warnings, diagnostics }
}

// 私信接口实测是「新→旧」返回，但文档没保证顺序，旧代码又对数组做了 slice(-20)，
// 等于在“新→旧”的响应里砍掉最新的一半。这里统一按时间排序，顺序从此不再影响结果。
export function sortMessagesChronologically(value) {
  const list = Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : []
  return [...list].sort((a, b) => Number(a?.timestamp || 0) - Number(b?.timestamp || 0))
}

function parseDmMessage(message) {
  if (Number(message?.msg_status) !== 0) return null
  const type = Number(message?.msg_type)
  let parsed
  try { parsed = JSON.parse(String(message?.content || '')) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  if (type === 1) {
    const text = String(parsed.content || '').replace(/\s+/g, ' ').trim().slice(0, 2000)
    return text ? { text, images: [] } : null
  }
  // 图片消息（msg_type 2）和自定义表情（msg_type 6）结构相同：url + 宽高。
  if (type === 2 || type === 6) {
    const images = normalizeImageRefs([{ url: parsed.url, width: parsed.width, height: parsed.height }], { max: 4 })
    return images.length ? { text: '', images } : null
  }
  return null
}

// 私信上下文：把拉到的消息全部转成“谁说的 + 内容”，供模型理解前文。
// 自己发的消息只作为上下文，不会成为触发事件。
function dmContextEntry(message, selfMid, talkerName) {
  const senderId = String(message?.sender_uid || '')
  if (!senderId) return null
  const parsed = parseDmMessage(message)
  if (!parsed) return null
  const isSelf = senderId === String(selfMid)
  return {
    speaker: isSelf ? 'self' : 'other',
    speakerId: senderId,
    name: isSelf ? '' : String(talkerName || '').slice(0, 40),
    text: parsed.text,
    images: parsed.images,
    timestamp: Number(message?.timestamp || 0),
  }
}

function dmEvent(session, message, selfMid, talkerName = '') {
  const senderId = String(message?.sender_uid || '')
  const parsed = parseDmMessage(message)
  const talkerId = String(session?.talker_id || '')
  // 纯图片私信也要成为触发事件：以前只认文字，对方发图就等于没发消息。
  if (!talkerId || senderId === String(selfMid) || !senderId || !parsed) return null
  const messageKey = String(message?.msg_seqno ?? message?.msg_key ?? '')
  const timestamp = Number(message?.timestamp || 0)
  const id = messageKey || `${senderId}:${timestamp}:${parsed.text || parsed.images.map((image) => image.url).join(',')}`
  return {
    id: `dm:${talkerId}:${id}`,
    source: 'dm',
    kind: 'message',
    senderId,
    // 昵称只能额外查：用户会话对象里没有 account_info（详见 interaction-identity.js）。
    senderName: cleanDisplayName(talkerName),
    text: parsed.text,
    images: parsed.images,
    timestamp,
    messageKey,
    target: { talkerId, sessionType: 1 },
  }
}

export async function fetchDmTriggers(credential, selfMid, { fetchImpl = fetch, identityDirectory = null } = {}) {
  const requestHeaders = headers(credential, 'https://message.bilibili.com/')
  const sessions = new Map()
  const listedIds = new Set()
  const interceptedIds = new Set()
  const mutedIds = new Set()
  const warnings = []
  const diagnostics = { listedSessions: 0, unreadSessions: 0, interceptedSessions: 0, mutedSessions: 0, fetchedSessions: 0, fetchedMessages: 0, incomingTextMessages: 0, incomingImageMessages: 0, namedSessions: 0 }
  for (const category of [1, 2]) {
    try {
      const url = new URL(`${VC}/session_svr/v1/session_svr/get_sessions`)
      url.search = new URLSearchParams({ session_type: String(category), group_fold: '1', unfollow_fold: '0', sort_rule: '2', size: '100', build: '0', mobi_app: 'web' }).toString()
      const response = await getJson(fetchImpl, url, requestHeaders)
      if (response.code !== 0) throw new Error(`code ${response.code}`)
      for (const session of (response.data?.session_list || [])) {
        if (Number(session.session_type) !== 1 || Number(session.system_msg_type || 0) !== 0) continue
        const talkerId = String(session.talker_id)
        listedIds.add(talkerId)
        if (Number(session.is_intercept || 0) !== 0) { interceptedIds.add(talkerId); continue }
        if (Number(session.is_dnd || 0) !== 0) mutedIds.add(talkerId)
        sessions.set(talkerId, session)
      }
    } catch (error) { warnings.push(`sessions-${category}:${error?.message || 'failed'}`) }
  }
  diagnostics.listedSessions = listedIds.size
  diagnostics.interceptedSessions = interceptedIds.size
  diagnostics.mutedSessions = mutedIds.size

  // 只有“有未读且最后一条不是自己发的”会话才会产生事件，也只需要给这些会话查昵称。
  const pending = [...sessions.values()].filter((session) => Number(session.unread_count || 0) > 0 && String(session.last_msg?.sender_uid || '') !== String(selfMid))
  // 昵称查询失败不能影响收件箱：整段包在 try 里，拿不到就用空名字。
  let names = new Map()
  if (pending.length) {
    try {
      if (identityDirectory?.lookup) {
        names = await identityDirectory.lookup(requestHeaders, pending.map((session) => String(session.talker_id)))
      } else {
        // 没注入目录时（单测、或调用方只想拿原始数据）不额外发请求。
        names = new Map()
      }
    } catch { names = new Map() }
  }
  diagnostics.namedSessions = names.size

  const events = []
  for (const session of pending) {
    diagnostics.unreadSessions += 1
    const talkerName = names.get(String(session.talker_id)) || ''
    try {
      const url = new URL(`${VC}/svr_sync/v1/svr_sync/fetch_session_msgs`)
      url.search = new URLSearchParams({ sender_device_id: '1', talker_id: String(session.talker_id), session_type: '1', size: String(DM_WINDOW_SIZE), build: '0', mobi_app: 'web' }).toString()
      const response = await getJson(fetchImpl, url, requestHeaders)
      if (response.code !== 0) throw new Error(`code ${response.code}`)
      diagnostics.fetchedSessions += 1
      const messages = sortMessagesChronologically(response.data?.messages)
      diagnostics.fetchedMessages += messages.length
      const sessionEvents = messages.map((message) => dmEvent(session, message, selfMid, talkerName)).filter(Boolean)
      diagnostics.incomingTextMessages += sessionEvents.filter((event) => event.text).length
      diagnostics.incomingImageMessages += sessionEvents.filter((event) => !event.text && event.images.length).length
      if (!sessionEvents.length) continue
      const trigger = sessionEvents.sort((a, b) => b.timestamp - a.timestamp)[0]
      // 触发消息之前的消息（含自己发的）作为历史上下文；按时间过滤而不是依赖接口返回顺序，
      // 这样无论 B站返回的是正序还是倒序，拿到的都是同一段前文。
      const history = []
      for (const message of messages) {
        const key = String(message?.msg_seqno ?? message?.msg_key ?? '')
        if (trigger.messageKey && key === trigger.messageKey) continue
        if (Number(message?.timestamp || 0) > trigger.timestamp) continue
        const entry = dmContextEntry(message, selfMid, talkerName)
        if (entry) history.push(entry)
      }
      trigger.context = normalizeInteractionContext(history)
      events.push(trigger)
    } catch (error) { warnings.push(`dm-${String(session.talker_id).slice(0, 16)}:${error?.message || 'failed'}`) }
  }
  return { events: events.sort((a, b) => a.timestamp - b.timestamp), warnings, diagnostics }
}

function classifySendFailure(code, message) {
  const detail = String(message || '').slice(0, 100)
  if (Number(code) === 21007) return new Error('B站私信超过长度限制（code 21007），已取消发送。')
  // 21037：私信图片只接受 B站图床地址。上传成功但这里报错，说明图床域名不被接受。
  if (Number(code) === 21037) return new Error('B站不接受这张图片（code 21037），可能图床地址不合法，已跳过配图。')
  if ([-509, 12015, 12051].includes(Number(code)) || /验证码|风控|频繁|captcha|risk|too frequent/i.test(detail)) {
    return new Error(`B站触发风控或验证（code ${code}），互动已暂停。`)
  }
  return new Error(`B站发送失败（code ${code}）：${detail || '未知错误'}`)
}

// 把本地图片传到 B站图床，拿到私信图片消息要求的 url。
//
// 用动态图片上传接口（文档化的那个）：私信图片的 content.url 必须是 B站图床地址，
// 否则发出去会返回 21037。上传本身不产生任何动态，只是把字节存进图床。
export async function uploadImageToBilibili(credential, { bytes, fileName, contentType = 'image/jpeg' }, { fetchImpl = fetch } = {}) {
  if (!bytes?.byteLength) throw new Error('图片内容为空，拒绝上传。')
  const csrf = String(credential?.bili_jct || '')
  if (!csrf) throw new Error('缺少 CSRF 凭据，拒绝上传图片。')
  const form = new FormData()
  // 用 Blob 包一层，Node/Electron 的 FormData 才会按文件上传处理。
  form.append('file_up', new Blob([bytes], { type: contentType }), String(fileName || 'image.jpg'))
  form.append('category', 'daily')
  form.append('csrf', csrf)
  const response = await fetchImpl(`${ROOT}/x/dynamic/feed/draw/upload_bfs`, {
    method: 'POST',
    // Content-Type 交给 FormData 自己带 boundary，不能手写。
    headers: { ...headers(credential), Origin: 'https://www.bilibili.com' },
    body: form,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  let result
  try { result = await response.json() }
  catch { throw new Error(`B站图片上传返回了非 JSON 响应（HTTP ${response.status}）。`) }
  if (!response.ok || result.code !== 0) throw classifySendFailure(result.code ?? response.status, result.message)
  const url = String(result.data?.image_url || '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('B站图片上传没有返回可用的图片地址。')
  return {
    url: url.replace(/^http:\/\//i, 'https://'),
    width: Number(result.data?.image_width) || 0,
    height: Number(result.data?.image_height) || 0,
    // 文档里 img_size 的单位是 KB。
    sizeKb: Number(result.data?.img_size) || 0,
  }
}

export async function sendCommentReply(credential, event, text, { fetchImpl = fetch } = {}) {
  if (event?.source !== 'comments' || !event.target?.oid || !event.target?.root || !event.target?.parent || !/^\d+$/.test(String(event.target.business))) {
    throw new Error('评论回复坐标无效，拒绝发送。')
  }
  const requestHeaders = headers(credential)
  const nav = await getJson(fetchImpl, `${ROOT}/x/web-interface/nav`, requestHeaders)
  if (nav.code !== 0 || !nav.data?.wbi_img?.img_url || !nav.data?.wbi_img?.sub_url) throw new Error('无法确认登录态或评论签名，拒绝发送。')
  const params = {
    type: String(event.target.business),
    oid: String(event.target.oid),
    message: text,
    plat: '1',
    csrf: String(credential.bili_jct),
    root: String(event.target.root),
    parent: String(event.target.parent),
  }
  const signed = new URLSearchParams(signedWbiQuery(params, nav.data.wbi_img.img_url, nav.data.wbi_img.sub_url))
  const query = new URLSearchParams({ w_rid: signed.get('w_rid'), wts: signed.get('wts') })
  const response = await fetchImpl(`${ROOT}/x/v2/reply/add?${query}`, {
    method: 'POST',
    headers: { ...requestHeaders, Origin: 'https://www.bilibili.com', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  const result = await response.json()
  if (!response.ok || result.code !== 0) throw classifySendFailure(result.code ?? response.status, result.message)
  const replyData = result.data?.reply || {}
  return {
    sent: true,
    id: String(result.data?.rpid_str ?? result.data?.rpid ?? ''),
    state: Number.isInteger(replyData.state) ? replyData.state : null,
    oid: String(replyData.oid ?? event.target.oid),
    root: String(replyData.root_str ?? replyData.root ?? event.target.root),
    parent: String(replyData.parent_str ?? replyData.parent ?? event.target.parent),
  }
}

// 主动私信（报告投递）不依赖会话事件，只校验发件人与收件人 UID。
export async function sendPrivateMessageTo(credential, senderUid, receiverUid, text, { fetchImpl = fetch } = {}) {
  if (!/^\d{1,20}$/.test(String(senderUid || ''))) throw new Error('私信发件人 UID 无效，拒绝发送。')
  if (!/^\d{1,20}$/.test(String(receiverUid || ''))) throw new Error('私信收件人 UID 无效，拒绝发送。')
  const body = String(text || '').trim()
  if (!body) throw new Error('私信正文为空，拒绝发送。')
  if (body.length > 500) throw new Error('私信正文超过 500 个字符，拒绝发送。')
  return postDmMessage(credential, {
    senderUid,
    receiverUid,
    msgType: 1,
    content: { content: body },
    fetchImpl,
  })
}

// 私信图片消息（msg_type=2）。url 必须是 B站图床地址，见 uploadImageToBilibili。
export async function sendPrivateImage(credential, senderUid, receiverUid, image, { fetchImpl = fetch } = {}) {
  if (!/^\d{1,20}$/.test(String(senderUid || ''))) throw new Error('私信发件人 UID 无效，拒绝发送。')
  if (!/^\d{1,20}$/.test(String(receiverUid || ''))) throw new Error('私信收件人 UID 无效，拒绝发送。')
  const url = String(image?.url || '').trim()
  if (!/^https:\/\/[^\s]+$/i.test(url)) throw new Error('图片地址无效，拒绝发送。')
  // 文档建议带上宽高，否则消息可能显示异常；拿不到就省略而不是填 0。
  const content = { url }
  if (Number(image.width) > 0) content.width = Number(image.width)
  if (Number(image.height) > 0) content.height = Number(image.height)
  if (Number(image.sizeKb) > 0) content.size = Number(image.sizeKb)
  if (image.imageType) content.imageType = String(image.imageType).slice(0, 20)
  return postDmMessage(credential, { senderUid, receiverUid, msgType: 2, content, fetchImpl })
}

async function postDmMessage(credential, { senderUid, receiverUid, msgType, content, fetchImpl = fetch }) {
  const payload = {
    'msg[sender_uid]': String(senderUid),
    'msg[receiver_id]': String(receiverUid),
    'msg[receiver_type]': '1',
    'msg[msg_type]': String(msgType),
    'msg[msg_status]': '0',
    'msg[dev_id]': randomUUID().toUpperCase(),
    'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
    'msg[content]': JSON.stringify(content),
    csrf: String(credential.bili_jct),
  }
  const response = await fetchImpl(`${VC}/web_im/v1/web_im/send_msg`, {
    method: 'POST',
    headers: { ...headers(credential, 'https://message.bilibili.com/'), Origin: 'https://message.bilibili.com', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(payload),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  })
  const result = await response.json()
  if (!response.ok || result.code !== 0) throw classifySendFailure(result.code ?? response.status, result.message)
  return { sent: true, id: String(result.data?.msg_key ?? ''), msgType }
}

export async function sendPrivateMessage(credential, senderMid, event, text, options = {}) {
  if (event?.source !== 'dm' || !event.target?.talkerId || !/^\d+$/.test(String(event.target.talkerId))) throw new Error('私信会话坐标无效，拒绝发送。')
  return sendPrivateMessageTo(credential, senderMid, event.target.talkerId, text, options)
}

export async function sendPrivateImageToTalker(credential, senderMid, event, image, options = {}) {
  if (event?.source !== 'dm' || !event.target?.talkerId || !/^\d+$/.test(String(event.target.talkerId))) throw new Error('私信会话坐标无效，拒绝发送。')
  return sendPrivateImage(credential, senderMid, event.target.talkerId, image, options)
}
