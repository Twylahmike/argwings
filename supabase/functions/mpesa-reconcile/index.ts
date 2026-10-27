// mpesa-reconcile (cron, every 2 minutes): settles STK pushes whose callback never arrived.
// Pending 60s..15min old -> ask Daraja (stkQuery). Older than 15 min -> failed (timeout).
import { json, requireServiceRole, serve } from '../_shared/http.ts'
import { serviceClient } from '../_shared/supabase.ts'
import { classifyResult, createProvider } from '../_shared/daraja.ts'
import { settlePayment, type PaymentRow } from '../_shared/payments.ts'

declare const Deno: { serve(h: (r: Request) => Promise<Response>): void }

Deno.serve(serve('mpesa-reconcile', async (req, log) => {
  requireServiceRole(req)
  const db = serviceClient()
  const provider = createProvider()
  const now = Date.now()
  const { data: pending } = await db.from('payments')
    .select('id, booking_id, amount, status, kind, phone, checkout_request_id, created_at')
    .eq('method', 'mpesa_stk').eq('status', 'pending').lt('created_at', new Date(now - 60_000).toISOString()).limit(100)

  let settled = 0, timedOut = 0, skipped = 0
  for (const p of (pending ?? []) as PaymentRow[]) {
    const age = now - new Date(p.created_at).getTime()
    try {
      if (age > 15 * 60_000 || !p.checkout_request_id) {
        const r = await settlePayment(db, log, p, { outcome: 'failed', code: 1037, desc: 'Timed out waiting for M-Pesa' })
        if (r.changed) timedOut++
        continue
      }
      const q = await provider.stkQuery(p.checkout_request_id)
      if (q.resultCode === -1) { skipped++; continue } // customer still deciding
      const kind = classifyResult(q.resultCode)
      // A query answer has no receipt number. In real Daraja we record the payment without one and flag nothing;
      // staff can add the code from the SMS. Mock mode invents one so the unique index stays meaningful.
      const receipt = kind === 'success' && provider.name === 'mock' ? `MOCKQ${crypto.randomUUID().slice(0, 6).toUpperCase()}` : undefined
      const r = kind === 'success'
        ? await settlePayment(db, log, p, { outcome: 'success', receipt, resultDesc: 'Settled by status query' })
        : await settlePayment(db, log, p, { outcome: kind, code: q.resultCode, desc: q.resultDesc })
      if (r.changed) settled++
    } catch (e) {
      log.warn('reconcile error', { paymentId: p.id, message: e instanceof Error ? e.message : String(e) })
    }
  }
  log.info('reconcile done', { checked: pending?.length ?? 0, settled, timedOut, skipped })
  return json(req, { checked: pending?.length ?? 0, settled, timedOut, skipped })
}))
