import test from 'node:test'
import assert from 'node:assert/strict'
import { DM_WINDOW_SIZE, fetchCommentTriggers, fetchDmTriggers, sendCommentReply, sendPrivateImage, sendPrivateImageToTalker, sendPrivateMessage, sendPrivateMessageTo, sortMessagesChronologically, uploadImageToBilibili } from '../src/main/interaction-bilibili.js'

const IMG = `https://i0.hdslb.com/bfs/wbi/${'a'.repeat(32)}.png`
const SUB = `https://i0.hdslb.com/bfs/wbi/${'b'.repeat(32)}.png`

const credential = { sessdata: 'session', bili_jct: 'csrf', buvid3: 'device' }
const response = (data) => new Response(JSON.stringify({ code: 0, data }), { status: 200 })

test('reads only incoming private text and returns one newest event per session', async () => {
  const urls = []
  const fetchImpl = async (url, options) => {
    const target = String(url)
    urls.push({ target, options })
    if (target.includes('/get_sessions')) return response({ session_list: [
      { session_type: 1, talker_id: 42, unread_count: 2, account_info: { name: '对方' }, last_msg: { sender_uid: 42 } },
      { session_type: 1, talker_id: 44, unread_count: 1, is_dnd: 1, account_info: { name: '免打扰联系人' }, last_msg: { sender_uid: 44 } },
      { session_type: 1, talker_id: 45, unread_count: 1, is_intercept: 1, account_info: { name: '拦截联系人' }, last_msg: { sender_uid: 45 } },
    ] })
    if (target.includes('/fetch_session_msgs')) {
      const talkerId = new URL(target).searchParams.get('talker_id')
      const sender = talkerId === '44' ? '44' : '42'
      return response({ messages: [
        { msg_type: 1, msg_status: 0, sender_uid: sender, msg_seqno: 1, timestamp: 10, content: JSON.stringify({ content: `最新来信-${sender}` }) },
      ] })
    }
    throw new Error(`Unexpected URL: ${target}`)
  }
  const inbox = await fetchDmTriggers(credential, '7', { fetchImpl })
  assert.equal(inbox.events.length, 2)
  assert.deepEqual(inbox.events.map((event) => event.senderId).sort(), ['42', '44'])
  assert.equal(inbox.diagnostics.listedSessions, 3)
  assert.equal(inbox.diagnostics.unreadSessions, 2)
  assert.equal(inbox.diagnostics.interceptedSessions, 1)
  assert.equal(inbox.diagnostics.mutedSessions, 1)
  assert.equal(inbox.diagnostics.incomingTextMessages, 2)
  assert.equal(inbox.events.find((event) => event.senderId === '44').target.talkerId, '44')
  assert.ok(urls.every(({ options }) => options.method === undefined))
  assert.ok(urls.every(({ options }) => options.headers.Cookie.includes('session')))
})

test('attaches the earlier DM exchange as context, marking my own replies', async () => {
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/get_sessions')) return response({ session_list: [
      // 真实响应里用户会话没有 account_info（那是系统会话才有的字段），昵称必须另外查。
      { session_type: 1, talker_id: 42, unread_count: 2, account_info: null, last_msg: { sender_uid: 42 } },
    ] })
    if (target.includes('/fetch_session_msgs')) return response({ messages: [
      { msg_type: 1, msg_status: 0, sender_uid: 42, msg_seqno: 1, timestamp: 10, content: JSON.stringify({ content: '这个视频讲了什么？' }) },
      { msg_type: 1, msg_status: 0, sender_uid: 7, msg_seqno: 2, timestamp: 20, content: JSON.stringify({ content: '讲了字幕抓取和筛选。' }) },
      { msg_type: 1, msg_status: 0, sender_uid: 42, msg_seqno: 3, timestamp: 30, content: JSON.stringify({ content: '那第二点呢？' }) },
    ] })
    throw new Error(`Unexpected URL: ${target}`)
  }
  const identityDirectory = { lookup: async () => new Map([['42', '对方']]) }
  const inbox = await fetchDmTriggers(credential, '7', { fetchImpl, identityDirectory })
  assert.equal(inbox.events.length, 1)
  const [event] = inbox.events
  // 触发的是最新那条，且触发消息本身不进上下文。
  assert.equal(event.text, '那第二点呢？')
  assert.equal(event.senderName, '对方')
  assert.deepEqual(event.context.map((entry) => entry.speaker), ['other', 'self'])
  assert.deepEqual(event.context.map((entry) => entry.text), ['这个视频讲了什么？', '讲了字幕抓取和筛选。'])
  assert.equal(event.context[0].name, '对方')
  assert.equal(event.context[1].name, '')
  assert.equal(inbox.diagnostics.namedSessions, 1)
})

