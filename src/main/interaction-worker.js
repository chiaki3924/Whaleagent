import {
  canSendInteraction,
  createInteractionState,
  interactionEnabled,
  isWithinInteractionSchedule,
  markInteractionEventSeen,
  normalizeInteractionSettings,
  planInteractionEvents,
  isInteractionRiskError,
  normalizeReplyText,
  pauseInteractionState,
  readInteractionState,
  recordInteractionSent,
  writeInteractionState,
} from './interaction-state.js'

function safeInteractionError(error) {
  const message = String(error?.message || '未知错误').replace(/[\r\n\t]+/g, ' ').slice(0, 180)
  return message.replace(/(SESSDATA|bili_jct|buvid3|api[_-]?key|authorization)\s*[:=]\s*[^\s;,]+/gi, '$1=[REDACTED]')
}


export async function processInteractionCycle({ settings, previousState, events, now = new Date(), getNow = () => new Date(), generateReply, sendComment, sendDm, sendDmImage, saveState, isCurrent = () => true, log = () => {} }) {
  const config = normalizeInteractionSettings(settings)
  let state = createInteractionState(previousState, now)
  if (!isCurrent() || !interactionEnabled(config) || !isWithinInteractionSchedule(config, now) || state.pausedReason) return { state, baseline: false, sent: 0, skipped: 0, paused: Boolean(state.pausedReason) }

  const plan = planInteractionEvents(config, state, events, now)
  if (!isCurrent()) return { state, baseline: false, sent: 0, skipped: 0, paused: false }
  state = plan.state
  await saveState(state)
  if (plan.baseline) return { state, baseline: true, sent: 0, skipped: 0, paused: false }

  let sent = 0
  let skipped = 0
  const failureReasons = []
  const sentSources = []
  const sentReceipts = []
  // 本轮由主人要求触发的写操作结果（点赞/收藏）；没有就是 null。
  let actionOutcome = null
  const queuedEvents = [...plan.events].sort((a, b) => Number(a.source !== 'dm') - Number(b.source !== 'dm') || Number(a.timestamp || 0) - Number(b.timestamp || 0))
  for (const event of queuedEvents.slice(0, 1)) {
    if (!isCurrent() || !canSendInteraction(config, state, getNow())) break
    let generated
    try { generated = await generateReply(event) }
    catch (error) {
      skipped += 1
      const reason = safeInteractionError(error)
      failureReasons.push(`回复生成：${reason}`)
      log('interaction-reply-generation-failed', `${event.source}:${reason}`)
      continue
    }
    // generateReply 正常返回字符串；带配图时返回 { reply, image }；
    // 主人要求点赞/收藏时还会带上 actionOutcome（写操作结果，仅用于状态栏与日志）。
    const reply = normalizeReplyText(typeof generated === 'string' ? generated : generated?.reply, 300)
    const plannedImage = typeof generated === 'object' && generated ? generated.image : null
    actionOutcome = typeof generated === 'object' && generated ? (generated.actionOutcome || null) : null
    if (!isCurrent() || !canSendInteraction(config, state, getNow())) break
    state = markInteractionEventSeen(state, event.id)
    await saveState(state)
    try {
      const result = event.source === 'dm' ? await sendDm(event, reply) : await sendComment(event, reply)
      const receipt = result && typeof result === 'object' ? result : {}
      sent += 1
      sentSources.push(event.source)
      sentReceipts.push({ source: event.source, id: String(receipt.id || ''), state: receipt.state ?? null, oid: receipt.oid || '', root: receipt.root || '', parent: receipt.parent || '' })
      state = recordInteractionSent(state, getNow())
      try { await saveState(state) }
      catch (error) { log('interaction-state-save-failed', `${event.source}:${error?.name || 'Error'}`) }
      const detail = event.source === 'comments'
        ? `${event.kind || 'message'}:${String(receipt.id || 'accepted')}:oid=${receipt.oid || event.target?.oid}:root=${receipt.root || event.target?.root}:parent=${receipt.parent || event.target?.parent}:state=${receipt.state ?? 'unknown'}`
        : `${event.kind || 'message'}:${String(receipt.id || 'accepted')}`
      log('interaction-sent', detail.slice(0, 220))

      // 文字发出后再发配图。图片单独算一次发送：B站无法把文字和图片合成一条消息，
      // 额度必须如实计数，否则用户设的上限会被突破。
      if (plannedImage && event.source === 'dm' && sendDmImage) {
        if (!isCurrent() || !canSendInteraction(config, state, getNow())) {
          log('interaction-image-skipped', 'quota')
        } else {
          try {
            const imageReceipt = await sendDmImage(event, plannedImage)
            sent += 1
            sentSources.push('dm:image')
            sentReceipts.push({ source: 'dm:image', id: String(imageReceipt?.id || '') })
            state = recordInteractionSent(state, getNow())
            try { await saveState(state) }
            catch (error) { log('interaction-state-save-failed', `dm:image:${error?.name || 'Error'}`) }
            log('interaction-image-sent', `id=${String(imageReceipt?.id || 'accepted')}`)
          } catch (error) {
            // 图没发出去不影响文字已经送达，但要记下来，别让用户以为发了两条。
            if (isInteractionRiskError(error)) {
              state = pauseInteractionState(state, 'B站返回风控或验证码；互动已暂停，请检查账号状态后手动恢复。', getNow())
              await saveState(state)
              log('interaction-paused-risk', 'dm:image')
              break
            }
            const reason = safeInteractionError(error)
            failureReasons.push(`配图发送：${reason}`)
            log('interaction-image-failed', reason.slice(0, 200))
          }
        }
      }
    } catch (error) {
      skipped += 1
      if (isInteractionRiskError(error)) {
        state = pauseInteractionState(state, 'B站返回风控或验证码；互动已暂停，请检查账号状态后手动恢复。', getNow())
        await saveState(state)
        log('interaction-paused-risk', `${event.source}:${event.kind || 'message'}`)
        break
      }
      const reason = safeInteractionError(error)
      failureReasons.push(`B站发送：${reason}`)
      log('interaction-send-failed', `${event.source}:${reason}`)
    }
  }
  return { state, baseline: false, sent, sentSources, sentReceipts, skipped, failureReasons, paused: Boolean(state.pausedReason), limitReached: state.daily.count >= config.dailyLimit, actionOutcome }
}

