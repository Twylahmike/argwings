// whatsapp-webhook (verify_jwt = false): Meta calls this.
//  GET  = webhook verification (hub.verify_token must equal WHATSAPP_VERIFY_TOKEN)
//  POST = delivery status updates (sent / delivered / read / failed) written to message_log.
// If WHATSAPP_APP_SECRET is set, the X-Hub-Signature-256 header is verified (recommended in production).
// Inbound guest messages are ignored on purpose: a WhatsApp chatbot is out of scope (extension point below).
import { safeEqual, serve } from '../_shared/http.ts'
import { serviceClient } from '../_shared/supabase.ts'

declare const Deno: { serve(h: (r: Request) => Promise<Response>): void; env: { get(k: string): string | undefined } }

async function validSignature(raw: string, header: string | null): Promise<boolean> {
  const secret = Deno.env.get('WHATSAPP_APP_SECRET')
  if (!secret) return true
  if (!header?.startsWith('sha256=')) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw))
  const hex = Array.from(new Uint8Array(sig)).map((x) => x.toString(16).padStart(2, '0')).join('')
  return safeEqual(hex, header.slice(7))
}

type Status = { id: string; status: string; errors?: { title?: string; message?: string }[] }

Deno.serve(serve('whatsapp-webhook', async (req, log) => {
  if (req.method === 'GET') {
    const u = new URL(req.url)
    const verify = Deno.env.get('WHATSAPP_VERIFY_TOKEN') ?? ''
    if (u.searchParams.get('hub.mode') === 'subscribe' && verify && safeEqual(u.searchParams.get('hub.verify_token') ?? '', verify)) {
      return new Response(u.searchParams.get('hub.challenge') ?? '', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    }
    return new Response('Forbidden', { status: 403 })
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const raw = await req.text()
  if (!(await validSignature(raw, req.headers.get('x-hub-signature-256')))) {
    log.warn('webhook signature mismatch')
    return new Response('Forbidden', { status: 403 })
  }
  try {
    const body = JSON.parse(raw) as { entry?: { changes?: { value?: { statuses?: Status[] } }[] }[] }
    const db = serviceClient()
    const rank: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 9 }
    for (const e of body.entry ?? []) for (const c of e.changes ?? []) for (const s of c.value?.statuses ?? []) {
      if (!['sent', 'delivered', 'read', 'failed'].includes(s.status)) continue
      const { data: row } = await db.from('message_log').select('id, status').eq('provider_id', s.id).maybeSingle()
      if (!row) continue
      // Never move a message backwards (webhooks can arrive out of order).
      if ((rank[row.status] ?? 0) >= (rank[s.status] ?? 0) && s.status !== 'failed') continue
      await db.from('message_log').update({ status: s.status, error: s.status === 'failed' ? (s.errors?.[0]?.message ?? s.errors?.[0]?.title ?? 'failed') : null }).eq('id', row.id)
    }
    // EXTENSION POINT: inbound `messages` (guest replies) could be routed to a future chatbot here.
  } catch (e) {
    log.warn('webhook processing error', { message: e instanceof Error ? e.message : String(e) })
  }
  return new Response('ok', { status: 200 })
}))
