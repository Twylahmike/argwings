// send-reminders (cron, daily 08:00 Nairobi): check-in reminders, balance reminders, thank-yous.
// Never duplicates: a (booking, template) pair that already has a message_log row is skipped.
import { json, requireServiceRole, serve } from '../_shared/http.ts'
import { serviceClient } from '../_shared/supabase.ts'
import { sendBookingTemplate } from '../_shared/messaging.ts'
import { addDays, todayNairobi } from '../_shared/format.ts'
import type { TemplateName } from '../_shared/templates.ts'

declare const Deno: { serve(h: (r: Request) => Promise<Response>): void }

Deno.serve(serve('send-reminders', async (req, log) => {
  requireServiceRole(req)
  const db = serviceClient()
  const today = todayNairobi()
  const { data: s } = await db.from('settings').select('key, value').in('key', ['reminder_days_before', 'balance_reminder_days_before'])
  const cfg = Object.fromEntries((s ?? []).map((r) => [r.key as string, Number(r.value)]))
  const checkinDays = Number.isFinite(cfg.reminder_days_before) ? cfg.reminder_days_before : 1
  const balanceDays = Number.isFinite(cfg.balance_reminder_days_before) ? cfg.balance_reminder_days_before : 2

  const counts: Record<string, number> = { checkin_reminder: 0, balance_reminder: 0, thank_you: 0 }
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
  const { data: left } = await db.from('bookings').select('id').eq('status', 'checked_out').eq('check_out', addDays(today, -1))
  await run('thank_you', left)

  log.info('reminders done', counts)
  return json(req, counts)
}))
