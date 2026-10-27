// create-booking: the ONLY way guests create bookings. Public, but throttled by IP and by phone.
// Pricing, deposit and availability are decided in the database (create_booking RPC), never by the client.
import { z } from 'npm:zod@3.24.1'
import { HttpError, clientIp, json, readJson, serve } from '../_shared/http.ts'
import { serviceClient } from '../_shared/supabase.ts'
import { normalizePhone } from '../_shared/phone.ts'
import { redactPhone } from '../_shared/log.ts'

declare const Deno: { serve(h: (r: Request) => Promise<Response>): void }

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use dates like 2026-11-03')
const Body = z.object({
  unit_id: z.string().uuid(),
  check_in: ymd,
  check_out: ymd,
  guests: z.number().int().min(1).max(20),
  name: z.string().trim().min(2, 'Please enter your name').max(80),
  phone: z.string().trim().min(1, 'Please enter your phone number'),
  email: z.string().trim().email().max(120).optional().or(z.literal('')),
  source: z.enum(['website', 'whatsapp']).default('website'),
  // Kenya Data Protection Act: website bookings must carry explicit consent to the privacy notice.
  consent: z.boolean().optional(),
})

Deno.serve(serve('create-booking', async (req, log) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.')
  const parsed = Body.safeParse(await readJson(req))
  if (!parsed.success) throw new HttpError(400, 'invalid_input', parsed.error.issues[0]?.message ?? 'Invalid input.')
  const b = parsed.data
  if (b.source === 'website' && b.consent !== true) throw new HttpError(400, 'consent_required', 'Please agree to the privacy notice to continue.')
  if (b.check_out <= b.check_in) throw new HttpError(400, 'invalid_dates', 'Check-out must be after check-in.')
  const phone = normalizePhone(b.phone)
  if (!phone.ok) throw new HttpError(400, 'invalid_phone', phone.error)

  const db = serviceClient()
  // Throttle: 10 attempts / 10 min per IP, 5 per phone. Stops hold-hoarding and enumeration.
  const ip = clientIp(req)
  const [ipOk, phoneOk] = await Promise.all([
    db.rpc('check_rate_limit', { p_key: `create-booking:ip:${ip}`, p_max: 10, p_window_seconds: 600 }),
    db.rpc('check_rate_limit', { p_key: `create-booking:phone:${phone.phone}`, p_max: 5, p_window_seconds: 600 }),
  ])
  if (ipOk.data === false || phoneOk.data === false) throw new HttpError(429, 'rate_limited', 'Too many attempts. Please wait a few minutes and try again.')

  const { data, error } = await db.rpc('create_booking', {
    p_unit: b.unit_id, p_in: b.check_in, p_out: b.check_out, p_guests: b.guests,
    p_guest_name: b.name, p_guest_phone: phone.phone, p_guest_email: b.email || null,
    p_source: b.source, p_mode: 'hold',
  })
  if (error) {
    if (error.code === '23P01') throw new HttpError(409, 'dates_taken', 'Those dates were just taken. Please choose other dates.')
    if (error.code === '23514') throw new HttpError(400, 'invalid_booking', error.message)
    if (error.code === 'P0002') throw new HttpError(404, 'unit_not_found', 'That unit is not available.')
    log.error('create_booking failed', { code: error.code, message: error.message })
    throw new HttpError(500, 'booking_failed', 'We could not create your booking. Please try again.')
  }
  const row = data as {
    id: string; reference: string; public_token: string; status: string; check_in: string; check_out: string; nights: number
    total_amount: number; deposit_required: number; hold_expires_at: string | null
  }
  log.info('booking held', { reference: row.reference, phone: redactPhone(phone.phone) })
  return json(req, {
    booking: {
      id: row.id, reference: row.reference, public_token: row.public_token, status: row.status,
      check_in: row.check_in, check_out: row.check_out, nights: row.nights,
      total_amount: row.total_amount, deposit_required: row.deposit_required, hold_expires_at: row.hold_expires_at,
    },
  }, 201)
}))
