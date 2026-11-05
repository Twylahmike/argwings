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

export type EmailBrand = { business: string; cta?: { label: string; url: string } }

/**
 * Plain message text -> safe HTML (links clickable, line breaks kept). With a brand it gets the RG Wings look:
 * black header with the business name in gold, ivory body, and an optional gold button.
 */
export function textToHtml(text: string, brand?: EmailBrand): string {
  const body = esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#8a5a12">$1</a>').replace(/\n/g, '<br>')
  if (!brand) return `<div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1c1a17;max-width:560px">${body}</div>`
  const button = brand.cta && /^https:\/\//.test(brand.cta.url)
    ? `<p style="margin:28px 0 4px"><a href="${esc(brand.cta.url)}" style="display:inline-block;background:#a9761f;color:#ffffff;text-decoration:none;font-weight:600;letter-spacing:.06em;text-transform:uppercase;font-size:13px;padding:14px 28px;border-radius:999px">${esc(brand.cta.label)}</a></p>` : ''
  return `<div style="background:#f7f1ec;padding:24px 12px"><div style="max-width:560px;margin:0 auto;background:#fffdf9;border-radius:12px;overflow:hidden;font-family:Inter,Arial,sans-serif;color:#1c1a17">`
    + `<div style="background:#0c0b0a;padding:22px 28px"><span style="font-family:Georgia,'Cormorant Garamond',serif;font-size:24px;color:#d4a24c;letter-spacing:.02em">${esc(brand.business)}</span></div>`
    + `<div style="padding:28px;font-size:15px;line-height:1.65">${body}${button}</div></div></div>`
}

export async function sendEmail(to: string, subject: string, text: string, env = Deno.env, brand?: EmailBrand): Promise<EmailResult> {
  if (!emailConfigured(env)) return { status: 'skipped', reason: 'Email sending is switched off' }
  if (!isEmail(to)) return { status: 'skipped', reason: 'No valid email address' }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.get('EMAIL_FROM'), to: [to], subject: subject.slice(0, 200), text, html: textToHtml(text, brand),
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
