// send-reminders (cron, daily 08:00 Nairobi): check-in reminders, balance reminders, thank-yous.
// Never duplicates: a (booking, template) pair that already has a message_log row is skipped.
import { json, requireServiceRole, serve } from '../_shared/http.ts'
import { serviceClient } from '../_shared/supabase.ts'
import { deliver, sendBookingTemplate } from '../_shared/messaging.ts'
import { addDays, todayNairobi } from '../_shared/format.ts'
import type { TemplateName } from '../_shared/templates.ts'

declare const Deno: { serve(h: (r: Request) => Promise<Response>): void }

Deno.serve(serve('send-reminders', async (req, log) => {
  requireServiceRole(req)
  const db = serviceClient()
  const today = todayNairobi()
  const { data: s } = await db.from('settings').select('key, value').in('key', ['reminder_days_before', 'balance_reminder_days_before', 'checkout_reminder_days_before'])
  const cfg = Object.fromEntries((s ?? []).map((r) => [r.key as string, Number(r.value)]))
  const checkinDays = Number.isFinite(cfg.reminder_days_before) ? cfg.reminder_days_before : 1
  const balanceDays = Number.isFinite(cfg.balance_reminder_days_before) ? cfg.balance_reminder_days_before : 2

  const checkoutDays = Number.isFinite(cfg.checkout_reminder_days_before) ? cfg.checkout_reminder_days_before : 0
  const counts: Record<string, number> = { checkin_reminder: 0, balance_reminder: 0, checkout_reminder: 0, thank_you: 0, retried: 0 }
  const already = async (bookingId: string, template: TemplateName) => {
    const { count } = await db.from('message_log').select('id', { count: 'exact', head: true }).eq('booking_id', bookingId).eq('template', template)
    return (count ?? 0) > 0
  }
  const run = async (template: Exclude<TemplateName, 'custom'>, rows: { id: string }[] | null) => {
    for (const r of rows ?? []) {
      if (await already(r.id, template)) continue
      if (await sendBookingTemplate(db, log, r.id, template)) counts[template]++
    }
  }

  const { data: arrivals } = await db.from('bookings').select('id').eq('status', 'confirmed').eq('check_in', addDays(today, checkinDays))
  await run('checkin_reminder', arrivals)
  const { data: owing } = await db.from('bookings').select('id, total_amount, amount_paid').in('status', ['confirmed', 'pending']).eq('check_in', addDays(today, balanceDays))
  await run('balance_reminder', (owing ?? []).filter((b) => b.total_amount - b.amount_paid > 0))
  const { data: leaving } = await db.from('bookings').select('id').eq('status', 'checked_in').eq('check_out', addDays(today, checkoutDays))
  await run('checkout_reminder', leaving)
  const { data: left } = await db.from('bookings').select('id').eq('status', 'checked_out').eq('check_out', addDays(today, -1))
  await run('thank_you', left)

  // Retry reminders that failed in the last day (at most 3 attempts each). Skipped messages are never retried. WhatsApp rows only.
  const { data: failed } = await db.from('message_log').select('id, to_phone, body, attempts, booking_id, guest_id, property_id, template')
    .eq('status', 'failed').eq('channel', 'whatsapp').gte('created_at', new Date(Date.now() - 24 * 3600_000).toISOString()).lt('attempts', 3).limit(50)
  for (const m of failed ?? []) {
    if (!m.body) continue
    const out = await deliver(db, log, { bookingId: m.booking_id, guestId: m.guest_id, propertyId: m.property_id, to: m.to_phone, template: m.template as TemplateName, text: m.body as string, existingLogId: m.id as string })
    await db.from('message_log').update({ attempts: (m.attempts as number) + 1, last_attempt_at: new Date().toISOString() }).eq('id', m.id)
    if (out.status === 'sent') counts.retried++
  }

  log.info('reminders done', counts)
  return json(req, counts)
}))
