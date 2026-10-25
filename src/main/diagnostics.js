import fs from 'node:fs/promises'
import path from 'node:path'

const MAX_LOG_BYTES = 1024 * 1024
const SECRET_PATTERNS = [
  /(SESSDATA|bili_jct|buvid3|DedeUserID|Authorization)\s*[:=]\s*(?:Bearer\s+)?([^\s;,]+)/gi,
  /(qrcode_key|auth_key|csrf_token|api[_-]?key)\s*[:=]\s*([^\s&;,]+)/gi,
  /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g,
  /https?:\/\/[^\s"'<>]+/gi,
]

export function sanitizeDiagnosticText(value) {
  let text = String(value ?? '')
  text = text.replace(SECRET_PATTERNS[0], '$1=[REDACTED]')
  text = text.replace(SECRET_PATTERNS[1], '$1=[REDACTED]')
  text = text.replace(SECRET_PATTERNS[2], 'Bearer [REDACTED]')
  text = text.replace(SECRET_PATTERNS[3], '[IMAGE DATA REDACTED]')
  text = text.replace(SECRET_PATTERNS[4], (raw) => {
    try {
      const url = new URL(raw)
      return `${url.origin}${url.pathname}[QUERY REDACTED]`
    } catch { return '[URL REDACTED]' }
  })
  return text.slice(0, 2000)
}

export async function appendDiagnostic(logPath, level, event, detail = '') {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    level: String(level).slice(0, 12),
    event: sanitizeDiagnosticText(event).slice(0, 80),
    detail: sanitizeDiagnosticText(detail),
  }) + '\n'
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  try {
    const stat = await fs.stat(logPath)
    if (stat.size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
      await fs.rename(logPath, `${logPath}.1`).catch(() => fs.rm(logPath, { force: true }))
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  await fs.appendFile(logPath, line, { encoding: 'utf8', mode: 0o600 })
}

export function errorSummary(error) {
  // 空 message 的 Error 在日志里只剩一个 "Error"，等于没记。尽量补上有用的字段：
  // 状态码、错误码、cause，全都没有时退回错误类型名。
  if (!(error instanceof Error) && (error === null || typeof error !== 'object')) {
    return sanitizeDiagnosticText(String(error ?? 'Unknown error')) || 'Unknown error'
  }
  const name = sanitizeDiagnosticText(error?.name || 'Error')
  const rawMessage = String(error?.message ?? '').trim()
  const message = sanitizeDiagnosticText(rawMessage)
  const parts = []
  if (message) parts.push(message)
  const status = error?.status ?? error?.statusCode
  if (status !== undefined && status !== null && status !== '') parts.push(`HTTP ${status}`)
  const code = error?.code
  if (code !== undefined && code !== null && code !== '' && String(code) !== message) parts.push(`code=${code}`)
  const cause = error?.cause
  if (cause) {
    const causeMessage = sanitizeDiagnosticText(String(cause?.message || cause))
    if (causeMessage && causeMessage !== message) parts.push(`cause=${causeMessage}`)
  }
  if (!parts.length) parts.push('无错误信息')
  return `${name}: ${parts.join(' ')}`
}