export async function runInteractionCycle({
  settings,
  statePath,
  previousState,
  credential,
  selfMid,
  fetchEvents,
  fetchCommentTriggers,
  fetchDmTriggers,
  generateReply,
  sendComment,
  sendDm,
  sendDmImage,
  saveState,
  now = new Date(),
  getNow = () => new Date(),
  isCurrent = () => true,
  log = () => {},
}) {
  const config = normalizeInteractionSettings(settings)
  let state
  try { state = previousState ? createInteractionState(previousState, now) : await readInteractionState(statePath, now) }
  catch (error) {
    log('interaction-state-invalid', error.message)
    return { paused: true, sent: 0, skipped: 0, reason: error.message, warnings: [] }
  }
  if (!isCurrent() || !interactionEnabled(config) || !isWithinInteractionSchedule(config, now) || state.pausedReason) {
    return { state, baseline: false, sent: 0, skipped: 0, paused: Boolean(state.pausedReason), warnings: [] }
  }

  let events = []
  let warnings = []
  let diagnostics = {}
  if (fetchEvents) {
    try {
      const inbox = await fetchEvents()
      events = Array.isArray(inbox) ? inbox : Array.isArray(inbox?.events) ? inbox.events : []
      warnings = Array.isArray(inbox?.warnings) ? inbox.warnings : []
      diagnostics = inbox?.diagnostics && typeof inbox.diagnostics === 'object' ? inbox.diagnostics : {}
    } catch (error) { warnings.push(`inbox: ${error?.message || 'failed'}`) }
  } else {
    if (config.commentsEnabled && fetchCommentTriggers) {
      try {
        const result = await fetchCommentTriggers(credential, selfMid)
        events.push(...(result.events || []))
        for (const warning of result.warnings || []) warnings.push(`comments:${warning}`)
      } catch (error) { warnings.push(`comments:${error?.message || 'failed'}`) }
    }
    if (config.dmEnabled && fetchDmTriggers) {
      try {
        const result = await fetchDmTriggers(credential, selfMid)
        events.push(...(result.events || []))
        diagnostics = result.diagnostics && typeof result.diagnostics === 'object' ? result.diagnostics : diagnostics
        for (const warning of result.warnings || []) warnings.push(`dm:${warning}`)
      } catch (error) { warnings.push(`dm:${error?.message || 'failed'}`) }
    }
  }
  if (!isCurrent()) return { state, baseline: false, sent: 0, skipped: 0, paused: false, warnings }

  const result = await processInteractionCycle({
    settings: config,
    previousState: state,
    events,
    now,
    getNow,
    generateReply,
    sendComment,
    sendDm,
    sendDmImage,
    saveState: saveState ?? ((next) => writeInteractionState(statePath, next)),
    isCurrent,
    log,
  })
  return { ...result, warnings, diagnostics }
}
