// 私信对方的公开昵称查询。
//
// 为什么需要这个模块：B站 的私信会话对象（`get_sessions` / `session_detail`）**不返回用户昵称**。
// 会话对象里的 `account_info` 只有系统会话（`system_msg_type != 0`）才有值，
// 用户会话（`session_type = 1`、`system_msg_type = 0`）里它是 `null`，
// 消息主体（`fetch_session_msgs`）也只有 `sender_uid`。所以只靠会话数据永远拿不到“对方是谁”，
// 必须在回复前按 mid 额外查一次公开名片。
//
// 实测（2026-10-24，真实登录态）：
// - `GET /vc/account/v1/user/cards?uids=a,b,c` 一次最多 50 个 mid，超过 50 返回空数组（code 仍是 0）；
// - 不存在的 mid 不会报错，只是不出现在返回数组里；
// - 返回项形如 `{mid, name, face, sign, rank, level, silence}`。
//
// 查不到昵称不能阻断回复：这里所有失败都降级成“未取得昵称”，由调用方照常发消息。
import { createHash } from 'node:crypto'

const VC = 'https://api.vc.bilibili.com'

// 实测上限：51 个以上返回空数组。留一点余量，不要贴着边界用。
export const IDENTITY_MAX_BATCH = 50
export const IDENTITY_NAME_MAX = 40
// 昵称很少变，缓存久一点；查不到的（负缓存）短一些，避免对方改名后一直叫不出来。
export const IDENTITY_TTL_MS = 30 * 60 * 1000
export const IDENTITY_MISS_TTL_MS = 5 * 60 * 1000
export const IDENTITY_CACHE_MAX = 500

// 只接受 1–20 位数字的 mid，去重并截到 limit。
// 私信会话里的 talker_id 就是 mid；粉丝团/系统会话的 id 不走这条路径。
// 默认不截断：lookup 内部会按 IDENTITY_MAX_BATCH 自动分批。
export function normalizeMids(values, { limit = Number.POSITIVE_INFINITY } = {}) {
  const list = []
  const seen = new Set()
  for (const value of Array.isArray(values) ? values : []) {
    const mid = String(value ?? '').trim()
    if (!/^\d{1,20}$/.test(mid) || seen.has(mid)) continue
    seen.add(mid)
    list.push(mid)
    if (list.length >= limit) break
  }
  return list
}

// B站昵称里可能带 HTML 实体或尖括号，进提示词前统一清成纯文本。
export function cleanDisplayName(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, IDENTITY_NAME_MAX)
}

// `data` 是数组；缺 mid 或昵称为空（已注销、被清空）的条目直接丢掉。
export function parseUserCards(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  const names = new Map()
  for (const item of list) {
    const mid = String(item?.mid ?? '')
    const name = cleanDisplayName(item?.name)
    if (/^\d{1,20}$/.test(mid) && name) names.set(mid, name)
  }
  return names
}

// 进程内目录：主进程每轮轮询都会遇到同一批会话，缓存能省掉重复请求。
// 传入 fetchImpl 时调用方通常希望隔离（测试），所以工厂不共享缓存。
export function createIdentityDirectory({
  fetchImpl = fetch,
  now = () => Date.now(),
  ttlMs = IDENTITY_TTL_MS,
  missTtlMs = IDENTITY_MISS_TTL_MS,
  maxEntries = IDENTITY_CACHE_MAX,
  timeoutMs = 15_000,
} = {}) {
  const cache = new Map()

  function remember(mid, name) {
    // Map 保持插入顺序，超出上限时丢最早的条目（够用的近似 LRU）。
    if (!cache.has(mid) && cache.size >= maxEntries) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(mid, { name: String(name || ''), at: now() })
  }

  function cached(mid) {
    const entry = cache.get(mid)
    if (!entry) return null
    const ttl = entry.name ? ttlMs : missTtlMs
    return now() - entry.at < ttl ? entry : null
  }

  // 返回 Map(mid → 昵称)，只包含这次查到的；查不到的不进结果。
  // 网络错误、code 非 0、非 JSON 都当作“这一批没查到”，**不写负缓存**，
  // 免得一次网络抖动就让对方五分钟都没有名字。
  async function lookup(requestHeaders, mids) {
    const wanted = normalizeMids(mids)
    const resolved = new Map()
    const missing = []
    for (const mid of wanted) {
      const entry = cached(mid)
      if (!entry) missing.push(mid)
      else if (entry.name) resolved.set(mid, entry.name)
    }
    for (let index = 0; index < missing.length; index += IDENTITY_MAX_BATCH) {
      const batch = missing.slice(index, index + IDENTITY_MAX_BATCH)
      try {
        const url = `${VC}/account/v1/user/cards?uids=${batch.join(',')}`
        const response = await fetchImpl(url, {
          headers: requestHeaders,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = await response.json()
        if (Number(payload?.code) !== 0) throw new Error(`code ${payload?.code}`)
        const names = parseUserCards(payload)
        for (const mid of batch) {
          const name = names.get(mid) || ''
          if (name) resolved.set(mid, name)
          remember(mid, name)
        }
      } catch { /* 降级：这一批当作查不到，下一轮再试 */ }
    }
    return resolved
  }

  return {
    lookup,
    clear: () => cache.clear(),
    get size() { return cache.size },
  }
}

// 日志里不要出现 mid 或昵称，只报“查了几个、拿到几个”。
export function describeIdentityLookup(resolved, requested) {
  const got = resolved instanceof Map ? resolved.size : 0
  const want = Array.isArray(requested) ? requested.length : Number(requested) || 0
  return `昵称 ${got}/${want}`
}

// 让“同一个人”在缓存里可比较：真实实现用 mid，这里给测试和诊断用的稳定指纹。
export function identityFingerprint(mid) {
  return createHash('sha256').update(String(mid ?? '')).digest('hex').slice(0, 12)
}
