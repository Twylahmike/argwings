// Builds, sends and logs WhatsApp messages for a booking. Used by payment callbacks, reminders and send-whatsapp.
// Everything here swallows errors: messaging must never break a booking or payment.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { applyOverride, emailSubject, renderTemplate, type TemplateContext, type TemplateName } from './templates.ts'
import { sendWhatsApp } from './whatsapp.ts'
import { isEmail, sendEmail } from './email.ts'
import type { Logger } from './log.ts'

declare const Deno: { env: { get(k: string): string | undefined } }

export type BookingContext = TemplateContext & { bookingId: string; guestId: string | null; propertyId: string; phone: string; email: string | null }

export async function loadBookingContext(db: SupabaseClient, bookingId: string): Promise<BookingContext | null> {
  const { data: b } = await db.from('bookings')
    .select('id, reference, public_token, property_id, guest_id, check_in, check_out, nights, total_amount, amount_paid, guest:guests(full_name, phone, email), unit:units(name), property:properties(name, address, area, city, check_in_time, check_out_time, contact_phone)')
    .eq('id', bookingId).maybeSingle()
  if (!b || !b.guest) return null
  const guest = b.guest as unknown as { full_name: string; phone: string; email: string | null }
  const unit = b.unit as unknown as { name: string }
  const prop = b.property as unknown as { name: string; address: string | null; area: string | null; city: string; check_in_time: string; check_out_time: string; contact_phone: string | null }
  const { data: settings } = await db.from('settings').select('key, value').in('key', ['business_name', 'mpesa_paybill_display'])
  const s = Object.fromEntries((settings ?? []).map((r) => [r.key as string, r.value as unknown]))
  const site = (Deno.env.get('SITE_URL') ?? '').replace(/\/$/, '')
  return {
    bookingId: b.id, guestId: b.guest_id, propertyId: b.property_id, phone: guest.phone, email: guest.email,
    business: typeof s.business_name === 'string' && s.business_name ? s.business_name : (Deno.env.get('BUSINESS_NAME') ?? 'Your BNB'),
    guestName: guest.full_name, reference: b.reference, link: `${site}/booking/${b.public_token}`,
    property: prop.name, unit: unit.name, address: [prop.address, prop.area, prop.city].filter(Boolean).join(', '),
    checkIn: b.check_in, checkOut: b.check_out, nights: b.nights, checkInTime: prop.check_in_time, checkOutTime: prop.check_out_time,
    total: b.total_amount, paid: b.amount_paid, balance: Math.max(0, b.total_amount - b.amount_paid),
    paybill: (typeof s.mpesa_paybill_display === 'string' && s.mpesa_paybill_display) || Deno.env.get('MPESA_PAYBILL_DISPLAY') || null,
    contactPhone: prop.contact_phone,
  }
}

/** Is WhatsApp enabled in Settings (the env switch is checked separately inside sendWhatsApp)? */
async function enabledInSettings(db: SupabaseClient): Promise<boolean> {
  const { data } = await db.from('settings').select('value').eq('key', 'whatsapp_enabled').maybeSingle()
  return data?.value === true
}

export type Outcome = { status: 'sent' | 'skipped' | 'failed'; logId: string | null; text: string; email?: 'sent' | 'skipped' | 'failed' }

/** Render, log and (if enabled) send a template to the guest of a booking. */
export async function sendBookingTemplate(
  db: SupabaseClient, log: Logger, bookingId: string, template: Exclude<TemplateName, 'custom'>, extra: Partial<TemplateContext> = {},
): Promise<Outcome | null> {
  try {
    const ctx = await loadBookingContext(db, bookingId)
    if (!ctx) return null
    const full = { ...ctx, ...extra }
    // Owner-edited wording and on/off switch (table may not exist yet on an older database: then the built-in text is used).
    const { data: custom } = await db.from('message_templates').select('body, enabled').eq('key', template).maybeSingle()
    const built = renderTemplate(template, full)
    const text = custom?.body ? applyOverride(custom.body as string, full) : built.text
    const params = custom?.body ? undefined : built.params
    if (custom && custom.enabled === false) return { status: 'skipped', logId: null, text }
    // Guests who opted out still get confirmations and receipts, but not reminders or thank-yous.
    if (!['booking_confirmed', 'payment_receipt'].includes(template) && ctx.guestId) {
      const { data: g } = await db.from('guests').select('comms_opt_out').eq('id', ctx.guestId).maybeSingle()
      if (g?.comms_opt_out === true) return { status: 'skipped', logId: null, text }
    }
    const out = await deliver(db, log, { bookingId, guestId: ctx.guestId, propertyId: ctx.propertyId, to: ctx.phone, template, text, params })
    // Same message by email when the guest left an address. Independent of WhatsApp: either channel can be off.
    const email = isEmail(ctx.email)
      ? await deliverEmail(db, log, { bookingId, guestId: ctx.guestId, propertyId: ctx.propertyId, to: ctx.email, template, subject: emailSubject(template, full), text })
      : null
    return email ? { ...out, email: email.status } : out
  } catch (e) {
    log.error('sendBookingTemplate failed', { template, message: e instanceof Error ? e.message : String(e) })
    return null
  }
}