test('does not invent a nickname when the identity lookup finds nothing', async () => {
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/get_sessions')) return response({ session_list: [
      { session_type: 1, talker_id: 42, unread_count: 1, last_msg: { sender_uid: 42 } },
    ] })
    if (target.includes('/fetch_session_msgs')) return response({ messages: [
      { msg_type: 1, msg_status: 0, sender_uid: 42, msg_seqno: 1, timestamp: 10, content: JSON.stringify({ content: '在吗' }) },
    ] })
    throw new Error(`Unexpected URL: ${target}`)
  }
  const identityDirectory = { lookup: async () => new Map() }
  const inbox = await fetchDmTriggers(credential, '7', { fetchImpl, identityDirectory })
  assert.equal(inbox.events.length, 1)
  assert.equal(inbox.events[0].senderName, '')
  assert.equal(inbox.diagnostics.namedSessions, 0)
})

test('a failing nickname lookup never blocks the DM inbox', async () => {
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/get_sessions')) return response({ session_list: [
      { session_type: 1, talker_id: 42, unread_count: 1, last_msg: { sender_uid: 42 } },
    ] })
    if (target.includes('/fetch_session_msgs')) return response({ messages: [
      { msg_type: 1, msg_status: 0, sender_uid: 42, msg_seqno: 1, timestamp: 10, content: JSON.stringify({ content: '在吗' }) },
    ] })
    throw new Error(`Unexpected URL: ${target}`)
  }
  const identityDirectory = { lookup: async () => { throw new Error('identity service down') } }
  const inbox = await fetchDmTriggers(credential, '7', { fetchImpl, identityDirectory })
  assert.equal(inbox.events.length, 1)
  assert.equal(inbox.events[0].senderName, '')
  assert.equal(inbox.warnings.length, 0)
})

test('asks for a wide message window and keeps context correct for either response order', async () => {
  // 真实接口是「新→旧」返回；旧代码对数组做 slice(-20)，等于砍掉最新的一半。
  // 这里同时验证：窗口是 50、顺序不影响上下文、以及旧消息不会被截掉。
  const messages = []
  for (let index = 1; index <= 40; index += 1) {
    messages.push({
      msg_type: 1,
      msg_status: 0,
      sender_uid: index % 2 === 0 ? 42 : 7,
      msg_seqno: index,
      timestamp: index * 10,
      content: JSON.stringify({ content: `第${index}句` }),
    })
  }
  const sizes = []
  const run = async (ordered) => {
    const fetchImpl = async (url) => {
      const target = String(url)
      if (target.includes('/get_sessions')) return response({ session_list: [
        { session_type: 1, talker_id: 42, unread_count: 1, last_msg: { sender_uid: 42 } },
      ] })
      if (target.includes('/fetch_session_msgs')) {
        sizes.push(new URL(target).searchParams.get('size'))
        return response({ messages: ordered })
      }
      throw new Error(`Unexpected URL: ${target}`)
    }
    return fetchDmTriggers(credential, '7', { fetchImpl })
  }
  const newestFirst = [...messages].reverse()
  const oldestFirst = [...messages]
  const a = await run(newestFirst)
  const b = await run(oldestFirst)
  assert.deepEqual([...new Set(sizes)], [String(DM_WINDOW_SIZE)])
  assert.equal(DM_WINDOW_SIZE, 50)
  // 两种顺序必须得到同一条触发消息和同一段上下文。
  assert.equal(a.events.length, 1)
  assert.equal(a.events[0].text, '第40句')
  assert.equal(b.events[0].text, '第40句')
  assert.deepEqual(
    a.events[0].context.map((entry) => entry.text),
    b.events[0].context.map((entry) => entry.text),
  )
  // 最新的一半不会被砍掉：上下文里必须有触发消息之前最近的那几句。
  const texts = a.events[0].context.map((entry) => entry.text)
  assert.ok(texts.includes('第39句'))
  assert.ok(texts.includes('第38句'))
})

