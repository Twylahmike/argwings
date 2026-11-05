import { useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ShieldCheck } from 'lucide-react'
import { callFunction, FunctionError } from '~/lib/functions'
import { pub } from '~/lib/public-client'
import { fetchQuote } from '~/lib/public-api'
import { normalizePhone } from '~/lib/phone'
import { formatKES } from '~/lib/money'
import { calcDeposit } from '~/lib/pricing'
import { formatDate, formatTime } from '~/lib/dates'
import { useBrand } from '~/lib/brand'
import { DATES_TAKEN_MESSAGE, isDatesTaken } from '~/lib/utils'
import type { Property, Unit } from '~/lib/types'
import { fetchCustomer, hasStoredSession, rpc, type StayOffer, type StayPoints } from '~/lib/customer'
import { PublicLayout } from '~/components/layout/PublicLayout'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Field, Input, Select } from '~/components/ui/form'
import { EmptyState, ErrorState, Skeleton } from '~/components/ui/misc'

type Search = { unit: string; in: string; out: string; guests: number }

export const Route = createFileRoute('/book')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    unit: String(s.unit ?? ''), in: String(s.in ?? ''), out: String(s.out ?? ''), guests: Math.max(1, Number(s.guests) || 1),
  }),
  head: () => ({ meta: [{ title: 'Complete your booking' }, { name: 'robots', content: 'noindex' }] }),
  component: BookPage,
})

const schema = z.object({
  name: z.string().trim().min(2, 'Please enter your full name'),
  phone: z.string().trim().min(1, 'Enter your M-Pesa phone number'),
  email: z.string().trim().email('Enter a valid email').optional().or(z.literal('')),
  guests: z.coerce.number().int().min(1),
  consent: z.boolean().refine((v) => v, 'Please tick the box to continue'),
})
type Values = z.input<typeof schema>

