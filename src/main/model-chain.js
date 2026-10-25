// 模型调用链：首选模型失败后自动改用备用模型。
// 只做“按顺序尝试 + 汇总错误”，不关心具体任务，便于测试和复用。

export function defaultProfileLabel(profile) {
  const provider = String(profile?.providerName || '').trim()
  const model = String(profile?.model || '').trim()
  if (provider && model) return `${provider}（${model}）`
  return provider || model || '未命名模型'
}

export function summarizeAttempts(attempts) {
  return (Array.isArray(attempts) ? attempts : [])
    .map((attempt) => `${attempt.label}：${attempt.message}`)
    .join('；')
    .slice(0, 600)
}

// run(profile, index) 抛出异常即视为该模型失败，继续尝试下一个。
// 链路只有“首选 + 备用”两个位置，多余的模型不会参与自动降级。
export async function runModelChain({ chain = [], run, log = () => {}, describe = defaultProfileLabel } = {}) {
  if (typeof run !== 'function') throw new Error('缺少模型调用函数。')
  const profiles = (Array.isArray(chain) ? chain : []).filter((profile) => profile && typeof profile === 'object').slice(0, 2)
  if (!profiles.length) throw new Error('没有可用的模型，请先在模型设置中添加并保存 API Key。')
  const attempts = []
  for (const [index, profile] of profiles.entries()) {
    const label = describe(profile)
    try {
      const result = await run(profile, index)
      if (attempts.length) {
        log('info', 'model-fallback-used', `used=${label} skipped=${attempts.map((attempt) => attempt.label).join('|')}`)
      }
      return { result, profile, attempts, fallbackUsed: attempts.length > 0 }
    } catch (error) {
      const message = String(error?.message || error || '未知错误').replace(/[\r\n\t]+/g, ' ').slice(0, 200)
      attempts.push({ id: profile.id, label, message })
      log('warn', 'model-attempt-failed', `${label}: ${message}`)
    }
  }
  // 只有一个模型时保留原始错误，避免把“请先填写模型名称”这类提示包一层。
  if (profiles.length === 1) {
    const error = new Error(attempts[0].message)
    error.attempts = attempts
    throw error
  }
  const error = new Error(`首选模型和备用模型都调用失败（${summarizeAttempts(attempts)}）。`)
  error.attempts = attempts
  throw error
}