test('the message window is large enough to hold recent pushes', async () => {
  // 一条推送私信 200–500 字，主人聊十几句就会被挤出 20 条窗口。
  assert.ok(DM_WINDOW_SIZE >= 40)
})

test('sorts messages chronologically regardless of the API order', () => {
  const sorted = sortMessagesChronologically([
    { timestamp: 30, msg_seqno: 3 },
    { timestamp: 10, msg_seqno: 1 },
    { timestamp: 20, msg_seqno: 2 },
  ])
  assert.deepEqual(sorted.map((entry) => entry.timestamp), [10, 20, 30])
  assert.deepEqual(sortMessagesChronologically(undefined), [])
  assert.deepEqual(sortMessagesChronologically([null, 'x', { timestamp: 5 }]).length, 1)
})

test('only asks for nicknames of sessions that can produce an event', async () => {
  const asked = []
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/get_sessions')) return response({ session_list: [
      { session_type: 1, talker_id: 42, unread_count: 1, last_msg: { sender_uid: 42 } },
      // 已读的、自己发的、被拦截的都不需要昵称。
      { session_type: 1, talker_id: 43, unread_count: 0, last_msg: { sender_uid: 43 } },
      { session_type: 1, talker_id: 44, unread_count: 1, last_msg: { sender_uid: 7 } },
      { session_type: 1, talker_id: 45, unread_count: 1, is_intercept: 1, last_msg: { sender_uid: 45 } },
    ] })
    if (target.includes('/fetch_session_msgs')) return response({ messages: [
      { msg_type: 1, msg_status: 0, sender_uid: 42, msg_seqno: 1, timestamp: 10, content: JSON.stringify({ content: '在吗' }) },
    ] })
    throw new Error(`Unexpected URL: ${target}`)
  }
  const identityDirectory = { lookup: async (headers, mids) => { asked.push(...mids); return new Map() } }
  await fetchDmTriggers(credential, '7', { fetchImpl, identityDirectory })
  assert.deepEqual(asked, ['42'])
})

test('reads the comment floor as context and keeps my own replies marked', async () => {
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/x/msgfeed/reply')) return response({ items: [{
      id: 991, reply_time: 40, user: { mid: 42, nickname: '评论者' },
      item: { source_id: 992, source_content: '第二点能细说吗', subject_id: 200, root_id: 990, business_id: 1 },
    }] })
    if (target.includes('/x/msgfeed/at')) return response({ items: [] })
    if (target.includes('/x/v2/reply/reply')) {
      assert.equal(new URL(target).searchParams.get('root'), '990')
      return response({
        root: { rpid: 990, mid: 300, ctime: 10, content: { message: '这个视频的结论是什么' }, member: { uname: '楼主' } },
        replies: [
          { rpid: 991, mid: 7, ctime: 20, content: { message: '结论是字幕质量决定判断' }, member: { uname: '我' } },
          { rpid: 992, mid: 42, ctime: 30, content: { message: '第二点能细说吗' }, member: { uname: '评论者' } },
        ],
      })
    }
    throw new Error(`Unexpected URL: ${target}`)
  }
  const inbox = await fetchCommentTriggers(credential, '7', { fetchImpl })
  const event = inbox.events.find((entry) => entry.kind === 'reply')
  assert.ok(event)
  assert.equal(event.text, '第二点能细说吗')
  assert.deepEqual(event.context.map((entry) => entry.speaker), ['other', 'self', 'other'])
  assert.deepEqual(event.context.map((entry) => entry.text), ['这个视频的结论是什么', '结论是字幕质量决定判断', '第二点能细说吗'])
  assert.deepEqual(event.context.map((entry) => entry.name), ['楼主', '', '评论者'])
})

