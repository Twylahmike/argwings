// Email sender (Resend HTTP API). Never throws: returns a result the caller logs.
// Off unless EMAIL_ENABLED is "true" and RESEND_API_KEY + EMAIL_FROM are set. A failed email must never break a booking or payment.
declare const Deno: { env: { get(k: string): string | undefined } }

export type EmailResult =
  | { status: 'sent'; providerId: string | null }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string }

export function emailConfigured(env = Deno.env): boolean {
  return env.get('EMAIL_ENABLED') === 'true' && !!env.get('RESEND_API_KEY') && !!env.get('EMAIL_FROM')
}

export const isEmail = (v: unknown): v is string => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Plain message text -> simple, safe HTML (links clickable, line breaks kept). */
export function textToHtml(text: string): string {
  const body = esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#8a5a12">$1</a>').replace(/\n/g, '<br>')
  return `<div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1c1a17;max-width:560px">${body}</div>`
}

export async function sendEmail(to: string, subject: string, text: string, env = Deno.env): Promise<EmailResult> {
  if (!emailConfigured(env)) return { status: 'skipped', reason: 'Email sending is switched off' }
  if (!isEmail(to)) return { status: 'skipped', reason: 'No valid email address' }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.get('EMAIL_FROM'), to: [to], subject: subject.slice(0, 200), text, html: textToHtml(text),
        ...(env.get('EMAIL_REPLY_TO') ? { reply_to: env.get('EMAIL_REPLY_TO') } : {}),
      }),
    })
    const j = await res.json().catch(() => ({})) as { id?: string; message?: string }
    if (!res.ok) return { status: 'failed', error: j.message ?? `Email API ${res.status}` }
    return { status: 'sent', providerId: j.id ?? null }
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : 'send failed' }
  }
}
