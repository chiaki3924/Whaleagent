import { normalizeInteractionSettings, interactionEnabled } from './interaction-state.js'

export function interactionSettingsReady({ interaction, modelReady, baseUrl, model, hasApiKey, biliLoggedIn }) {
  const config = normalizeInteractionSettings(interaction)
  // 0.8.0 起由调用方用 modelReady 汇总“首选或备用模型可用”；旧参数仍然兼容。
  const modelAvailable = typeof modelReady === 'boolean'
    ? modelReady
    : Boolean(String(baseUrl || '').trim() && String(model || '').trim() && hasApiKey === true)
  return interactionEnabled(config)
    && modelAvailable
    && biliLoggedIn === true
}