test('never substitutes the video title for the comment text', async () => {
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/x/msgfeed/reply')) return response({ items: [{
      id: 500, reply_time: 20, user: { mid: 42, nickname: '评论者' },
      item: { source_id: 500, source_content: '', title: '某个视频标题', subject_id: 200, root_id: 500, business_id: 1 },
    }] })
    if (target.includes('/x/msgfeed/at')) return response({ items: [] })
    // 楼层也拿不到正文：宁可跳过这条事件，也不拿视频标题当评论。
    if (target.includes('/x/v2/reply/reply')) return response({ root: { rpid: 500, mid: 42, ctime: 10, content: { message: '' }, member: { uname: '评论者' } }, replies: [] })
    throw new Error(`Unexpected URL: ${target}`)
  }
  const inbox = await fetchCommentTriggers(credential, '7', { fetchImpl })
  assert.equal(inbox.events.length, 0)
})

test('keeps the same DM context when the API returns messages newest-first', async () => {
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/get_sessions')) return response({ session_list: [
      { session_type: 1, talker_id: 42, unread_count: 1, account_info: { name: '对方' }, last_msg: { sender_uid: 42 } },
    ] })
    if (target.includes('/fetch_session_msgs')) return response({ messages: [
      { msg_type: 1, msg_status: 0, sender_uid: 42, msg_seqno: 3, timestamp: 30, content: JSON.stringify({ content: '那第二点呢？' }) },
      { msg_type: 1, msg_status: 0, sender_uid: 7, msg_seqno: 2, timestamp: 20, content: JSON.stringify({ content: '讲了字幕抓取和筛选。' }) },
      { msg_type: 1, msg_status: 0, sender_uid: 42, msg_seqno: 1, timestamp: 10, content: JSON.stringify({ content: '这个视频讲了什么？' }) },
    ] })
    throw new Error(`Unexpected URL: ${target}`)
  }
  const inbox = await fetchDmTriggers(credential, '7', { fetchImpl })
  const [event] = inbox.events
  assert.equal(event.text, '那第二点呢？')
  assert.deepEqual(event.context.map((entry) => entry.text), ['这个视频讲了什么？', '讲了字幕抓取和筛选。'])
})

test('treats an image-only DM as a trigger and keeps the picture in context', async () => {
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/get_sessions')) return response({ session_list: [
      { session_type: 1, talker_id: 42, unread_count: 1, account_info: { name: '对方' }, last_msg: { sender_uid: 42 } },
    ] })
    if (target.includes('/fetch_session_msgs')) return response({ messages: [
      { msg_type: 1, msg_status: 0, sender_uid: 42, msg_seqno: 1, timestamp: 10, content: JSON.stringify({ content: '看这张' }) },
      { msg_type: 2, msg_status: 0, sender_uid: 42, msg_seqno: 2, timestamp: 20, content: JSON.stringify({ url: 'https://message.biliimg.com/a.jpg', width: 800, height: 600 }) },
    ] })
    throw new Error(`Unexpected URL: ${target}`)
  }
  const inbox = await fetchDmTriggers(credential, '7', { fetchImpl })
  assert.equal(inbox.events.length, 1)
  const [event] = inbox.events
  // 以前 msg_type=2 直接返回空文本，图片消息等于没收到；现在纯图片也算触发消息。
  assert.equal(event.text, '')
  assert.equal(event.images.length, 1)
  assert.equal(event.images[0].width, 800)
  assert.equal(inbox.diagnostics.incomingImageMessages, 1)
  assert.equal(inbox.diagnostics.incomingTextMessages, 1)
})

