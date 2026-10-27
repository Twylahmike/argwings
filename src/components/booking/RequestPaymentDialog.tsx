import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { callFunction, FunctionError, sb } from '~/lib/supabase'
import { formatKES, parseKES } from '~/lib/money'
import { formatPhoneLocal, normalizePhone } from '~/lib/phone'
import { mpesaFailureMessage } from '~/lib/payment-messages'
import type { BookingRow } from '~/lib/bookings-api'
import type { Payment } from '~/lib/types'
import { Button } from '~/components/ui/button'
import { Dialog, DialogContent } from '~/components/ui/dialog'
import { Field, Input, Select } from '~/components/ui/form'

/** Staff asks the guest to pay by M-Pesa (STK push to the guest's phone). Follows the payment live until it settles. */
export function RequestPaymentDialog({ booking, onClose, onDone }: { booking: BookingRow; onClose: () => void; onDone: () => void }) {
  const owing = Math.max(0, booking.total_amount - booking.amount_paid)
  const depositShortfall = Math.max(0, booking.deposit_required - booking.amount_paid)
  const [kind, setKind] = useState<'deposit' | 'balance'>(depositShortfall > 0 ? 'deposit' : 'balance')
  const [amount, setAmount] = useState(String(kind === 'deposit' ? depositShortfall : owing))
  const [phone, setPhone] = useState(booking.guest ? formatPhoneLocal(booking.guest.phone) : '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [paymentId, setPaymentId] = useState<string | null>(null)

  const status = useQuery({
    queryKey: ['stk-status', paymentId],
    enabled: !!paymentId,
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 2000 : false),
    queryFn: async () => {
      const { data, error: err } = await sb().from('payments').select('*').eq('id', paymentId!).single()
      if (err) throw err
      return data as Payment
    },
  })
  const p = status.data

  async function send() {
    setError('')
    const ph = normalizePhone(phone)
    if (!ph.ok) return setError(ph.error)
    const n = parseKES(amount)
    if (!n || n < 10) return setError('The smallest payment is KES 10.')
    if (n > owing) return setError(`That is more than the balance of ${formatKES(owing)}.`)
    setBusy(true)
    try {
      const r = await callFunction<{ payment_id: string }>('mpesa-stk-push', { booking_id: booking.id, phone: ph.phone, amount: n, kind })
      setPaymentId(r.payment_id)
    } catch (e) {
      setError(e instanceof FunctionError ? e.message : 'Could not reach the payment service.')
    } finally { setBusy(false) }
  }

  const finish = () => { onDone() }
  return (
    <Dialog open onOpenChange={(o) => !o && (p?.status === 'succeeded' ? finish() : onClose())}>
      <DialogContent title="Request payment by M-Pesa" description={`Balance now ${formatKES(owing)}. The guest gets a prompt on their phone and enters their PIN.`}>
        {!paymentId && (
          <div className="grid gap-4">
            <Field label="What is it for?" htmlFor="rq-kind">
              <Select id="rq-kind" value={kind} onChange={(e) => { const k = e.target.value as 'deposit' | 'balance'; setKind(k); setAmount(String(k === 'deposit' ? depositShortfall || owing : owing)) }}>
                <option value="deposit">Deposit</option><option value="balance">Balance</option>
              </Select>
            </Field>
            <Field label="Amount (KES)" htmlFor="rq-amount" hint={`Up to ${formatKES(owing)}`}><Input id="rq-amount" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
            <Field label="Guest's M-Pesa number" htmlFor="rq-phone"><Input id="rq-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <Button loading={busy} onClick={send}>Send payment request</Button>
          </div>
        )}
        {paymentId && (
          <div className="grid gap-3 py-2 text-center" role="status" aria-live="polite">
            {(!p || p.status === 'pending') && <><Loader2 className="mx-auto h-8 w-8 animate-spin text-brand" aria-hidden /><p className="font-medium">Waiting for the guest to enter their PIN…</p><p className="text-sm text-muted-foreground">This page updates by itself. If nothing happens in 2 minutes, ask the guest to try again or record the payment manually.</p></>}
            {p?.status === 'succeeded' && <><CheckCircle2 className="mx-auto h-8 w-8 text-emerald-600" aria-hidden /><p className="font-medium">{formatKES(p.amount)} received</p><p className="text-sm text-muted-foreground">M-Pesa code {p.mpesa_receipt ?? '(pending)'}</p><Button onClick={finish}>Done</Button></>}
            {p && (p.status === 'failed' || p.status === 'cancelled') && <><XCircle className="mx-auto h-8 w-8 text-danger" aria-hidden /><p className="text-sm">{mpesaFailureMessage(p.result_code, p.result_desc)}</p><div className="flex justify-center gap-2"><Button onClick={() => setPaymentId(null)}>Try again</Button><Button variant="ghost" onClick={onClose}>Close</Button></div></>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
