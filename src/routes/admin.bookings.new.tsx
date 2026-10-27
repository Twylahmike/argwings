import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowLeft } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { fetchAvailability, fetchQuote } from '~/lib/public-api'
import { normalizePhone } from '~/lib/phone'
import { formatKES, parseKES } from '~/lib/money'
import { calcDeposit } from '~/lib/pricing'
import { addDays, formatDate, todayNairobi } from '~/lib/dates'
import { DATES_TAKEN_MESSAGE, errMessage, isDatesTaken } from '~/lib/utils'
import { SOURCE_LABEL, METHOD_LABEL, type BookingSource, type PaymentMethod, type Unit } from '~/lib/types'
import { useBrand } from '~/lib/brand'
import { Button } from '~/components/ui/button'
import { Field, Input, Select, Textarea } from '~/components/ui/form'
import { Card, CardContent } from '~/components/ui/card'
import { useAdmin } from '~/components/layout/AdminShell'

type Search = { unit?: string; in?: string; out?: string; property?: string }

export const Route = createFileRoute('/admin/bookings/new')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(typeof s.unit === 'string' ? { unit: s.unit } : {}),
    ...(typeof s.in === 'string' ? { in: s.in } : {}),
    ...(typeof s.out === 'string' ? { out: s.out } : {}),
    ...(typeof s.property === 'string' ? { property: s.property } : {}),
  }),
  component: NewBooking,
})

const MANUAL_METHODS: PaymentMethod[] = ['cash', 'mpesa_manual', 'bank', 'other']