function BookPage() {
  const s = Route.useSearch()
  const brand = useBrand()
  const nav = useNavigate()
  const [formError, setFormError] = useState('')
  const [codeInput, setCodeInput] = useState('')
  const [applied, setApplied] = useState<{ code: string; amount: number } | null>(null)
  const [codeMsg, setCodeMsg] = useState('')
  const valid = !!s.unit && /^\d{4}-\d{2}-\d{2}$/.test(s.in) && /^\d{4}-\d{2}-\d{2}$/.test(s.out) && s.out > s.in

  const info = useQuery({
    queryKey: ['book-info', s.unit, s.in, s.out],
    enabled: valid,
    queryFn: async () => {
      const { data: unit, error } = await pub().from('units').select('*').eq('id', s.unit).eq('active', true).maybeSingle()
      if (error) throw error
      if (!unit) return null
      const [prop, quote] = await Promise.all([
        pub().from('properties').select('*').eq('id', (unit as Unit).property_id).maybeSingle(),
        fetchQuote(s.unit, s.in, s.out),
      ])
      return { unit: unit as Unit, property: prop.data as Property, quote }
    },
  })
  const longStay = useQuery({ queryKey: ['long-stay', s.unit, s.in, s.out], enabled: valid, queryFn: async () => {
    const n = Math.round((Date.parse(s.out) - Date.parse(s.in)) / 86_400_000)
    const { data } = await pub().rpc('long_stay_percent', { p_unit: s.unit, p_nights: n })
    return Number(data ?? 0)
  } })
  const { register, handleSubmit, setError, reset, formState: { errors, isSubmitting } } = useForm<Values>({
    resolver: zodResolver(schema), defaultValues: { guests: s.guests, consent: false },
  })

  // Signed-in members: prefill their details and offer their offers. Visitors without a stored session never load the auth client.
  const stored = hasStoredSession()
  const me = useQuery({ queryKey: ['customer'], queryFn: fetchCustomer, enabled: stored, staleTime: 30_000 })
  const member = me.data?.state === 'ready' && me.data.customer!.status === 'active' ? me.data.customer! : null
  const [offerId, setOfferId] = useState<string | null>(null)   // reward id, or offer id for open member offers
  useEffect(() => {
    if (member) reset((v) => ({ ...v, name: member.full_name, email: member.email, phone: member.phone ? `0${member.phone.slice(3)}` : v.phone }))
  }, [member?.user_id])
  const offers = useQuery({
    queryKey: ['stay-offers', s.unit, s.in, s.out, member?.user_id],
    enabled: valid && !!member && brand.bookingMode !== 'request',
    queryFn: () => rpc<StayOffer[]>('my_offers_for_stay', { p_unit: s.unit, p_in: s.in, p_out: s.out }),
  })
  const [usePoints, setUsePoints] = useState(false)
  const [pointsInput, setPointsInput] = useState('')
  const pts = useQuery({
    queryKey: ['stay-points', s.unit, s.in, s.out, member?.user_id],
    enabled: valid && !!member && brand.bookingMode !== 'request',
    queryFn: () => rpc<StayPoints>('points_for_stay', { p_unit: s.unit, p_in: s.in, p_out: s.out, p_other_discount: 0 }),
  })
  const usable = (offers.data ?? []).filter((o) => o.ok)
  const key = (o: StayOffer) => o.reward_id ?? o.offer_id
  // Default to the best usable offer unless the member picked another (or picked none: offerId === '').
  const best = usable.slice().sort((x, y) => y.amount - x.amount)[0]
  const chosen = applied || offerId === '' ? undefined : usable.find((o) => key(o) === offerId) ?? best
  const gated = !brand.guestCheckout && !member && !me.isLoading

  async function applyCode() {
    setCodeMsg('')
    const code = codeInput.trim().toUpperCase()
    if (!code) return
    const { data, error } = await pub().rpc('quote_discount_code', { p_code: code, p_unit: s.unit, p_in: s.in, p_out: s.out })
    if (error) { setCodeMsg(error.message); return }
    const r = data as { ok: boolean; message: string; amount: number }
    if (r.ok) { setApplied({ code, amount: r.amount }); setOfferId('') } else setApplied(null)   // a code and a member offer are not combined
    setCodeMsg(r.message)
  }

  async function onSubmit(raw: Values) {
    setFormError('')
    const v = schema.parse(raw)
    const p = normalizePhone(v.phone)
    if (!p.ok) { setError('phone', { message: p.error }); return }
    if (brand.bookingMode === 'request') {
      const { data, error } = await pub().rpc('submit_booking_request', {
        p_unit: s.unit, p_in: s.in, p_out: s.out, p_guests: v.guests, p_name: v.name, p_phone: p.phone,
        p_email: v.email || null, p_message: null, p_website: '',
      })
      if (error) { setFormError(isDatesTaken(error) ? DATES_TAKEN_MESSAGE : error.message); return }
      if (!data) { setFormError('Something went wrong. Please try again.'); return }
      nav({ to: '/request/$token', params: { token: String(data) } })
      return
    }
    try {
      const res = await callFunction<{ booking: { public_token: string; deposit_required: number } }>('create-booking', {
        unit_id: s.unit, check_in: s.in, check_out: s.out, guests: v.guests, name: v.name, phone: p.phone, email: v.email || undefined, source: 'website', consent: true, discount_code: applied?.code,
        reward_id: chosen?.reward_id ?? undefined, offer_id: chosen && !chosen.reward_id ? chosen.offer_id : undefined, points: spend > 0 ? spend : undefined,
      }, { auth: !!member })
      // The payment itself is started (and followed live) on the booking page, so a refresh never loses it.
      nav({ to: '/booking/$token', params: { token: res.booking.public_token }, search: { start: p.phone } })
    } catch (e) {
      if (e instanceof FunctionError) setFormError(e.code === 'dates_taken' ? DATES_TAKEN_MESSAGE : e.message)
      else setFormError('We could not reach the server. Please check your connection and try again.')
    }
  }

  if (!valid) return <PublicLayout><div className="mx-auto max-w-lg px-4 py-16"><EmptyState title="Choose your dates first" description="Pick a place and dates to start your booking." action={<Button asChild><Link to="/">Find a place</Link></Button>} /></div></PublicLayout>
  const d = info.data
  const q = d?.quote
  const offerAmount = chosen ? chosen.amount : 0
  const ptsInfo = pts.data?.enabled && (pts.data.balance ?? 0) > 0 ? pts.data : null
  // The most points the member may spend on this stay once the other discounts are counted (the server checks again).
  const otherDiscount = (applied?.amount ?? 0) + offerAmount
  const maxPoints = ptsInfo && q ? Math.max(0, Math.min(ptsInfo.balance!, Math.floor(Math.max(0, q.nightly_total - otherDiscount) * (ptsInfo.max_percent! / 100) / ptsInfo.kes_per_point!))) : 0
  const spend = usePoints ? Math.min(maxPoints, Math.max(0, Math.floor(Number(pointsInput) || 0))) : 0
  const pointsAmount = ptsInfo ? spend * ptsInfo.kes_per_point! : 0
  const discount = otherDiscount + pointsAmount
  const total = q ? Math.max(0, q.total - discount) : 0
  const deposit = q ? calcDeposit(total, brand.depositPercent) : 0

  return (
    <PublicLayout>
      <div className="mx-auto grid max-w-5xl gap-6 px-4 py-8 lg:grid-cols-[1fr_22rem]">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Complete your booking</h1>
          {info.isLoading && <Skeleton className="mt-6 h-96" />}
          {info.error && <div className="mt-6"><ErrorState error={info.error} retry={() => info.refetch()} /></div>}
          {info.data === null && <div className="mt-6"><EmptyState title="That place is no longer available" action={<Button asChild><Link to="/">Find another</Link></Button>} /></div>}
          {d && q && (
            gated ? (
            <div className="mt-6 rounded-xl border bg-card p-6 text-sm" role="status">
              <h2 className="font-display text-2xl">Sign in to book</h2>
              <p className="mt-2 text-muted-foreground">Bookings on this site are for members. Joining is free and takes a minute, and your welcome offer is waiting.</p>
              <div className="mt-4 flex flex-wrap gap-3"><Button asChild><Link to="/join">Join for free</Link></Button><Button asChild variant="outline"><Link to="/login" search={{ redirect: `/book?unit=${s.unit}&in=${s.in}&out=${s.out}&guests=${s.guests}` }}>Sign in</Link></Button></div>
            </div>
            ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="mt-6 grid gap-4" noValidate>
              {member && <p className="rounded-md bg-muted/50 p-3 text-sm">Booking as <b>{member.full_name}</b> ({member.tier.name}). Your details are filled in.</p>}
              <Field label="Full name" htmlFor="b-name" error={errors.name?.message}><Input id="b-name" autoComplete="name" aria-invalid={!!errors.name} {...register('name')} /></Field>
              <Field label="M-Pesa phone number" htmlFor="b-phone" error={errors.phone?.message} hint="We send the payment request to this number, and your confirmation on WhatsApp.">
                <Input id="b-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="0712 345 678" aria-invalid={!!errors.phone} {...register('phone')} />
              </Field>
              <Field label="Email (optional)" htmlFor="b-email" error={errors.email?.message}><Input id="b-email" type="email" autoComplete="email" inputMode="email" {...register('email')} /></Field>
              <Field label="Guests" htmlFor="b-guests" error={errors.guests?.message}>
                <Select id="b-guests" {...register('guests')}>{Array.from({ length: d.unit.max_guests }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}</Select>
              </Field>
              {brand.bookingMode !== 'request' && <Field label="Discount code (optional)" htmlFor="b-code" hint={codeMsg || undefined}>
                <div className="flex gap-2">
                  <Input id="b-code" autoComplete="off" className="uppercase" value={codeInput} onChange={(e) => { setCodeInput(e.target.value); setApplied(null); setCodeMsg('') }} />
                  <Button type="button" variant="outline" onClick={applyCode} disabled={!codeInput.trim()}>Apply</Button>
                </div>
              </Field>}
              {member && brand.bookingMode !== 'request' && (offers.data?.length ?? 0) > 0 && (
                <fieldset className="grid gap-2 rounded-lg border-2 border-brand/40 p-3 text-sm">
                  <legend className="px-1 font-medium text-brand">Your member offers</legend>
                  {(offers.data ?? []).map((o) => (
                    <label key={key(o)} className={`flex items-start gap-3 rounded-md p-2 ${o.ok ? 'cursor-pointer hover:bg-muted/50' : 'opacity-60'}`}>
                      <input type="radio" name="offer" className="mt-0.5 h-5 w-5 shrink-0" disabled={!o.ok} checked={chosen ? key(chosen) === key(o) : false}
                        onChange={() => { setOfferId(key(o)); setApplied(null); setCodeMsg('') }} />
                      <span><b>{o.name}</b>{o.ok ? <> <span className="text-emerald-700 dark:text-emerald-400">saves {formatKES(o.amount)}</span></> : <span className="block text-xs text-muted-foreground">{o.message}</span>}{o.ok && o.terms ? <span className="block text-xs text-muted-foreground">{o.terms}</span> : null}</span>
                    </label>
                  ))}
                  <label className="flex items-center gap-3 p-2"><input type="radio" name="offer" className="h-5 w-5" checked={!chosen} onChange={() => setOfferId('')} /> No offer</label>
                  <p className="text-xs text-muted-foreground">A member offer and a discount code are not combined. The discount is checked again when you book.</p>
                </fieldset>
              )}
              {member && ptsInfo && maxPoints > 0 && (
                <fieldset className="grid gap-2 rounded-lg border p-3 text-sm">
                  <legend className="px-1 font-medium">Use my points</legend>
                  <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={usePoints} onChange={(e) => { setUsePoints(e.target.checked); if (e.target.checked && !pointsInput) setPointsInput(String(maxPoints)) }} /> Take money off with my points (you have {ptsInfo.balance!.toLocaleString('en-KE')}, each worth {formatKES(ptsInfo.kes_per_point)})</label>
                  {usePoints && <div className="flex items-center gap-3 pl-8"><Input aria-label="Points to use" className="w-32" inputMode="numeric" value={pointsInput} onChange={(e) => setPointsInput(e.target.value)} /><span className="text-muted-foreground">up to {maxPoints.toLocaleString('en-KE')} points ({formatKES(maxPoints * ptsInfo.kes_per_point!)}) on this stay · saves {formatKES(pointsAmount)}</span></div>}
                </fieldset>
              )}
              <div className="rounded-lg border bg-muted/40 p-3 text-sm">
                <label className="flex items-start gap-3"><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" {...register('consent')} />
                  <span>I agree that {brand.businessName} may use my name, phone number and email to manage this booking and send me confirmations and reminders (WhatsApp/SMS). We keep only what we need and never sell your data.{brand.pages.some((x) => x.slug === 'privacy') && <> <Link to="/p/$slug" params={{ slug: 'privacy' }} target="_blank" className="underline">Read our privacy notice</Link>.</>}</span></label>
                {errors.consent && <p role="alert" className="mt-2 text-xs text-danger">{errors.consent.message}</p>}
              </div>
              {formError && <p role="alert" className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">{formError}</p>}
              {q.nights < q.min_nights
                ? <p role="alert" className="text-sm text-danger">This place has a {q.min_nights}-night minimum. <Link to="/properties/$slug" params={{ slug: d.property.slug }} className="underline">Change dates</Link></p>
                : <Button type="submit" size="lg" loading={isSubmitting}>{brand.bookingMode === 'request' ? 'Send booking request' : `Pay ${formatKES(deposit)} deposit with M-Pesa`}</Button>}
              {!member && !gated && brand.registrationEnabled && <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">Booking as a guest is quick and needs no account. Prefer member offers? <Link to="/join" className="font-medium text-foreground underline">Join for free</Link> or <Link to="/login" search={{ redirect: `/book?unit=${s.unit}&in=${s.in}&out=${s.out}&guests=${s.guests}` }} className="font-medium text-foreground underline">sign in</Link> first, then come back here.</p>}
              {brand.bookingMode === 'request'
                ? <p className="text-xs text-muted-foreground">No payment now. We will confirm availability and send you a link to pay the deposit once approved.</p>
                : <p className="flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="h-4 w-4" aria-hidden /> You will get an M-Pesa prompt on your phone. Enter your PIN to confirm. We never see your PIN.</p>}
            </form>
            )
          )}
        </div>
        {d && q && (
          <aside>
            <Card className="sticky top-24 overflow-hidden">
              {(d.unit.images[0] ?? d.property.cover_image) && <img src={d.unit.images[0] ?? d.property.cover_image ?? ''} alt="" className="aspect-[16/9] w-full object-cover" />}
              <CardHeader><CardTitle>{d.property.name}</CardTitle><p className="text-sm text-muted-foreground">{d.unit.name}</p></CardHeader>
              <CardContent className="grid gap-1 text-sm">
                <p>{formatDate(s.in)} <span className="text-muted-foreground">from {formatTime(d.property.check_in_time)}</span></p>
                <p>{formatDate(s.out)} <span className="text-muted-foreground">until {formatTime(d.property.check_out_time)}</span></p>
                <div className="mt-3 grid gap-1 border-t pt-3">
                  <p className="flex justify-between"><span>{q.nights} night{q.nights > 1 ? 's' : ''}</span><span>{formatKES(q.nightly_total)}</span></p>
                  {(longStay.data ?? 0) > 0 && <p className="flex justify-between text-emerald-700 dark:text-emerald-400"><span>Long-stay discount included</span><span>{longStay.data}% off</span></p>}
                  {q.cleaning_fee > 0 && <p className="flex justify-between"><span>Cleaning fee</span><span>{formatKES(q.cleaning_fee)}</span></p>}
                  {discount > 0 && <p className="flex justify-between text-emerald-700 dark:text-emerald-400"><span>Discount ({[applied?.code ?? chosen?.name, spend > 0 ? `${spend} points` : null].filter(Boolean).join(' + ')})</span><span>-{formatKES(discount)}</span></p>}
                  <p className="flex justify-between border-t pt-2 text-base font-semibold"><span>Total</span><span>{formatKES(total)}</span></p>
                  {brand.bookingMode !== 'request' && <p className="flex justify-between font-medium text-brand"><span>Deposit due now ({brand.depositPercent}%)</span><span>{formatKES(deposit)}</span></p>}
                  {brand.bookingMode !== 'request' && <p className="flex justify-between text-muted-foreground"><span>Balance before check-in</span><span>{formatKES(total - deposit)}</span></p>}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">{brand.cancellationPolicy}</p>
              </CardContent>
            </Card>
          </aside>
        )}
      </div>
    </PublicLayout>
  )
}
