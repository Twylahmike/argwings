import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { formatKES, parseKES } from '~/lib/money'
import { METHOD_LABEL, type PaymentKind, type PaymentMethod } from '~/lib/types'
import { errMessage } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { Dialog, DialogContent } from '~/components/ui/dialog'
import { Field, Input, Select } from '~/components/ui/form'
import type { BookingRow } from '~/lib/bookings-api'

const METHODS: PaymentMethod[] = ['mpesa_manual', 'cash', 'bank', 'other']
const KINDS: { value: PaymentKind; label: string }[] = [
  { value: 'deposit', label: 'Deposit' }, { value: 'balance', label: 'Balance' }, { value: 'full', label: 'Full payment' },
  { value: 'adjustment', label: 'Adjustment (credit)' }, { value: 'refund', label: 'Refund (money paid back)' },
]

/** Records money received (or refunded) outside the STK flow. The database trigger updates amount_paid and confirms the booking. */
export function RecordPaymentDialog({ booking, userId, onClose, onDone }: { booking: BookingRow; userId: string; onClose: () => void; onDone: () => void }) {
  const owing = Math.max(0, booking.total_amount - booking.amount_paid)
  const [kind, setKind] = useState<PaymentKind>(booking.amount_paid >= booking.deposit_required ? 'balance' : 'deposit')
  const [method, setMethod] = useState<PaymentMethod>('mpesa_manual')
  const [amount, setAmount] = useState(String(owing || ''))
  const [receipt, setReceipt] = useState('')
  const [error, setError] = useState('')

  const save = useMutation({
    mutationFn: async () => {
      const n = parseKES(amount)
      if (!n || n <= 0) throw new Error('Enter the amount as a whole number of shillings.')
      if (kind === 'refund' && n > booking.amount_paid) throw new Error(`You can refund at most ${formatKES(booking.amount_paid)}.`)
      if (kind !== 'refund' && n > owing && kind !== 'adjustment') throw new Error(`That is more than the balance of ${formatKES(owing)}.`)
      const needsRef = method === 'mpesa_manual' || method === 'bank'
      if (needsRef && kind !== 'refund' && !receipt.trim()) throw new Error(method === 'bank' ? 'Enter the bank reference.' : 'Enter the M-Pesa code from the SMS.')
      const { error: err } = await sb().from('payments').insert({
        booking_id: booking.id, kind, method, status: 'succeeded', amount: n, phone: booking.guest?.phone ?? null,
        mpesa_receipt: receipt.trim() ? receipt.trim().toUpperCase() : null, recorded_by: userId, confirmed_at: new Date().toISOString(),
      })
      if (err) throw err.code === '23505' ? new Error('That reference has already been recorded.') : err
    },
    onSuccess: () => { toast.success('Payment recorded'); onDone() },
    onError: (e) => setError(errMessage(e)),
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Record a payment" description={`Balance now: ${formatKES(owing)}. Use this for cash, bank transfers or M-Pesa received outside the app.`}>
        <div className="grid gap-4">
          <Field label="Type" htmlFor="rp-kind"><Select id="rp-kind" value={kind} onChange={(e) => setKind(e.target.value as PaymentKind)}>{KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</Select></Field>
          <Field label="Paid by" htmlFor="rp-method"><Select id="rp-method" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>{METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</Select></Field>
          <Field label="Amount (KES)" htmlFor="rp-amount"><Input id="rp-amount" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          {(method === 'mpesa_manual' || method === 'bank') && (
            <Field label={method === 'bank' ? 'Bank reference' : 'M-Pesa code'} htmlFor="rp-ref" hint="Each code can only be recorded once.">
              <Input id="rp-ref" className="uppercase" autoComplete="off" value={receipt} onChange={(e) => setReceipt(e.target.value)} placeholder="e.g. SHK4T7XYZ1" />
            </Field>
          )}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <Button loading={save.isPending} onClick={() => { setError(''); save.mutate() }}>Save payment</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