test('reads comment pictures from the floor as context images', async () => {
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/x/msgfeed/reply')) return response({ items: [{
      id: 991, reply_time: 40, user: { mid: 42, nickname: '评论者' },
      item: { source_id: 991, source_content: '这个画面什么意思', subject_id: 200, root_id: 990, business_id: 1 },
    }] })
    if (target.includes('/x/msgfeed/at')) return response({ items: [] })
    if (target.includes('/x/v2/reply/reply')) return response({
      root: { rpid: 990, mid: 300, ctime: 10, content: { message: '看截图', pictures: [{ img_src: 'https://i0.hdslb.com/root.png', img_width: 300, img_height: 200 }] }, member: { uname: '楼主' } },
      replies: [{ rpid: 991, mid: 42, ctime: 30, content: { message: '这个画面什么意思', pictures: [{ img_src: 'https://i0.hdslb.com/reply.jpg' }] }, member: { uname: '评论者' } }],
    })
    throw new Error(`Unexpected URL: ${target}`)
  }
  const inbox = await fetchCommentTriggers(credential, '7', { fetchImpl })
  const [event] = inbox.events.filter((entry) => entry.kind === 'reply')
  assert.equal(event.context.length, 2)
  assert.equal(event.context[0].images.length, 1)
  assert.equal(event.context[1].images.length, 1)
  assert.equal(inbox.diagnostics.contextImages, 2)
})

test('treats a picture-only comment as valid context', async () => {
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/x/msgfeed/reply')) return response({ items: [{
      id: 700, reply_time: 20, user: { mid: 42, nickname: '评论者' },
      item: { source_id: 700, source_content: '图里是什么', subject_id: 200, root_id: 700, business_id: 1 },
    }] })
    if (target.includes('/x/msgfeed/at')) return response({ items: [] })
    if (target.includes('/x/v2/reply/reply')) return response({
      root: { rpid: 700, mid: 7, ctime: 10, content: { message: '', pictures: [{ img_src: 'https://i0.hdslb.com/mine.png' }] }, member: { uname: '我' } },
      replies: [],
    })
    throw new Error(`Unexpected URL: ${target}`)
  }
  const inbox = await fetchCommentTriggers(credential, '7', { fetchImpl })
  const [event] = inbox.events.filter((entry) => entry.kind === 'reply')
  assert.equal(event.context.length, 2)
  // 我发的纯图片评论照样进上下文（没有文字也不算空条目）。
  assert.equal(event.context[0].speaker, 'self')
  assert.equal(event.context[0].text, '')
  assert.equal(event.context[0].images.length, 1)
  // 楼层里没有触发评论本身时，用通知正文补上，模型才知道要回哪句。
  assert.equal(event.context[1].speaker, 'other')
  assert.equal(event.context[1].text, '图里是什么')
})

test('sends a DM only to the validated event recipient', async () => {
  let request
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options }
    return response({ msg_key: 'sent-key' })
  }
  const result = await sendPrivateMessage(credential, '7', {
    source: 'dm', target: { talkerId: '42' },
  }, '收到，谢谢', { fetchImpl })
  assert.deepEqual(result, { sent: true, id: 'sent-key', msgType: 1 })
  assert.equal(request.options.method, 'POST')
  assert.equal(new URLSearchParams(request.options.body).get('msg[receiver_id]'), '42')
  const payload = JSON.parse(new URLSearchParams(request.options.body).get('msg[content]'))
  assert.equal(payload.content, '收到，谢谢')
  await assert.rejects(sendPrivateMessage(credential, '7', { source: 'comments', target: {} }, '拒绝'), /会话坐标无效/)
})

