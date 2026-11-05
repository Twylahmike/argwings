import { useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { rpc, type MyBooking } from '~/lib/customer'
import { todayNairobi, formatDate } from '~/lib/dates'
import { formatKES } from '~/lib/money'
import { errMessage } from '~/lib/utils'
import { StatusBadge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Dialog, DialogContent } from '~/components/ui/dialog'
import { Field, Input, Textarea } from '~/components/ui/form'
import { EmptyState, ErrorState, Skeleton, Tabs } from '~/components/ui/misc'
import { isLive, paymentLabel } from './account.index'
import type { BookingStatus } from '~/lib/types'

type Tab = 'all' | 'upcoming' | 'history' | 'cancelled'
export const Route = createFileRoute('/account/bookings')({
  validateSearch: (s: Record<string, unknown>): { tab: Tab } => ({ tab: (['all', 'upcoming', 'history', 'cancelled'] as const).find((t) => t === s.tab) ?? 'all' }),
  component: Bookings,
})

function Bookings() {
  const { tab } = Route.useSearch()
  const nav = useNavigate()
  const q = useQuery({ queryKey: ['my-bookings'], queryFn: () => rpc<MyBooking[]>('my_bookings') })
  const [ask, setAsk] = useState<{ b: MyBooking; kind: 'cancellation' | 'modification' } | null>(null)
  const today = todayNairobi()
  const rows = (q.data ?? []).filter((b) => {
    if (tab === 'upcoming') return isLive(b) && b.check_out >= today
    if (tab === 'history') return b.status === 'checked_out' || (isLive(b) && b.check_out < today)
    if (tab === 'cancelled') return ['cancelled', 'expired', 'no_show'].includes(b.status)
    return true
  })
  return (
    <div className="grid gap-5">
      <h1 className="font-display text-4xl">{tab === 'upcoming' ? 'Upcoming stays' : tab === 'history' ? 'Booking history' : 'My bookings'}</h1>
      <Tabs<Tab> label="Filter bookings" value={tab} onChange={(t) => nav({ to: '/account/bookings', search: { tab: t } })}
        tabs={[{ value: 'all', label: 'All' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'history', label: 'Completed' }, { value: 'cancelled', label: 'Cancelled' }]} />
      {q.isLoading && <Skeleton className="h-32" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && !rows.length && <EmptyState title="Nothing here yet" description="Bookings you make while signed in appear here automatically." action={<Button asChild><Link to="/search">Find a place</Link></Button>} />}
      <div className="grid gap-3">
        {rows.map((b) => {
          const canAsk = ['pending', 'confirmed'].includes(b.status) && b.check_in >= today
          return (
            <article key={b.id} className="rounded-xl border bg-card p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{b.property} · {b.unit}</p>
                  <p className="text-sm text-muted-foreground">Ref {b.reference} · {b.nights} night{b.nights === 1 ? '' : 's'} · {b.guests} guest{b.guests === 1 ? '' : 's'}</p>
                </div>
                <StatusBadge status={b.status as BookingStatus} />
              </div>
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-4">
                <div><dt className="text-muted-foreground">Check-in</dt><dd>{formatDate(b.check_in)}</dd></div>
                <div><dt className="text-muted-foreground">Check-out</dt><dd>{formatDate(b.check_out)}</dd></div>
                <div><dt className="text-muted-foreground">Total</dt><dd>{formatKES(b.total)}{b.discount > 0 && <span className="text-muted-foreground"> (saved {formatKES(b.discount)}{b.offer ? `: ${b.offer}` : ''})</span>}</dd></div>
                <div><dt className="text-muted-foreground">Payment</dt><dd>{paymentLabel(b)}</dd></div>
              </dl>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button asChild size="sm"><Link to="/booking/$token" params={{ token: b.public_token }}>Details, payment and receipts</Link></Button>
                {canAsk && !b.open_request && <>
                  <Button size="sm" variant="outline" onClick={() => setAsk({ b, kind: 'modification' })}>Request change</Button>
                  <Button size="sm" variant="outline" onClick={() => setAsk({ b, kind: 'cancellation' })}>Request cancellation</Button>
                </>}
                {b.open_request && <span className="inline-flex h-10 items-center text-sm text-muted-foreground">Your {b.open_request} request is with our team.</span>}
              </div>
            </article>
          )
        })}
      </div>
      <Claim />
      {ask && <RequestDialog b={ask.b} kind={ask.kind} onClose={() => setAsk(null)} />}
    </div>
  )
}

function RequestDialog({ b, kind, onClose }: { b: MyBooking; kind: 'cancellation' | 'modification'; onClose: () => void }) {
  const qc = useQueryClient()
  const [message, setMessage] = useState('')
  const [from, setFrom] = useState(b.check_in)
  const [to, setTo] = useState(b.check_out)
  const send = useMutation({
    mutationFn: () => rpc('request_booking_change', { p_booking: b.id, p_kind: kind, p_message: message, p_new_in: kind === 'modification' ? from : null, p_new_out: kind === 'modification' ? to : null }),
    onSuccess: () => { toast.success('Request sent. We will get back to you soon.'); qc.invalidateQueries({ queryKey: ['my-bookings'] }); onClose() },
    onError: (e) => toast.error(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={kind === 'cancellation' ? 'Request a cancellation' : 'Request a change'} description={`Booking ${b.reference}. Our team reviews every request; nothing changes until we confirm.`}>
        <div className="grid gap-3">
          {kind === 'modification' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="New check-in" htmlFor="rq-in"><Input id="rq-in" type="date" value={from} min={todayNairobi()} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label="New check-out" htmlFor="rq-out"><Input id="rq-out" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
            </div>
          )}
          <Field label={kind === 'cancellation' ? 'Reason (optional details)' : 'Anything we should know?'} htmlFor="rq-msg"><Textarea id="rq-msg" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} /></Field>
          <p className="text-xs text-muted-foreground">Cancellations follow the cancellation policy shown when you booked.</p>
          <Button loading={send.isPending} disabled={message.trim().length < 3} onClick={() => send.mutate()}>Send request</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Link an earlier guest booking: needs the booking reference AND the phone number it was made with. */
function Claim() {
  const qc = useQueryClient()
  const found = useQuery({ queryKey: ['unclaimed-count'], queryFn: () => rpc<number>('unclaimed_bookings_count') })
  const [ref, setRef] = useState('')
  const [phone, setPhone] = useState('')
  const claim = useMutation({
    mutationFn: async () => {
      const { normalizePhone } = await import('~/lib/phone')
      const p = normalizePhone(phone)
      if (!p.ok) throw new Error(p.error)
      return rpc<{ reference: string }>('claim_booking', { p_reference: ref, p_phone: p.phone })
    },
    onSuccess: (r) => { toast.success(`Booking ${r.reference} added to your account`); setRef(''); setPhone(''); qc.invalidateQueries({ queryKey: ['my-bookings'] }); qc.invalidateQueries({ queryKey: ['customer'] }); qc.invalidateQueries({ queryKey: ['unclaimed-count'] }) },
    onError: (e) => toast.error(errMessage(e)),
  })
  return (
    <section className="rounded-xl border bg-card p-5" aria-labelledby="claim">
      <h2 id="claim" className="font-display text-2xl">Booked before without an account?</h2>
      <p className="mt-1 text-sm text-muted-foreground">Add that booking to your account. For your protection we need the booking reference and the phone number you booked with. Or open the booking link from your confirmation message while signed in and tap <b>Add to my account</b>.</p>
      {(found.data ?? 0) > 0 && <p className="mt-2 rounded-md bg-brand/10 p-2 text-sm text-brand" role="status">We found {found.data} earlier booking{found.data === 1 ? '' : 's'} made with your email address. Add {found.data === 1 ? 'it' : 'them'} below using the reference and phone number.</p>}
      <form className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); claim.mutate() }}>
        <Field label="Booking reference" htmlFor="cl-ref"><Input id="cl-ref" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="BNB-2611-0001" autoCapitalize="characters" /></Field>
        <Field label="Phone used" htmlFor="cl-phone"><Input id="cl-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0712 345 678" /></Field>
        <Button type="submit" variant="outline" loading={claim.isPending} disabled={!ref.trim() || !phone.trim()}>Add booking</Button>
      </form>
    </section>
  )
}