export async function deliver(
  db: SupabaseClient, log: Logger,
  m: { bookingId: string | null; guestId: string | null; propertyId: string | null; to: string; template: TemplateName; text: string; params?: string[]; existingLogId?: string },
): Promise<Outcome> {
  // A retry updates the original log row instead of writing a duplicate.
  const { data: row } = m.existingLogId ? { data: { id: m.existingLogId } } : await db.from('message_log').insert({
    booking_id: m.bookingId, guest_id: m.guestId, property_id: m.propertyId, template: m.template, to_phone: m.to, body: m.text, status: 'queued',
  }).select('id').single()
  const logId = (row?.id as string | undefined) ?? null
  let result = await sendWhatsApp(m.to, m.text, m.params ? { name: m.template, params: m.params } : undefined)
  if (result.status !== 'skipped' && !(await enabledInSettings(db))) result = { status: 'skipped', reason: 'WhatsApp is switched off in Settings' }
  if (logId) {
    await db.from('message_log').update({
      status: result.status, provider_id: result.status === 'sent' ? result.providerId : null,
      error: result.status === 'failed' ? result.error : result.status === 'skipped' ? result.reason : null,
    }).eq('id', logId)
  }
  if (result.status === 'failed') log.warn('whatsapp send failed', { template: m.template, error: result.error })
  return { status: result.status, logId, text: m.text }
}

async function emailEnabledInSettings(db: SupabaseClient): Promise<boolean> {
  const { data } = await db.from('settings').select('value').eq('key', 'email_enabled').maybeSingle()
  return data?.value === true
}

/** Log and (if enabled) send an email. The log row reuses message_log with channel 'email' and the address in to_phone. */
export async function deliverEmail(
  db: SupabaseClient, log: Logger,
  m: { bookingId: string | null; guestId: string | null; propertyId: string | null; to: string; template: TemplateName; subject: string; text: string; cta?: { label: string; url: string } },
): Promise<{ status: 'sent' | 'skipped' | 'failed'; logId: string | null }> {
  const { data: row } = await db.from('message_log').insert({
    booking_id: m.bookingId, guest_id: m.guestId, property_id: m.propertyId, channel: 'email', template: m.template, to_phone: m.to, body: `${m.subject}\n\n${m.text}`, status: 'queued',
  }).select('id').single()
  const logId = (row?.id as string | undefined) ?? null
  const { data: bs } = await db.from('settings').select('value').eq('key', 'business_name').maybeSingle()
  const business = typeof bs?.value === 'string' && bs.value && bs.value !== 'Your BNB Brand' ? bs.value : (Deno.env.get('BUSINESS_NAME') ?? 'RG Wings Stays')
  let result = await sendEmail(m.to, m.subject, m.text, Deno.env, { business, cta: m.cta })
  if (result.status !== 'skipped' && !(await emailEnabledInSettings(db))) result = { status: 'skipped', reason: 'Email is switched off in Settings' }
  if (logId) {
    await db.from('message_log').update({
      status: result.status, provider_id: result.status === 'sent' ? result.providerId : null,
      error: result.status === 'failed' ? result.error : result.status === 'skipped' ? result.reason : null,
    }).eq('id', logId)
  }
  if (result.status === 'failed') log.warn('email send failed', { template: m.template, error: result.error })
  return { status: result.status, logId }
}

/** Tell the owner something needs attention (late payment, amount mismatch...). Best effort. */
export async function notifyOwner(db: SupabaseClient, log: Logger, propertyId: string | null, text: string): Promise<void> {
  try {
    const { data } = await db.from('settings').select('key, value').in('key', ['owner_notify_phone', 'support_whatsapp', 'owner_notify_email'])
    const s = Object.fromEntries((data ?? []).map((r) => [r.key as string, r.value as unknown]))
    const to = [s.owner_notify_phone, s.support_whatsapp, Deno.env.get('SUPPORT_WHATSAPP')].find((v) => typeof v === 'string' && /^254[71]\d{8}$/.test(v)) as string | undefined
    const mail = [s.owner_notify_email, Deno.env.get('OWNER_EMAIL')].find(isEmail)
    if (!to && !mail) { log.warn('no owner phone or email configured for notification'); return }
    if (to) await deliver(db, log, { bookingId: null, guestId: null, propertyId, to, template: 'custom', text })
    if (mail) await deliverEmail(db, log, { bookingId: null, guestId: null, propertyId, to: mail, template: 'custom', subject: 'Needs your attention', text })
  } catch (e) {
    log.warn('notifyOwner failed', { message: e instanceof Error ? e.message : String(e) })
  }
}