test('sends a report DM to an explicit UID and validates the payload', async () => {
  let request
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options }
    return response({ msg_key: 'report-key' })
  }
  const result = await sendPrivateMessageTo(credential, '7', '42', '报告摘要', { fetchImpl })
  assert.deepEqual(result, { sent: true, id: 'report-key', msgType: 1 })
  const payload = new URLSearchParams(request.options.body)
  assert.equal(payload.get('msg[sender_uid]'), '7')
  assert.equal(payload.get('msg[receiver_id]'), '42')
  assert.equal(payload.get('csrf'), 'csrf')
  assert.equal(JSON.parse(payload.get('msg[content]')).content, '报告摘要')

  await assert.rejects(sendPrivateMessageTo(credential, '7', 'bad', '摘要', { fetchImpl }), /收件人 UID 无效/)
  await assert.rejects(sendPrivateMessageTo(credential, '7', '42', '   ', { fetchImpl }), /正文为空/)
  await assert.rejects(sendPrivateMessageTo(credential, '7', '42', '长'.repeat(501), { fetchImpl }), /超过 500 个字符/)
})

test('classifies the Bilibili DM length rejection as a length error', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ code: 21007, message: 'msg too long' }), { status: 200 })
  await assert.rejects(sendPrivateMessageTo(credential, '7', '42', '摘要', { fetchImpl }), /超过长度限制（code 21007）/)
})

test('uploads a local picture to the Bilibili image host and returns its url', async () => {
  let request
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options }
    return response({ image_url: 'http://i0.hdslb.com/bfs/new_dyn/abc.png', image_width: 640, image_height: 480, img_size: 12.5 })
  }
  const uploaded = await uploadImageToBilibili(credential, {
    bytes: Buffer.from('fake-image-bytes'),
    fileName: '开心.png',
    contentType: 'image/png',
  }, { fetchImpl })
  assert.match(request.url, /\/x\/dynamic\/feed\/draw\/upload_bfs$/)
  assert.equal(request.options.method, 'POST')
  // multipart 的 boundary 必须由 FormData 自己生成，不能手写 Content-Type。
  assert.equal(request.options.headers['Content-Type'], undefined)
  assert.equal(request.options.headers.Cookie.includes('SESSDATA=session'), true)
  const form = request.options.body
  assert.equal(form.get('category'), 'daily')
  assert.equal(form.get('csrf'), 'csrf')
  assert.equal(form.get('file_up').name, '开心.png')
  // http 地址统一升级成 https。
  assert.deepEqual(uploaded, { url: 'https://i0.hdslb.com/bfs/new_dyn/abc.png', width: 640, height: 480, sizeKb: 12.5 })
})

test('refuses to upload without image bytes or a CSRF token', async () => {
  const fetchImpl = async () => response({})
  await assert.rejects(uploadImageToBilibili(credential, { bytes: Buffer.alloc(0), fileName: 'a.png' }, { fetchImpl }), /图片内容为空/)
  await assert.rejects(
    uploadImageToBilibili({ sessdata: 's', bili_jct: '' }, { bytes: Buffer.from('x'), fileName: 'a.png' }, { fetchImpl }),
    /缺少 CSRF/,
  )
  // 上传接口失败时按发送失败分类，避免静默。
  await assert.rejects(
    uploadImageToBilibili(credential, { bytes: Buffer.from('x'), fileName: 'a.png' }, {
      fetchImpl: async () => new Response(JSON.stringify({ code: -101, message: '账号未登录' }), { status: 200 }),
    }),
    /B站发送失败/,
  )
})

test('sends a picture DM as msg_type 2 with the uploaded url', async () => {
  let request
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options }
    return response({ msg_key: 'image-key' })
  }
  const result = await sendPrivateImage(credential, '7', '42', {
    url: 'https://i0.hdslb.com/bfs/new_dyn/abc.png', width: 640, height: 480, sizeKb: 12.5, imageType: 'png',
  }, { fetchImpl })
  assert.deepEqual(result, { sent: true, id: 'image-key', msgType: 2 })
  const payload = new URLSearchParams(request.options.body)
  assert.equal(payload.get('msg[msg_type]'), '2')
  assert.equal(payload.get('msg[receiver_id]'), '42')
  const content = JSON.parse(payload.get('msg[content]'))
  assert.equal(content.url, 'https://i0.hdslb.com/bfs/new_dyn/abc.png')
  assert.equal(content.width, 640)
  assert.equal(content.height, 480)
  assert.equal(content.size, 12.5)
  assert.equal(content.imageType, 'png')
  // 图片消息的 content 里不能有文字字段。
  assert.equal(content.content, undefined)

  // 缺宽高时省略而不是填 0（文档说填 0 可能导致显示异常）。
  const minimal = await sendPrivateImageToTalker(credential, '7', { source: 'dm', target: { talkerId: '42' } }, { url: 'https://i0.hdslb.com/bfs/x.png' }, {
    fetchImpl: async () => response({ msg_key: 'k2' }),
  })
  assert.equal(minimal.msgType, 2)
})

