// mpesa-stk-push: starts an M-Pesa STK prompt for a deposit or balance.
// Callers: a guest holding the booking's secret token, or a signed-in owner/manager of that property.
import { z } from 'npm:zod@3.24.1'
import { HttpError, json, readJson, serve } from '../_shared/http.ts'
import { canManageProperty, serviceClient, staffFromRequest } from '../_shared/supabase.ts'
import { normalizePhone } from '../_shared/phone.ts'
import { createProvider, ProviderError } from '../_shared/daraja.ts'
import { redactPhone } from '../_shared/log.ts'

declare const Deno: { serve(h: (r: Request) => Promise<Response>): void }

const Body = z.object({
  token: z.string().uuid().optional(),          // guest: bookings.public_token
  booking_id: z.string().uuid().optional(),     // staff
  phone: z.string().trim().min(1),
  amount: z.number().int().min(10, 'The smallest payment is KES 10.'),
  kind: z.enum(['deposit', 'balance', 'full']),
})

Deno.serve(serve('mpesa-stk-push', async (req, log) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.')
  const parsed = Body.safeParse(await readJson(req))
  if (!parsed.success) throw new HttpError(400, 'invalid_input', parsed.error.issues[0]?.message ?? 'Invalid input.')
  const b = parsed.data
  const phone = normalizePhone(b.phone)
  if (!phone.ok) throw new HttpError(400, 'invalid_phone', phone.error)

  const db = serviceClient()
  await db.rpc('expire_stale_holds') // lazy check: an unpaid hold may have just run out

  const q = db.from('bookings').select('id, reference, status, property_id, total_amount, amount_paid, deposit_required, hold_expires_at')
  const { data: booking } = await (b.token ? q.eq('public_token', b.token) : q.eq('id', b.booking_id ?? '')).maybeSingle()
  if (!booking) throw new HttpError(404, 'not_found', 'We could not find that booking.')

  let isStaff = false
  if (!b.token) {
    const caller = await staffFromRequest(req, db)
    if (!caller || !canManageProperty(caller, booking.property_id)) throw new HttpError(403, 'forbidden', 'You cannot take payments for this booking.')
    isStaff = true
  }

  if (booking.status === 'expired') throw new HttpError(409, 'hold_expired', 'This hold has expired. Please start a new booking.')
  if (!['pending', 'confirmed', 'checked_in', 'checked_out'].includes(booking.status)) throw new HttpError(409, 'not_payable', 'This booking can no longer be paid.')

  const balance = booking.total_amount - booking.amount_paid
  if (balance <= 0) throw new HttpError(409, 'nothing_due', 'This booking is already fully paid.')
  if (b.amount > balance) throw new HttpError(400, 'amount_too_high', `The most you can pay is KES ${balance.toLocaleString('en-US')}.`)
  if (!isStaff && booking.status === 'pending') {
    // Guests must pay the whole outstanding deposit to confirm: no partial deposits.
    const shortfall = Math.max(booking.deposit_required - booking.amount_paid, 0)
    if (b.amount !== shortfall) throw new HttpError(400, 'wrong_deposit', `The deposit for this booking is KES ${shortfall.toLocaleString('en-US')}.`)
  }

  // Throttle: max 3 pushes per booking per 10 minutes, and never two live prompts at once.
  const since = new Date(Date.now() - 10 * 60_000).toISOString()
  const { data: recent } = await db.from('payments').select('id, status, created_at').eq('booking_id', booking.id).eq('method', 'mpesa_stk').gte('created_at', since)
  if ((recent?.length ?? 0) >= 3) throw new HttpError(429, 'rate_limited', 'Too many payment attempts. Please wait a few minutes, or pay manually using the Paybill details.')
  if (recent?.some((r) => r.status === 'pending' && Date.now() - new Date(r.created_at).getTime() < 90_000)) {
    throw new HttpError(409, 'already_pending', 'A payment prompt is already open on your phone. Enter your PIN, or wait a minute and try again.')
  }

  const { data: payment, error: insErr } = await db.from('payments').insert({
    booking_id: booking.id, kind: b.kind, method: 'mpesa_stk', status: 'pending', amount: b.amount, phone: phone.phone,
  }).select('id').single()
  if (insErr || !payment) throw new HttpError(500, 'payment_failed', 'We could not start the payment. Please try again.')

  try {
    const provider = createProvider()
    const r = await provider.stkPush({ phone: phone.phone, amount: b.amount, reference: booking.reference, description: 'Booking' })
    await db.from('payments').update({ merchant_request_id: r.merchantRequestId, checkout_request_id: r.checkoutRequestId }).eq('id', payment.id)
    log.info('stk push sent', { provider: provider.name, reference: booking.reference, amount: b.amount, phone: redactPhone(phone.phone) })
    return json(req, { payment_id: payment.id, checkout_request_id: r.checkoutRequestId, status: 'pending' }, 201)
  } catch (e) {
    const msg = e instanceof ProviderError ? e.message : 'M-Pesa is not reachable right now'
    await db.from('payments').update({ status: 'failed', result_desc: msg.slice(0, 200) }).eq('id', payment.id)
    log.error('stk push failed', { message: msg })
    throw new HttpError(502, 'provider_error', 'We could not reach M-Pesa. Please try again in a moment, or pay manually using the Paybill details.')
  }
}))
