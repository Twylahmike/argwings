import { useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, ExternalLink, MapPin, MessageCircle, Phone, Receipt } from 'lucide-react'
import { pub } from '~/lib/public-client'
import { mapsLink } from '~/lib/public-api'
import { formatKES } from '~/lib/money'
import { formatDate, formatDateTime, formatTime } from '~/lib/dates'
import { waLink } from '~/lib/brand'
import { formatPhoneLocal } from '~/lib/phone'
import type { PublicBooking } from '~/lib/types'
import { PublicLayout } from '~/components/layout/PublicLayout'
import { PayPanel, PaidBanner } from '~/components/booking/PayPanel'
import { StatusBadge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { EmptyState, ErrorState, Skeleton } from '~/components/ui/misc'

export const Route = createFileRoute('/booking/$token')({
  ssr: false, // the page is private to the guest holding the link
  validateSearch: (s: Record<string, unknown>): { start?: string } => (typeof s.start === 'string' ? { start: s.start } : {}),
  head: () => ({ meta: [{ title: 'Your booking' }, { name: 'robots', content: 'noindex,nofollow' }] }),
  component: BookingPage,
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function BookingPage() {
  const { token } = Route.useParams()
  const { start } = Route.useSearch()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [fast, setFast] = useState(false)

  const q = useQuery({
    queryKey: ['public-booking', token],
    enabled: UUID.test(token),
    queryFn: async () => {
      const { data, error } = await pub().rpc('get_booking_by_token', { p_token: token })
      if (error) throw error
      return (data as PublicBooking | null) ?? null
    },
    // Poll quickly while an M-Pesa prompt is open or we just sent one, slowly otherwise.
    refetchInterval: (query) => {
      const b = query.state.data
      if (fast || b?.payments.some((p) => p.status === 'pending')) return 3000
      return b?.status === 'pending' ? 10_000 : false
    },
  })
  const b = q.data

  // Once the checkout hand-off has fired, drop ?start so a refresh cannot send a second prompt.
  const [handedOff, setHandedOff] = useState(false)
  useEffect(() => {
    if (start && handedOff) nav({ to: '/booking/$token', params: { token }, search: {}, replace: true })
  }, [start, handedOff, nav, token])

  if (!UUID.test(token) || (q.isSuccess && !b)) {
    return <PublicLayout><div className="mx-auto max-w-lg px-4 py-16"><EmptyState title="We could not find that booking" description="Check the link in your WhatsApp message, or contact us." action={<Button asChild><Link to="/">Back to home</Link></Button>} /></div></PublicLayout>
  }

  return (
    <PublicLayout>
      <div className="mx-auto max-w-3xl px-4 py-8">
        {q.isLoading && <Skeleton className="h-96" />}
        {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
        {b && (
          <>
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div><p className="text-sm text-muted-foreground">Booking reference</p><h1 className="text-2xl font-semibold tracking-tight">{b.reference}</h1></div>
              <StatusBadge status={b.status} />
            </div>

            {b.status === 'pending' && <HoldBanner expires={b.hold_expires_at} />}
            {b.status === 'expired' && <div className="mb-5"><EmptyState icon={CalendarClock} title="This hold has expired" description="The dates were released because the deposit was not received in time. If you already paid, message us and we will sort it out." action={<Button asChild><Link to="/properties/$slug" params={{ slug: b.property.slug }}>Book again</Link></Button>} /></div>}
            {b.status === 'cancelled' && <p className="mb-5 rounded-lg border p-4 text-sm">This booking was cancelled. Contact us if you have questions about a refund.</p>}
            {(b.status === 'confirmed' || b.status === 'checked_in') && b.amount_paid > 0 && b.balance <= 0 && <div className="mb-5"><PaidBanner amount={b.amount_paid} /></div>}

            <div className="mb-5">
              <PayPanel booking={b} token={token} autoStartPhone={start} onStarted={() => { setFast(true); setHandedOff(true); void qc.invalidateQueries({ queryKey: ['public-booking', token] }) }} />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader><CardTitle>Your stay</CardTitle></CardHeader>
                <CardContent className="grid gap-1 text-sm">
                  <p className="font-medium">{b.property.name}</p>
                  <p className="text-muted-foreground">{b.unit.name}</p>
                  <p className="mt-2">Check-in: <b>{formatDate(b.check_in)}</b> from {formatTime(b.property.check_in_time)}</p>
                  <p>Check-out: <b>{formatDate(b.check_out)}</b> by {formatTime(b.property.check_out_time)}</p>
                  <p>{b.nights} night{b.nights > 1 ? 's' : ''} · {b.num_guests} guest{b.num_guests > 1 ? 's' : ''}</p>
                  {b.guest_name && <p className="text-muted-foreground">Booked for {b.guest_name}{b.guest_phone ? ` · ${formatPhoneLocal(b.guest_phone)}` : ''}</p>}
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Payment summary</CardTitle></CardHeader>
                <CardContent className="grid gap-1 text-sm">
                  <p className="flex justify-between"><span>{b.nights} night{b.nights > 1 ? 's' : ''}</span><span>{formatKES(b.nightly_total)}</span></p>
                  {b.cleaning_fee > 0 && <p className="flex justify-between"><span>Cleaning fee</span><span>{formatKES(b.cleaning_fee)}</span></p>}
                  {b.discount > 0 && <p className="flex justify-between"><span>Discount</span><span>-{formatKES(b.discount)}</span></p>}
                  <p className="flex justify-between border-t pt-1 font-semibold"><span>Total</span><span>{formatKES(b.total_amount)}</span></p>
                  <p className="flex justify-between"><span>Paid</span><span>{formatKES(b.amount_paid)}</span></p>
                  <p className="flex justify-between font-semibold"><span>Balance</span><span className={b.balance > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}>{formatKES(b.balance)}</span></p>
                  {b.balance > 0 && b.status !== 'expired' && b.status !== 'cancelled' && <p className="mt-1 text-xs text-muted-foreground">The balance is due by check-in.</p>}
                </CardContent>
              </Card>
            </div>

            {b.payments.some((p) => p.status === 'succeeded') && (
              <Card className="mt-4">
                <CardHeader><CardTitle>Receipts</CardTitle></CardHeader>
                <CardContent><ul className="divide-y">
                  {b.payments.filter((p) => p.status === 'succeeded').map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span>{formatKES(p.amount)} · <span className="capitalize">{p.kind}</span> · {formatDateTime(p.confirmed_at ?? p.created_at)}{p.mpesa_receipt && <span className="text-muted-foreground"> · {p.mpesa_receipt}</span>}</span>
                      <Button variant="outline" size="sm" asChild><a href={`/receipt/${p.id}?token=${token}`} target="_blank" rel="noreferrer"><Receipt className="h-4 w-4" /> Receipt</a></Button>
                    </li>))}
                </ul></CardContent>
              </Card>
            )}

            <Card className="mt-4">
              <CardHeader><CardTitle>Getting there & contact</CardTitle></CardHeader>
              <CardContent className="grid gap-3 text-sm">
                <p className="flex items-start gap-2"><MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {[b.property.address, b.property.area, b.property.city].filter(Boolean).join(', ')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" asChild><a href={mapsLink({ ...b.property, lat: b.property.lat, lng: b.property.lng })} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4" /> Open map</a></Button>
                  {b.property.contact_phone && <Button variant="outline" size="sm" asChild><a href={`tel:+${b.property.contact_phone}`}><Phone className="h-4 w-4" /> Call {formatPhoneLocal(b.property.contact_phone)}</a></Button>}
                  {b.property.whatsapp_number && <Button variant="outline" size="sm" asChild><a href={waLink(b.property.whatsapp_number, `Hi, about booking ${b.reference}`)} target="_blank" rel="noopener noreferrer"><MessageCircle className="h-4 w-4" /> WhatsApp</a></Button>}
                </div>
                {b.property.house_rules && <div><p className="font-medium">House rules</p><ul className="mt-1 list-disc space-y-0.5 pl-5">{b.property.house_rules.split('\n').filter(Boolean).map((r) => <li key={r}>{r}</li>)}</ul></div>}
                {b.cancellation_policy && <div><p className="font-medium">Cancellation policy</p><p className="text-muted-foreground">{b.cancellation_policy}</p></div>}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </PublicLayout>
  )
}

function HoldBanner({ expires }: { expires: string | null }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  if (!expires) return null
  const left = Math.max(0, Math.floor((new Date(expires).getTime() - now) / 1000))
  return (
    <p className="mb-5 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="status">
      <CalendarClock className="h-4 w-4 shrink-0" aria-hidden />
      {left > 0 ? <>Your dates are held for <b className="tabular-nums">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</b>. Pay your deposit to confirm.</> : 'The hold is about to be released. If you are paying right now, keep this page open.'}
    </p>
  )
}
