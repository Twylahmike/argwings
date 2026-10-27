// WhatsApp Business Cloud API sender. Never throws: returns a result the caller logs.
// If WHATSAPP_ENABLED is not "true" (or credentials are missing) it reports `skipped` so the
// admin UI can offer the wa.me manual fallback. A messaging failure must never break a booking or payment.
declare const Deno: { env: { get(k: string): string | undefined } }

export type SendResult =
  | { status: 'sent'; providerId: string | null }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string }

const GRAPH = 'https://graph.facebook.com/v21.0'

export function whatsappConfigured(env = Deno.env): boolean {
  return env.get('WHATSAPP_ENABLED') === 'true' && !!env.get('WHATSAPP_TOKEN') && !!env.get('WHATSAPP_PHONE_NUMBER_ID')
}

/**
 * Sends `text` as a session message. When WHATSAPP_USE_TEMPLATES=true and a template name is given, sends the approved
 * template `bnb_<name>` (English) with the body parameters instead: required for business-initiated messages
 * outside the 24-hour customer-service window.
 */
export async function sendWhatsApp(
  to: string, text: string, tpl?: { name: string; params: string[] }, env = Deno.env,
): Promise<SendResult> {
  if (!whatsappConfigured(env)) return { status: 'skipped', reason: 'WhatsApp sending is switched off' }
  try {
    const useTemplate = env.get('WHATSAPP_USE_TEMPLATES') === 'true' && tpl
    const body = useTemplate
      ? {
          messaging_product: 'whatsapp', to, type: 'template',
          template: { name: `bnb_${tpl!.name}`, language: { code: 'en' }, components: [{ type: 'body', parameters: tpl!.params.map((text) => ({ type: 'text', text })) }] },
        }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: true } }
    const res = await fetch(`${GRAPH}/${env.get('WHATSAPP_PHONE_NUMBER_ID')}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.get('WHATSAPP_TOKEN')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await res.json().catch(() => ({})) as { messages?: { id: string }[]; error?: { message?: string } }
    if (!res.ok) return { status: 'failed', error: j.error?.message ?? `WhatsApp API ${res.status}` }
    return { status: 'sent', providerId: j.messages?.[0]?.id ?? null }
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : 'send failed' }
  }
}
