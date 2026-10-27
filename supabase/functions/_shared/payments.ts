// Settling STK payments. Shared by mpesa-callback (push) and mpesa-reconcile (pull).
// Idempotency lives in the database: unique checkout_request_id and unique mpesa_receipt, plus the
// `where status in (...)` guard below, so a replayed callback can never credit twice.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import type { Logger } from './log.ts'
import { notifyOwner, sendBookingTemplate } from './messaging.ts'

export type PaymentRow = {
  id: string; booking_id: string; amount: number; status: string; kind: string; phone: string | null
  checkout_request_id: string | null; created_at: string
}

export type Settle =
  | { outcome: 'success'; amount?: number; receipt?: string; phone?: string; resultDesc?: string; raw?: unknown }
  | { outcome: 'failed' | 'cancelled'; code: number; desc: string; raw?: unknown }

export async function settlePayment(db: SupabaseClient, log: Logger, p: PaymentRow, s: Settle): Promise<{ changed: boolean }> {
  if (s.outcome !== 'success') {
    // Only a still-pending payment can fail; never downgrade a success.
    const { data } = await db.from('payments').update({ status: s.outcome, result_code: s.code, result_desc: s.desc, raw: s.raw ?? null })
      .eq('id', p.id).eq('status', 'pending').select('id')
    return { changed: (data?.length ?? 0) > 0 }
  }

  // Amount verification: what Safaricom says was paid must equal what we asked for.
  if (s.amount !== undefined && Math.round(s.amount) !== p.amount) {
    const desc = `AMOUNT_MISMATCH: asked ${p.amount}, M-Pesa reports ${s.amount}`
    const { data } = await db.from('payments').update({ status: 'failed', result_code: 0, result_desc: desc, mpesa_receipt: null, raw: s.raw ?? null })
      .eq('id', p.id).eq('status', 'pending').select('id')
    if (data?.length) {
      await db.from('bookings').update({ payment_review: true, review_reason: `M-Pesa reported ${s.amount} but ${p.amount} was requested (receipt ${s.receipt ?? 'unknown'}). Check the M-Pesa statement and record the correct amount manually.` }).eq('id', p.booking_id)
      log.error('payment amount mismatch', { paymentId: p.id, expected: p.amount, got: s.amount })
      const { data: b } = await db.from('bookings').select('reference, property_id').eq('id', p.booking_id).maybeSingle()
      await notifyOwner(db, log, b?.property_id ?? null, `⚠️ Payment needs review: booking ${b?.reference ?? ''}. M-Pesa reported KES ${s.amount} but KES ${p.amount} was requested (receipt ${s.receipt ?? 'n/a'}).`)
    }
    return { changed: !!data?.length }
  }

  // pending -> succeeded, and also failed -> succeeded (a late callback after our own timeout: the money DID move).
  const { data, error } = await db.from('payments').update({
    status: 'succeeded', result_code: 0, result_desc: s.resultDesc ?? 'Success', mpesa_receipt: s.receipt ?? null,
    phone: s.phone ?? p.phone, confirmed_at: new Date().toISOString(), raw: s.raw ?? null,
  }).eq('id', p.id).in('status', ['pending', 'failed']).select('id')
  if (error) {
    if (error.code === '23505') { log.warn('duplicate M-Pesa receipt ignored', { paymentId: p.id }); return { changed: false } }
    throw error
  }
  if (!data?.length) return { changed: false }
  await afterPaymentSuccess(db, log, p)
  return { changed: true }
}

async function afterPaymentSuccess(db: SupabaseClient, log: Logger, p: PaymentRow) {
  const { data: b } = await db.from('bookings').select('reference, property_id, status, payment_review, review_reason, deposit_required, amount_paid, total_amount').eq('id', p.booking_id).maybeSingle()
  if (!b) return
  const { data: pay } = await db.from('payments').select('mpesa_receipt').eq('id', p.id).maybeSingle()
  const receiptNo = pay?.mpesa_receipt ?? null
  if (b.payment_review) {
    await notifyOwner(db, log, b.property_id, `⚠️ Payment needs review: booking ${b.reference}. ${b.review_reason ?? ''}`)
  }
  // Fire-and-forget style, but awaited so logs are written; errors are swallowed inside.
  await sendBookingTemplate(db, log, p.booking_id, 'payment_receipt', { amount: p.amount, receiptNo })
  if (p.kind === 'deposit' || p.kind === 'full') await sendBookingTemplate(db, log, p.booking_id, 'booking_confirmed')
}
