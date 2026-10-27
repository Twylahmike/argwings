import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, Smartphone, XCircle } from 'lucide-react'
import { callFunction, FunctionError } from '~/lib/functions'
import { formatKES, parseKES } from '~/lib/money'
import { formatPhoneLocal, normalizePhone } from '~/lib/phone'
import { mpesaFailureMessage, STK_WAIT_SECONDS } from '~/lib/payment-messages'
import { useBrand } from '~/lib/brand'
import type { PublicBooking } from '~/lib/types'
import { Button } from '~/components/ui/button'
import { Field, Input } from '~/components/ui/form'

type Pay = PublicBooking['payments'][number]

/**
 * Guest-facing M-Pesa payment box: phone + amount, "check your phone" waiting state with a countdown,
 * live success/failure (the parent polls the booking), "Try again", and the manual Paybill fallback.
 */
export function PayPanel({
  booking, token, autoStartPhone, onStarted,
}: { booking: PublicBooking; token: string; autoStartPhone?: string; onStarted: () => void }) {
  const owing = booking.balance
  const needsDeposit = booking.status === 'pending' && booking.amount_paid < booking.deposit_required
  const dueNow = needsDeposit ? booking.deposit_required - booking.amount_paid : owing
  const [phone, setPhone] = useState(autoStartPhone ?? booking.guest_phone ?? '')
  const [amountText, setAmountText] = useState(String(dueNow))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const latest: Pay | undefined = booking.payments.find((p) => p.method === 'mpesa_stk')
  const pending = latest?.status === 'pending' && Date.now() - new Date(latest.created_at).getTime() < 15 * 60_000 ? latest : undefined
  const failed = !pending && latest && (latest.status === 'failed' || latest.status === 'cancelled') && startedAt !== null ? latest : undefined

  useEffect(() => {
    if (!pending && !busy) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [pending, busy])

  const start = async (rawPhone: string, amount: number) => {
    setError('')
    const p = normalizePhone(rawPhone)
    if (!p.ok) { setError(p.error); return }
    if (!Number.isInteger(amount) || amount < 10) { setError('The smallest payment is KES 10.'); return }
    if (amount > owing) { setError(`That is more than the balance of ${formatKES(owing)}.`); return }
    setBusy(true)
    try {
      await callFunction('mpesa-stk-push', { token, phone: p.phone, amount, kind: needsDeposit ? 'deposit' : 'balance' }, { auth: false })
      setStartedAt(Date.now())
      onStarted()
    } catch (e) {
      setError(e instanceof FunctionError ? e.message : 'We could not start the payment. Please check your connection and try again.')
    } finally { setBusy(false) }
  }

  // After checkout we arrive with ?start=<phone> and send the deposit prompt straight away (once).
  const [auto, setAuto] = useState(!!autoStartPhone)
  useEffect(() => {
    if (auto && !pending && needsDeposit) { setAuto(false); void start(autoStartPhone!, dueNow) }
  })

  if (owing <= 0) return null
  if (['cancelled', 'expired', 'no_show', 'checked_out'].includes(booking.status)) return null

  if (pending) {
    const elapsed = Math.floor((now - new Date(pending.created_at).getTime()) / 1000)
    const left = Math.max(0, STK_WAIT_SECONDS - elapsed)
    return (
      <div className="rounded-xl border-2 border-brand/40 bg-brand/5 p-5 text-center" role="status" aria-live="polite">
        <Smartphone className="mx-auto h-10 w-10 text-brand" aria-hidden />
        <h3 className="mt-2 text-lg font-semibold">Check your phone</h3>
        <p className="mt-1 text-sm">Enter your M-Pesa PIN to pay <b>{formatKES(pending.amount)}</b>.</p>
        <p className="mt-3 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {left > 0 ? `Waiting for confirmation… ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Still waiting. This can take a minute. We will update this page automatically.'}
        </p>
        <details className="mt-4 text-left text-sm text-muted-foreground">
          <summary className="cursor-pointer font-medium text-foreground">No prompt on your phone?</summary>
          <ManualFallback reference={booking.reference} amount={pending.amount} />
        </details>
      </div>
    )
  }

  return (
    <div className="rounded-xl border bg-card p-5">
      {failed && (
        <div role="alert" className="mb-4 flex gap-3 rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm">
          <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden />
          <p>{mpesaFailureMessage(failed.result_code, failed.result_desc)}</p>
        </div>
      )}
      <h3 className="text-lg font-semibold">{needsDeposit ? 'Pay your deposit' : 'Pay your balance'}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{needsDeposit ? `Pay ${formatKES(dueNow)} now to confirm your stay.` : `You owe ${formatKES(owing)}. You can pay it all now or part of it.`}</p>
      {needsDeposit && booking.hold_expires_at && <p className="mt-1 text-xs text-muted-foreground">Your dates are held until {new Date(booking.hold_expires_at).toLocaleTimeString('en-GB', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit' })}.</p>}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="M-Pesa number" htmlFor="pp-phone"><Input id="pp-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0712 345 678" /></Field>
        <Field label="Amount (KES)" htmlFor="pp-amount" hint={needsDeposit ? 'Deposit amount' : `Up to ${formatKES(owing)}`}>
          <Input id="pp-amount" inputMode="numeric" value={amountText} disabled={needsDeposit} onChange={(e) => setAmountText(e.target.value)} />
        </Field>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <Button className="mt-4 w-full sm:w-auto" size="lg" loading={busy} onClick={() => start(phone, needsDeposit ? dueNow : (parseKES(amountText) ?? 0))}>
        {failed ? 'Try again' : `Pay ${formatKES(needsDeposit ? dueNow : (parseKES(amountText) ?? 0))} with M-Pesa`}
      </Button>
      <details className="mt-4 text-sm text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">Prefer to pay manually?</summary>
        <ManualFallback reference={booking.reference} amount={needsDeposit ? dueNow : owing} />
      </details>
      {phone && normalizePhone(phone).ok && <p className="mt-3 text-xs text-muted-foreground">Prompt will go to {formatPhoneLocal((normalizePhone(phone) as { phone: string }).phone)}.</p>}
    </div>
  )
}

function ManualFallback({ reference, amount }: { reference: string; amount: number }) {
  const brand = useBrand()
  return (
    <div className="mt-2 grid gap-1 rounded-md bg-muted p-3">
      <p>{brand.manualInstructions}</p>
      {brand.mpesaPaybillDisplay ? <p>Paybill / Till: <b className="text-foreground">{brand.mpesaPaybillDisplay}</b></p> : <p>Ask us on WhatsApp for the Paybill / Till number.</p>}
      <p>Account / reference: <b className="text-foreground">{reference}</b></p>
      <p>Amount: <b className="text-foreground">{formatKES(amount)}</b></p>
      <p>Then message us the M-Pesa confirmation code and we will mark your booking as paid.</p>
    </div>
  )
}

export function PaidBanner({ amount }: { amount: number }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-emerald-600/40 bg-emerald-500/10 p-4" role="status">
      <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-600" aria-hidden />
      <p className="text-sm"><b>Payment received.</b> Thank you! {formatKES(amount)} paid so far.</p>
    </div>
  )
}
