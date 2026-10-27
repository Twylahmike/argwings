// Structured logging with a correlation id. Phone numbers are redacted to the last 3 digits and
// secrets are never logged. Use fields for data, never string-concatenate secrets into the message.
const PHONE_RE = /\b(?:\+?254|0)([71]\d{8})\b/g
const SECRET_KEYS = /token|secret|key|password|passkey|authorization/i
const PHONE_KEYS = /phone|msisdn|to_phone|party/i

export function redactPhone(p: string): string {
  return p.length <= 3 ? p : '*'.repeat(p.length - 3) + p.slice(-3)
}

function clean(value: unknown, key = ''): unknown {
  if (value == null) return value
  if (SECRET_KEYS.test(key)) return '[redacted]'
  if (typeof value === 'string') {
    if (PHONE_KEYS.test(key)) return redactPhone(value)
    return value.replace(PHONE_RE, (m) => redactPhone(m))
  }
  if (typeof value === 'number' && PHONE_KEYS.test(key)) return redactPhone(String(value))
  if (Array.isArray(value)) return value.map((v) => clean(v, key))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, clean(v, k)]))
  }
  return value
}

export type Logger = {
  cid: string
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

export function makeLogger(fn: string, cid = crypto.randomUUID().slice(0, 8)): Logger {
  const emit = (level: string, msg: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ level, fn, cid, msg: clean(msg), ...(fields ? { fields: clean(fields) } : {}) })
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
  return {
    cid,
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  }
}
