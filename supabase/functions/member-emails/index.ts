// member-emails: the branded emails of the membership programme.
//   action "welcome"  (signed-in member)   welcome email + "your offer is ready" for their own pending rewards. Idempotent.
//   action "sweep"    (service role / cron) issues birthday rewards, then emails every reward still waiting.
//   action "promote"  (staff with offers.manage) emails an open member offer to opted-in members.
// "sent" means the email provider ACCEPTED the message. Delivery is never claimed.
import { z } from 'npm:zod@3.24.1'
import { HttpError, json, readJson, safeEqual, serve } from '../_shared/http.ts'
import { serviceClient } from '../_shared/supabase.ts'
import { deliverEmail } from '../_shared/messaging.ts'
import { renderMemberEmail, type MemberContext, type MemberEmailKind } from '../_shared/member-emails.ts'

declare const Deno: { serve(h: (r: Request) => Promise<Response>): void; env: { get(k: string): string | undefined } }

const Body = z.object({ action: z.enum(['welcome', 'sweep', 'promote']).default('sweep'), offer_id: z.string().uuid().optional() })

type Pending = { reward_id: string; user_id: string; email: string; full_name: string; audience: string; name: string; description: string | null; terms: string | null; kind: 'percent' | 'fixed'; value: number; max_discount: number | null; min_total: number; code: string; expires_at: string | null }

Deno.serve(serve('member-emails', async (req, log) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.')
  const parsed = Body.safeParse(await readJson(req).catch(() => ({})))
  if (!parsed.success) throw new HttpError(400, 'invalid_input', 'Invalid input.')
  const { action, offer_id } = parsed.data
  const db = serviceClient()
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const isService = safeEqual(bearer, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')

  // Business details for the email footer come from Settings, never from code.
  const { data: rows } = await db.from('settings').select('key, value').in('key', ['business_name', 'business_email', 'business_address', 'support_whatsapp'])
  const s = Object.fromEntries((rows ?? []).map((r) => [r.key as string, r.value as unknown]))
  const str = (v: unknown) => (typeof v === 'string' && v && v !== 'Your BNB Brand' ? v : '')
  const base = {
    business: str(s.business_name) || Deno.env.get('BUSINESS_NAME') || 'RG Wings Stays',
    site: (Deno.env.get('SITE_URL') ?? '').replace(/\/$/, ''),
    contactPhone: str(s.support_whatsapp) ? `+${str(s.support_whatsapp)}` : null, contactEmail: str(s.business_email) || null, address: str(s.business_address) || null,
  }
  const send = async (kind: MemberEmailKind, to: string, name: string, offer?: MemberContext['offer'], rewardId?: string) => {
    const mail = renderMemberEmail(kind, { ...base, name, offer })
    const r = await deliverEmail(db, log, { bookingId: null, guestId: null, propertyId: null, to, template: 'custom', subject: mail.subject, text: mail.text, cta: mail.cta })
    if (r.status === 'sent' && rewardId) await db.rpc('mark_reward_emailed', { p_reward: rewardId })
    return r.status
  }
  const asOffer = (p: Pending): MemberContext['offer'] => ({ name: p.name, description: p.description, terms: p.terms, kind: p.kind, value: p.value, maxDiscount: p.max_discount, minTotal: p.min_total, code: p.code, expiresAt: p.expires_at })
  const pendingFor = async (user: string | null) => ((await db.rpc('pending_reward_emails', { p_user: user })).data ?? []) as Pending[]

  if (action === 'welcome') {
    const { data: u } = await db.auth.getUser(bearer)
    if (!u.user) throw new HttpError(401, 'unauthorized', 'Sign in first.')
    const { data: cp } = await db.from('customer_profiles').select('user_id, full_name, email, status, welcome_emailed_at').eq('user_id', u.user.id).maybeSingle()
    if (!cp || cp.status !== 'active') throw new HttpError(403, 'not_a_member', 'No active membership.')
    const ok = await db.rpc('check_rate_limit', { p_key: `member-emails:${cp.user_id}`, p_max: 5, p_window_seconds: 3600 })
    if (ok.data === false) return json(req, { sent: 0, skipped: 'rate_limited' })
    let sent = 0
    if (!cp.welcome_emailed_at) {
      const st = await send('welcome', cp.email as string, cp.full_name as string)
      if (st === 'sent') { await db.rpc('mark_welcome_emailed', { p_user: cp.user_id }); sent++ }
    }
    for (const p of await pendingFor(cp.user_id as string)) if (await send(p.audience === 'birthday' ? 'birthday' : 'welcome_offer', p.email, p.full_name, asOffer(p), p.reward_id) === 'sent') sent++
    return json(req, { sent })
  }

  if (action === 'sweep') {
    if (!isService) throw new HttpError(403, 'forbidden', 'Not allowed.')
    let sent = 0
    for (const p of await pendingFor(null)) if (await send(p.audience === 'birthday' ? 'birthday' : 'welcome_offer', p.email, p.full_name, asOffer(p), p.reward_id) === 'sent') sent++
    return json(req, { sent })
  }

  // promote
  if (!offer_id) throw new HttpError(400, 'offer_required', 'Choose an offer.')
  const { data: u } = await db.auth.getUser(bearer)
  const allowed = u.user ? (await db.rpc('has_permission', { _uid: u.user.id, _perm: 'offers.manage' })).data === true : false
  if (!allowed) throw new HttpError(403, 'forbidden', 'You cannot send member promotions.')
  const { data: o } = await db.from('promotional_offers').select('name, description, terms, kind, value, max_discount, min_total, valid_to').eq('id', offer_id).eq('active', true).eq('audience', 'member').maybeSingle()
  if (!o) throw new HttpError(404, 'not_found', 'That offer is not an active member offer.')
  const { data: to } = await db.rpc('promo_recipients', { p_offer: offer_id })
  let accepted = 0; let failed = 0; let skipped = 0
  for (const r of (to ?? []) as { email: string; full_name: string }[]) {
    const st = await send('promotion', r.email, r.full_name, { name: o.name as string, description: o.description as string | null, terms: o.terms as string | null, kind: o.kind as 'percent' | 'fixed', value: o.value as number, maxDiscount: o.max_discount as number | null, minTotal: o.min_total as number, expiresAt: o.valid_to ? `${o.valid_to}` : null })
    if (st === 'sent') accepted++; else if (st === 'failed') failed++; else skipped++
  }
  return json(req, { recipients: (to ?? []).length, accepted, failed, skipped })
}))
