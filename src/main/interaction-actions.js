// 主人在私信里明确要求「点赞 / 收藏」时，由这里落地执行。
//
// 三条硬规则（代码守，不靠模型自觉）：
// 1. 只对「最近私信推给主人的视频」执行。BV 必须能在推送台账里找到，
//    模型编造的 BV、主人随口提到的别人视频，一律不碰。
// 2. 只在私信里执行。评论楼层里的陌生人说“帮我点个赞”不会触发任何写操作。
// 3. 只有模型在 actions 里显式请求时才执行。模型没请求就等于主人没要求。
//
// 这里不判断“主人是不是真的想要”：那是模型读 message 的活；这里只守住“能点哪条、能点几次”。
import { PUSH_ACTION_TYPES, resolvePushedVideo } from './push-log.js'

export const MAX_ACTIONS_PER_REPLY = 3

// 模型返回的 actions 形状不可信，先清洗成 [{bvid, type}]。
// 支持 {"actions":[{"bvid":"BV…","like":1,"favorite":1}]} 和
// {"actions":[{"bvid":"BV…","type":"like"}]} 两种写法。
export function normalizeRequestedActions(value, { limit = MAX_ACTIONS_PER_REPLY } = {}) {
  const list = Array.isArray(value) ? value : []
  const actions = []
  const seen = new Set()
  for (const entry of list) {
    const bvid = String(entry?.bvid || '')
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) continue
    const requested = []
    if (entry?.like === true || Number(entry?.like) === 1) requested.push('like')
    if (entry?.favorite === true || Number(entry?.favorite) === 1) requested.push('favorite')
    const explicit = String(entry?.type || '').toLowerCase()
    if (PUSH_ACTION_TYPES.includes(explicit)) requested.push(explicit)
    for (const type of requested) {
      const key = `${bvid}:${type}`
      if (seen.has(key)) continue
      seen.add(key)
      actions.push({ bvid, type })
      if (actions.length >= limit) return actions
    }
  }
  return actions
}

// 执行一轮写操作。任何一条失败都只影响它自己：回复已经发出去了，不能因为点赞失败回滚。
// 返回 { done, skipped, failed }，调用方据此写日志与台账。
export async function executeRequestedActions({
  actions = [],
  pushLog = { pushes: [] },
  like = null,
  favorite = null,
  now = new Date(),
  recordAction = null,
  log = () => {},
} = {}) {
  const done = []
  const skipped = []
  const failed = []
  for (const action of actions) {
    const video = resolvePushedVideo(pushLog, action.bvid)
    if (!video) {
      // 不在推送台账里：可能是模型编的 BV，也可能是主人让点别人推的视频。两种都不做。
      skipped.push({ ...action, reason: 'not-pushed' })
      log('warn', 'interaction-action-skipped', `${action.type}:not-pushed`)
      continue
    }
    const already = action.type === 'like' ? video.liked : video.favorited
    if (already) {
      skipped.push({ ...action, reason: 'already-done' })
      continue
    }
    const runner = action.type === 'like' ? like : favorite
    if (typeof runner !== 'function') {
      skipped.push({ ...action, reason: 'unsupported' })
      continue
    }
    try {
      await runner(action.bvid)
      done.push({ ...action, title: video.title })
      // 台账写失败不能影响已经完成的写操作，只记日志。
      if (typeof recordAction === 'function') {
        try { await recordAction({ bvid: action.bvid, action: action.type, now }) }
        catch (error) { log('warn', 'interaction-action-log-failed', `${action.type}:${error?.name || 'Error'}`) }
      }
    } catch (error) {
      failed.push({ ...action, reason: String(error?.message || '未知错误').slice(0, 120) })
      log('warn', 'interaction-action-failed', `${action.type}:${String(error?.message || '未知错误').slice(0, 120)}`)
    }
  }
  return { done, skipped, failed }
}

// 给用户看的结果文案（写进回复尾巴或状态栏），不含 BV 号以外的内部信息。
export function describeActionOutcome({ done = [], skipped = [], failed = [] } = {}) {
  const labels = { like: '点赞', favorite: '收藏' }
  const parts = []
  if (done.length) parts.push(`已${done.map((item) => labels[item.type] || item.type).join('、')} ${done.length} 条`)
  const already = skipped.filter((item) => item.reason === 'already-done').length
  if (already) parts.push(`${already} 条此前已操作过`)
  const notPushed = skipped.filter((item) => item.reason === 'not-pushed').length
  if (notPushed) parts.push(`${notPushed} 条不在最近推送里，未操作`)
  if (failed.length) parts.push(`${failed.length} 条操作失败`)
  return parts.join('；')
}
