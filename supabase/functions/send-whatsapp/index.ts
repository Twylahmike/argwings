// send-whatsapp: send a template (or custom text) to a booking's guest, log it, and degrade gracefully.
// Callers: service role (internal) or a signed-in owner/manager of the booking's property.
// If WhatsApp is off or the send fails the response still succeeds with status skipped/failed and a wa.me link,
// so staff can send the same text manually from their own phone.
import { z } from 'npm:zod@3.24.1'
import { HttpError, json, readJson, safeEqual, serve } from '../_shared/http.ts'
import { canManageProperty, serviceClient, staffFromRequest } from '../_shared/supabase.ts'
import { deliver, sendBookingTemplate } from '../_shared/messaging.ts'

declare const Deno: { serve(h: (r: Request) => Promise<Response>): void; env: { get(k: string): string | undefined } }

const Body = z.object({
  booking_id: z.string().uuid(),
  template: z.enum(['booking_confirmed', 'payment_receipt', 'balance_reminder', 'checkin_reminder', 'thank_you', 'custom']),
  text: z.string().trim().min(1).max(1500).optional(),
  amount: z.number().int().positive().optional(),
})

Deno.serve(serve('send-whatsapp', async (req, log) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.')
  const parsed = Body.safeParse(await readJson(req))
  if (!parsed.success) throw new HttpError(400, 'invalid_input', parsed.error.issues[0]?.message ?? 'Invalid input.')
  const b = parsed.data
  const db = serviceClient()

  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const isService = safeEqual(bearer, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
  const { data: booking } = await db.from('bookings').select('id, property_id, guest_id, guest:guests(phone)').eq('id', b.booking_id).maybeSingle()
  if (!booking) throw new HttpError(404, 'not_found', 'Booking not found.')
  if (!isService) {
    const caller = await staffFromRequest(req, db)
    if (!caller || !canManageProperty(caller, booking.property_id)) throw new HttpError(403, 'forbidden', 'You cannot message guests of this property.')
  }
  const phone = (booking.guest as unknown as { phone: string } | null)?.phone
  if (!phone) throw new HttpError(409, 'no_guest', 'This booking has no guest phone number.')

  let out
  if (b.template === 'custom') {
    if (!b.text) throw new HttpError(400, 'text_required', 'Write the message first.')
    out = await deliver(db, log, { bookingId: booking.id, guestId: booking.guest_id, propertyId: booking.property_id, to: phone, template: 'custom', text: b.text })
  } else {
    out = await sendBookingTemplate(db, log, booking.id, b.template, b.amount ? { amount: b.amount } : {})
    if (!out) throw new HttpError(500, 'send_failed', 'Could not prepare that message.')
  }
  return json(req, { status: out.status, log_id: out.logId, text: out.text, wa_link: `https://wa.me/${phone}?text=${encodeURIComponent(out.text)}` })
}))
