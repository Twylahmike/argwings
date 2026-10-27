// mpesa-callback: called by Safaricom (verify_jwt = false). Protected by the secret in ?token=.
// ALWAYS answers HTTP 200 {"ResultCode":0,"ResultDesc":"Accepted"} quickly, even for unknown or duplicate callbacks,
// because Safaricom does not retry. Reconciliation (mpesa-reconcile) is the safety net for anything we miss.
import { json, safeEqual, serve, HttpError } from '../_shared/http.ts'
import { serviceClient } from '../_shared/supabase.ts'
import { classifyResult, parseCallback } from '../_shared/daraja.ts'
import { settlePayment, type PaymentRow } from '../_shared/payments.ts'

declare const Deno: { serve(h: (r: Request) => Promise<Response>): void; env: { get(k: string): string | undefined } }

const ACK = { ResultCode: 0, ResultDesc: 'Accepted' }

Deno.serve(serve('mpesa-callback', async (req, log) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.')
  const secret = Deno.env.get('MPESA_CALLBACK_SECRET') ?? ''
  const given = new URL(req.url).searchParams.get('token') ?? ''
  if (secret.length < 16 || !safeEqual(given, secret)) throw new HttpError(401, 'unauthorized', 'Invalid callback token.')

  let body: unknown
  try { body = await req.json() } catch { log.warn('callback with invalid JSON'); return json(req, ACK) }
  const cb = parseCallback(body)
  if (!cb) { log.warn('callback is not an STK callback'); return json(req, ACK) }

  try {
    const db = serviceClient()
    const find = () => db.from('payments').select('id, booking_id, amount, status, kind, phone, checkout_request_id, created_at')
      .eq('checkout_request_id', cb.checkoutRequestId).maybeSingle()
    let { data: payment } = await find()
    if (!payment) {
      // The callback can beat our own "store checkout id" update by milliseconds: look once more.
      await new Promise((r) => setTimeout(r, 1500))
      ;({ data: payment } = await find())
    }
    if (!payment) {
      log.warn('callback for unknown payment', { checkoutRequestId: cb.checkoutRequestId, code: cb.resultCode })
      await db.from('audit_log').insert({ action: 'mpesa.orphan_callback', entity: 'payment', entity_id: cb.checkoutRequestId, diff: body as Record<string, unknown> })
      return json(req, ACK)
    }
    const row = payment as PaymentRow
    if (row.status === 'succeeded') { log.info('duplicate callback ignored', { paymentId: row.id }); return json(req, ACK) }

    const kind = classifyResult(cb.resultCode)
    const r = kind === 'success'
      ? await settlePayment(db, log, row, { outcome: 'success', amount: cb.amount, receipt: cb.receipt, phone: cb.phone, resultDesc: cb.resultDesc, raw: body })
      : await settlePayment(db, log, row, { outcome: kind, code: cb.resultCode, desc: cb.resultDesc, raw: body })
    log.info('callback processed', { paymentId: row.id, result: kind, changed: r.changed })
  } catch (e) {
    // Never bubble up: Safaricom gets 200 regardless, reconcile will pick the payment up.
    log.error('callback handling error', { message: e instanceof Error ? e.message : String(e) })
  }
  return json(req, ACK)
}))