function NewBooking() {
  const { me, propertyId: scopeProperty } = useAdmin()
  const search = Route.useSearch()
  const nav = useNavigate()
  const brand = useBrand()
  const today = todayNairobi()
  const manageable = me.properties.filter((p) => p.active || me.roles.includes('owner'))

  const [propertyId, setPropertyId] = useState(search.property ?? (scopeProperty !== 'all' ? scopeProperty : manageable[0]?.id ?? ''))
  const [checkIn, setCheckIn] = useState(search.in ?? today)
  const [checkOut, setCheckOut] = useState(search.out ?? addDays(today, 1))
  const [unitId, setUnitId] = useState(search.unit ?? '')
  const [guests, setGuests] = useState(2)
  const [source, setSource] = useState<BookingSource>('walk_in')
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [discount, setDiscount] = useState('0')
  const [depositText, setDepositText] = useState('')
  const [notes, setNotes] = useState('')
  const [payNow, setPayNow] = useState('')
  const [payMethod, setPayMethod] = useState<PaymentMethod>('cash')
  const [payReceipt, setPayReceipt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [returning, setReturning] = useState('')

  const validDates = checkOut > checkIn

  // Units that are free for the chosen dates (the server is the judge; the constraint still guards the insert).
  const free = useQuery({
    queryKey: ['free-units', propertyId, checkIn, checkOut, guests],
    enabled: !!propertyId && validDates,
    queryFn: async () => {
      const avail = await fetchAvailability(checkIn, checkOut, guests, propertyId)
      const { data } = await sb().from('units').select('*').in('id', avail.map((a) => a.unit_id).concat(search.unit ? [search.unit] : [])).order('sort')
      return { avail, units: (data ?? []) as Unit[] }
    },
  })
  const freeIds = new Set(free.data?.avail.map((a) => a.unit_id))
  const unitOptions = (free.data?.units ?? []).filter((u) => freeIds.has(u.id))
  useEffect(() => { if (unitId && free.data && !freeIds.has(unitId)) setUnitId('') })

  const quote = useQuery({
    queryKey: ['quote', unitId, checkIn, checkOut],
    enabled: !!unitId && validDates,
    queryFn: () => fetchQuote(unitId, checkIn, checkOut),
  })
  const disc = parseKES(discount || '0') ?? 0
  const total = Math.max(0, (quote.data?.total ?? 0) - disc)
  const defaultDeposit = calcDeposit(total, brand.depositPercent)
  const deposit = depositText === '' ? 0 : (parseKES(depositText) ?? 0)
  const pay = payNow === '' ? 0 : (parseKES(payNow) ?? 0)

  // Look up a returning guest by phone (RLS only shows guests tied to your properties).
  const normalized = useMemo(() => normalizePhone(phone), [phone])
  useEffect(() => {
    setReturning('')
    if (!normalized.ok) return
    sb().from('guests').select('full_name, email').eq('phone', normalized.phone).maybeSingle().then(({ data }) => {
      if (data) { setReturning(data.full_name); setName((n) => n || data.full_name); setEmail((e) => e || data.email || '') }
    })
  }, [normalized])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!unitId) return setError('Choose a unit that is free for these dates.')
    if (!validDates) return setError('Check-out must be after check-in.')
    if (!name.trim()) return setError('Enter the guest name.')
    if (!normalized.ok) return setError(normalized.error)
    if (parseKES(discount || '0') == null) return setError('Discount must be a whole number.')
    if (depositText !== '' && parseKES(depositText) == null) return setError('Deposit must be a whole number.')
    if (deposit > total) return setError('Deposit cannot be more than the total.')
    if (pay > 0 && payMethod !== 'cash' && payMethod !== 'other' && !payReceipt.trim()) return setError('Enter the M-Pesa or bank reference for this payment.')
    if (pay > total) return setError('The payment cannot be more than the total.')
    setBusy(true)
    try {
      const { data, error: err } = await sb().rpc('staff_create_booking', {
        p_unit: unitId, p_in: checkIn, p_out: checkOut, p_guests: guests, p_guest_name: name.trim(), p_guest_phone: normalized.phone,
        p_guest_email: email.trim() || null, p_source: source, p_discount: disc, p_deposit: deposit, p_notes: notes.trim() || null,
      })
      if (err) throw err
      const booking = data as { id: string }
      if (pay > 0) {
        const { error: pErr } = await sb().from('payments').insert({
          booking_id: booking.id, kind: pay >= total ? 'full' : deposit > 0 && pay <= deposit ? 'deposit' : 'balance', method: payMethod, status: 'succeeded', amount: pay,
          phone: normalized.phone, mpesa_receipt: payReceipt.trim() ? payReceipt.trim().toUpperCase() : null, recorded_by: me.id, confirmed_at: new Date().toISOString(),
        })
        if (pErr) toast.error(`Booking saved, but the payment was not recorded: ${errMessage(pErr)}`)
      }
      toast.success('Booking created')
      nav({ to: '/admin/bookings/$id', params: { id: booking.id } })
    } catch (err) {
      setError(isDatesTaken(err) ? DATES_TAKEN_MESSAGE : errMessage(err))
    } finally { setBusy(false) }
  }

  return (
    <div className="max-w-3xl">
      <Link to="/admin/bookings" className="mb-3 inline-flex h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Bookings</Link>
      <h1 className="mb-4 text-xl font-semibold md:text-2xl">New booking</h1>
      <form onSubmit={submit} className="grid gap-5" noValidate>
        <Card><CardContent className="grid gap-4 pt-4 sm:grid-cols-2">
          <Field label="Property" htmlFor="nb-prop"><Select id="nb-prop" value={propertyId} onChange={(e) => { setPropertyId(e.target.value); setUnitId('') }}>{manageable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <Field label="Guests" htmlFor="nb-guests"><Select id="nb-guests" value={guests} onChange={(e) => setGuests(Number(e.target.value))}>{Array.from({ length: 12 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
          <Field label="Check-in" htmlFor="nb-in"><Input id="nb-in" type="date" value={checkIn} onChange={(e) => { setCheckIn(e.target.value); if (checkOut <= e.target.value) setCheckOut(addDays(e.target.value, 1)) }} /></Field>
          <Field label="Check-out" htmlFor="nb-out"><Input id="nb-out" type="date" min={addDays(checkIn, 1)} value={checkOut} onChange={(e) => setCheckOut(e.target.value)} /></Field>
          <Field label="Unit" htmlFor="nb-unit" className="sm:col-span-2" hint={free.isLoading ? 'Checking availability…' : unitOptions.length === 0 ? 'No units are free for these dates and guest count.' : `${unitOptions.length} unit${unitOptions.length > 1 ? 's' : ''} free`}>
            <Select id="nb-unit" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">Choose a unit…</option>
              {unitOptions.map((u) => <option key={u.id} value={u.id}>{u.name} · sleeps {u.max_guests} · {formatKES(u.base_rate)}</option>)}
            </Select>
          </Field>
        </CardContent></Card>

        <Card><CardContent className="grid gap-4 pt-4 sm:grid-cols-2">
          <Field label="Guest phone" htmlFor="nb-phone" hint={returning ? `Returning guest: ${returning}` : 'Used to find or create the guest record.'}><Input id="nb-phone" inputMode="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0712 345 678" /></Field>
          <Field label="Guest name" htmlFor="nb-name"><Input id="nb-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Email (optional)" htmlFor="nb-email"><Input id="nb-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Source" htmlFor="nb-source"><Select id="nb-source" value={source} onChange={(e) => setSource(e.target.value as BookingSource)}>{(['walk_in', 'phone', 'whatsapp', 'manual'] as BookingSource[]).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</Select></Field>
        </CardContent></Card>

        <Card><CardContent className="grid gap-4 pt-4 sm:grid-cols-2">
          <div className="sm:col-span-2" aria-live="polite">
            {!unitId && <p className="text-sm text-muted-foreground">Choose a unit to see the price.</p>}
            {quote.data && (
              <div className="rounded-md bg-muted p-3 text-sm">
                <p className="flex justify-between"><span>{quote.data.nights} night{quote.data.nights > 1 ? 's' : ''} · {formatDate(checkIn)} to {formatDate(checkOut)}</span><span>{formatKES(quote.data.nightly_total)}</span></p>
                {quote.data.cleaning_fee > 0 && <p className="flex justify-between"><span>Cleaning fee</span><span>{formatKES(quote.data.cleaning_fee)}</span></p>}
                {disc > 0 && <p className="flex justify-between"><span>Discount</span><span>-{formatKES(disc)}</span></p>}
                <p className="mt-1 flex justify-between border-t pt-1 text-base font-semibold"><span>Total</span><span>{formatKES(total)}</span></p>
                {quote.data.nights < quote.data.min_nights && <p className="mt-1 text-danger">Minimum stay is {quote.data.min_nights} nights.</p>}
              </div>
            )}
          </div>
          <Field label="Discount (KES)" htmlFor="nb-disc"><Input id="nb-disc" inputMode="numeric" value={discount} onChange={(e) => setDiscount(e.target.value)} /></Field>
          <Field label="Deposit required (KES)" htmlFor="nb-dep" hint={total ? `Standard deposit ${formatKES(defaultDeposit)}. Use 0 for none.` : undefined}>
            <div className="flex gap-2"><Input id="nb-dep" inputMode="numeric" value={depositText} onChange={(e) => setDepositText(e.target.value)} placeholder="0" />
              {total > 0 && <Button type="button" variant="outline" onClick={() => setDepositText(String(defaultDeposit))}>Use {brand.depositPercent}%</Button>}</div>
          </Field>
          <Field label="Payment received now (KES, optional)" htmlFor="nb-pay"><Input id="nb-pay" inputMode="numeric" value={payNow} onChange={(e) => setPayNow(e.target.value)} placeholder="0" /></Field>
          {pay > 0 && <>
            <Field label="Paid by" htmlFor="nb-method"><Select id="nb-method" value={payMethod} onChange={(e) => setPayMethod(e.target.value as PaymentMethod)}>{MANUAL_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</Select></Field>
            {(payMethod === 'mpesa_manual' || payMethod === 'bank') && <Field label={payMethod === 'bank' ? 'Bank reference' : 'M-Pesa code'} htmlFor="nb-rcpt"><Input id="nb-rcpt" value={payReceipt} onChange={(e) => setPayReceipt(e.target.value)} className="uppercase" /></Field>}
          </>}
          <Field label="Internal notes" htmlFor="nb-notes" className="sm:col-span-2"><Textarea id="nb-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </CardContent></Card>

        {error && <p role="alert" className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">{error}</p>}
        <div><Button type="submit" size="lg" loading={busy} disabled={!unitId || !!(quote.data && quote.data.nights < quote.data.min_nights)}>Create booking</Button></div>
      </form>
    </div>
  )
}