test('rejects an invalid picture url before calling Bilibili', async () => {
  const fetchImpl = async () => { throw new Error('不该发出请求') }
  await assert.rejects(sendPrivateImage(credential, '7', '42', { url: 'not-a-url' }, { fetchImpl }), /图片地址无效/)
  await assert.rejects(sendPrivateImage(credential, '7', '42', { url: 'http://i0.hdslb.com/a.png' }, { fetchImpl }), /图片地址无效/)
  await assert.rejects(sendPrivateImageToTalker(credential, '7', { source: 'comments', target: {} }, { url: 'https://i0.hdslb.com/a.png' }, { fetchImpl }), /会话坐标无效/)
})

test('explains a rejected image with code 21037', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ code: 21037, message: '图片格式不合法' }), { status: 200 })
  await assert.rejects(
    sendPrivateImage(credential, '7', '42', { url: 'https://i0.hdslb.com/a.png' }, { fetchImpl }),
    /不接受这张图片（code 21037）/,
  )
})

test('returns Bilibili comment receipt state and actual reply coordinates', async () => {
  let request
  const fetchImpl = async (url, options) => {
    if (String(url).includes('/x/web-interface/nav')) return response({ wbi_img: { img_url: IMG, sub_url: SUB } })
    request = { url: String(url), options }
    return response({ rpid_str: '317651487729', reply: { rpid_str: '317651487729', oid: 117468295072886, root: 321255083808, parent: 321326313248, state: 0 } })
  }
  const result = await sendCommentReply(credential, {
    source: 'comments', target: { oid: '117468295072886', root: '321255083808', parent: '321326313248', business: 1 },
  }, '回复内容', { fetchImpl })
  assert.equal(result.id, '317651487729')
  assert.equal(result.state, 0)
  assert.equal(result.oid, '117468295072886')
  assert.equal(result.root, '321255083808')
  assert.equal(result.parent, '321326313248')
  assert.equal(new URLSearchParams(request.options.body).get('parent'), '321326313248')
})
test('normalizes a top-level comment notification with root_id zero', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/x/msgfeed/reply')) return response({ items: [{
      id: 991, reply_time: 20, user: { mid: 42, nickname: '评论者' },
      item: { source_id: 991, source_content: '你好', subject_id: 200, root_id: 0, business_id: 1 },
    }] })
    return response({ items: [] })
  }
  const inbox = await fetchCommentTriggers(credential, '7', { fetchImpl })
  const event = inbox.events.find((entry) => entry.kind === 'reply')
  assert.ok(event)
  assert.equal(event.target.root, '991')
  assert.equal(event.target.parent, '991')
  assert.equal(event.text, '你好')
})
test('only collects authenticated comments addressed to another account', async () => {
  const fetchImpl = async () => response({ items: [{
    id: 100, reply_time: 12, user: { mid: 42, nickname: '来信人' },
    item: { source_id: 100, source_content: '收到回复', subject_id: 200, root_id: 90, business_id: 1 },
  }] })
  const inbox = await fetchCommentTriggers(credential, '7', { fetchImpl })
  assert.equal(inbox.events.length, 2)
  assert.deepEqual(inbox.events.map((event) => event.kind), ['reply', 'at'])
  assert.ok(inbox.events.every((event) => event.source === 'comments' && event.text === '收到回复'))
})
