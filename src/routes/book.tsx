import { useState } from 'react'
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
import { DATES_TAKEN_MESSAGE } from '~/lib/utils'
import type { Property, Unit } from '~/lib/types'
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
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<Values>({
    resolver: zodResolver(schema), defaultValues: { guests: s.guests, consent: false },
  })

  async function onSubmit(raw: Values) {
    setFormError('')
    const v = schema.parse(raw)
    const p = normalizePhone(v.phone)
    if (!p.ok) { setError('phone', { message: p.error }); return }
    try {
      const res = await callFunction<{ booking: { public_token: string; deposit_required: number } }>('create-booking', {
        unit_id: s.unit, check_in: s.in, check_out: s.out, guests: v.guests, name: v.name, phone: p.phone, email: v.email || undefined, source: 'website', consent: true,
      }, { auth: false })
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
  const deposit = q ? calcDeposit(q.total, brand.depositPercent) : 0

  return (
    <PublicLayout>
      <div className="mx-auto grid max-w-5xl gap-6 px-4 py-8 lg:grid-cols-[1fr_22rem]">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Complete your booking</h1>
          {info.isLoading && <Skeleton className="mt-6 h-96" />}
          {info.error && <div className="mt-6"><ErrorState error={info.error} retry={() => info.refetch()} /></div>}
          {info.data === null && <div className="mt-6"><EmptyState title="That place is no longer available" action={<Button asChild><Link to="/">Find another</Link></Button>} /></div>}
          {d && q && (
            <form onSubmit={handleSubmit(onSubmit)} className="mt-6 grid gap-4" noValidate>
              <Field label="Full name" htmlFor="b-name" error={errors.name?.message}><Input id="b-name" autoComplete="name" aria-invalid={!!errors.name} {...register('name')} /></Field>
              <Field label="M-Pesa phone number" htmlFor="b-phone" error={errors.phone?.message} hint="We send the payment request to this number, and your confirmation on WhatsApp.">
                <Input id="b-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="0712 345 678" aria-invalid={!!errors.phone} {...register('phone')} />
              </Field>
              <Field label="Email (optional)" htmlFor="b-email" error={errors.email?.message}><Input id="b-email" type="email" autoComplete="email" inputMode="email" {...register('email')} /></Field>
              <Field label="Guests" htmlFor="b-guests" error={errors.guests?.message}>
                <Select id="b-guests" {...register('guests')}>{Array.from({ length: d.unit.max_guests }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}</Select>
              </Field>
              <div className="rounded-lg border bg-muted/40 p-3 text-sm">
                <label className="flex items-start gap-3"><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" {...register('consent')} />
                  <span>I agree that {brand.businessName} may use my name, phone number and email to manage this booking and send me confirmations and reminders (WhatsApp/SMS). We keep only what we need and never sell your data.</span></label>
                {errors.consent && <p role="alert" className="mt-2 text-xs text-danger">{errors.consent.message}</p>}
              </div>
              {formError && <p role="alert" className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">{formError}</p>}
              {q.nights < q.min_nights
                ? <p role="alert" className="text-sm text-danger">This place has a {q.min_nights}-night minimum. <Link to="/properties/$slug" params={{ slug: d.property.slug }} className="underline">Change dates</Link></p>
                : <Button type="submit" size="lg" loading={isSubmitting}>Pay {formatKES(deposit)} deposit with M-Pesa</Button>}
              <p className="flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="h-4 w-4" aria-hidden /> You will get an M-Pesa prompt on your phone. Enter your PIN to confirm. We never see your PIN.</p>
            </form>
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
                  {q.cleaning_fee > 0 && <p className="flex justify-between"><span>Cleaning fee</span><span>{formatKES(q.cleaning_fee)}</span></p>}
                  <p className="flex justify-between border-t pt-2 text-base font-semibold"><span>Total</span><span>{formatKES(q.total)}</span></p>
                  <p className="flex justify-between font-medium text-brand"><span>Deposit due now ({brand.depositPercent}%)</span><span>{formatKES(deposit)}</span></p>
                  <p className="flex justify-between text-muted-foreground"><span>Balance before check-in</span><span>{formatKES(q.total - deposit)}</span></p>
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
