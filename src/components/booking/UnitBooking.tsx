import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { BedDouble, CalendarDays, MessageCircle, Users } from 'lucide-react'
import { toast } from 'sonner'
import { callFunction } from '~/lib/functions'
import { fetchQuote, fetchUnavailableDates } from '~/lib/public-api'
import { useBrand, waLink } from '~/lib/brand'
import { calcDeposit } from '~/lib/pricing'
import { formatKES } from '~/lib/money'
import { formatDate } from '~/lib/dates'
import { normalizePhone } from '~/lib/phone'
import { buildWhatsAppBookingMessage } from '~/lib/whatsapp'
import { DATES_TAKEN_MESSAGE, errMessage, isDatesTaken } from '~/lib/utils'
import type { Property, Unit } from '~/lib/types'
import { Button } from '~/components/ui/button'
import { Card } from '~/components/ui/card'
import { Field, Input } from '~/components/ui/form'
import { Dialog, DialogContent } from '~/components/ui/dialog'
import { DateRangePicker } from './DateRangePicker'

type Prefill = { in?: string; out?: string; guests?: number }

export function UnitBooking({ unit, property, prefill, defaultOpen }: { unit: Unit; property: Property; prefill: Prefill; defaultOpen?: boolean }) {
  const brand = useBrand()
  const [open, setOpen] = useState(!!defaultOpen)
  const [dates, setDates] = useState<{ checkIn?: string; checkOut?: string }>({ checkIn: prefill.in, checkOut: prefill.out })
  const [waOpen, setWaOpen] = useState(false)
  const guests = Math.min(prefill.guests ?? 2, unit.max_guests)
  const ready = !!dates.checkIn && !!dates.checkOut

  const blocked = useQuery({ queryKey: ['unavailable', unit.id], queryFn: () => fetchUnavailableDates(unit.id), enabled: open, staleTime: 30_000 })
  const quote = useQuery({
    queryKey: ['quote', unit.id, dates.checkIn, dates.checkOut],
    queryFn: () => fetchQuote(unit.id, dates.checkIn!, dates.checkOut!),
    enabled: ready,
  })
  const q = quote.data
  const belowMin = q && q.nights < q.min_nights

  return (
    <Card className="overflow-hidden">
      <div className="grid gap-0 sm:grid-cols-[14rem_1fr]">
        {(unit.images[0] ?? property.cover_image)
          ? <img src={unit.images[0] ?? property.cover_image ?? ''} alt={unit.name} className="h-44 w-full object-cover sm:h-full" loading="lazy" />
          : <div className="h-44 bg-muted sm:h-full" />}
        <div className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-lg font-semibold">{unit.name}</h3>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1"><Users className="h-4 w-4" aria-hidden /> Sleeps {unit.max_guests}</span>
                <span className="inline-flex items-center gap-1"><BedDouble className="h-4 w-4" aria-hidden /> {unit.bedrooms} bedroom{unit.bedrooms === 1 ? '' : 's'}, {unit.beds} bed{unit.beds === 1 ? '' : 's'}</span>
              </p>
            </div>
            <p className="text-right"><span className="text-lg font-semibold">{formatKES(unit.base_rate)}</span><span className="text-sm text-muted-foreground"> / night</span>
              {unit.weekend_rate != null && unit.weekend_rate !== unit.base_rate && <span className="block text-xs text-muted-foreground">{formatKES(unit.weekend_rate)} Fri & Sat</span>}</p>
          </div>
          {unit.description && <p className="mt-2 text-sm">{unit.description}</p>}
          {unit.amenities.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{unit.amenities.join(' · ')}</p>}
          {unit.min_nights > 1 && <p className="mt-2 text-xs text-muted-foreground">Minimum stay: {unit.min_nights} nights</p>}

          {!open
            ? <Button className="mt-4" onClick={() => setOpen(true)}><CalendarDays className="h-4 w-4" /> Check dates & price</Button>
            : (
              <div className="mt-4 grid gap-4 border-t pt-4 md:grid-cols-[auto_1fr]">
                <DateRangePicker checkIn={dates.checkIn} checkOut={dates.checkOut} onChange={setDates} blocked={blocked.data ?? []} minNights={unit.min_nights} />
                <div>
                  {!ready && <p className="text-sm text-muted-foreground">Choose your dates to see the total price.</p>}
                  {ready && quote.isLoading && <p className="text-sm text-muted-foreground">Calculating price…</p>}
                  {ready && q && (
                    <div className="grid gap-1 text-sm" aria-live="polite">
                      <p className="font-medium">{formatDate(dates.checkIn)} to {formatDate(dates.checkOut)}</p>
                      <p className="flex justify-between"><span>{q.nights} night{q.nights > 1 ? 's' : ''}</span><span>{formatKES(q.nightly_total)}</span></p>
                      {q.cleaning_fee > 0 && <p className="flex justify-between"><span>Cleaning fee</span><span>{formatKES(q.cleaning_fee)}</span></p>}
                      <p className="flex justify-between border-t pt-1 text-base font-semibold"><span>Total</span><span>{formatKES(q.total)}</span></p>
                      <p className="text-xs text-muted-foreground">Pay {formatKES(calcDeposit(q.total, brand.depositPercent))} now to confirm, the rest before check-in.</p>
                      {belowMin && <p role="alert" className="text-danger">Minimum stay is {q.min_nights} nights.</p>}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button asChild disabled={!!belowMin}>
                          <Link to="/book" search={{ unit: unit.id, in: dates.checkIn!, out: dates.checkOut!, guests }} aria-disabled={!!belowMin}>Book now</Link>
                        </Button>
                        <Button variant="outline" disabled={!!belowMin} onClick={() => setWaOpen(true)}><MessageCircle className="h-4 w-4" /> Book on WhatsApp</Button>
                      </div>
                    </div>
                  )}
                  {ready && quote.isError && <p role="alert" className="text-sm text-danger">Could not get a price. Please try again.</p>}
                </div>
              </div>
            )}
        </div>
      </div>
      {waOpen && ready && q && (
        <WhatsAppDialog unit={unit} property={property} checkIn={dates.checkIn!} checkOut={dates.checkOut!} guests={guests} nights={q.nights} total={q.total} onClose={() => setWaOpen(false)} />
      )}
    </Card>
  )
}

function WhatsAppDialog({ unit, property, checkIn, checkOut, guests, nights, total, onClose }: {
  unit: Unit; property: Property; checkIn: string; checkOut: string; guests: number; nights: number; total: number; onClose: () => void
}) {
  const brand = useBrand()
  const number = property.whatsapp_number || brand.supportWhatsapp
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [link, setLink] = useState('')

  const message = (extra?: { reference?: string; name?: string }) =>
    buildWhatsAppBookingMessage({ property: property.name, unit: unit.name, checkIn, checkOut, nights, guests, total, ...extra })

  async function go() {
    setError('')
    if (!number) { setError('This property has no WhatsApp number yet. Please use the Book now button.'); return }
    const wantsHold = name.trim() !== '' || phone.trim() !== ''
    if (!wantsHold) {
      window.open(waLink(number, message()), '_blank', 'noopener')
      onClose()
      return
    }
    const p = normalizePhone(phone)
    if (!name.trim() || !p.ok) { setError(!name.trim() ? 'Enter your name, or clear both fields to skip the hold.' : p.ok ? '' : p.error); return }
    setBusy(true)
    try {
      // Optional short hold so nobody else can take the dates while the guest chats with us.
      const res = await callFunction<{ booking: { reference: string } }>('create-booking', {
        unit_id: unit.id, check_in: checkIn, check_out: checkOut, guests, name: name.trim(), phone: p.phone, source: 'whatsapp',
      }, { auth: false })
      setLink(waLink(number, message({ reference: res.booking.reference, name: name.trim() })))
      toast.success(`Dates held for ${brand.holdMinutes} minutes`)
    } catch (e) {
      setError(isDatesTaken(e) ? DATES_TAKEN_MESSAGE : errMessage(e))
    } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Book on WhatsApp" description="We will open WhatsApp with your booking details already typed in.">
        <pre className="mb-4 whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{message()}</pre>
        {!link ? (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">Optional: add your name and phone and we will hold these dates for {brand.holdMinutes} minutes while we chat.</p>
            <Field label="Your name" htmlFor="wa-name"><Input id="wa-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
            <Field label="Phone" htmlFor="wa-phone"><Input id="wa-phone" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="0712 345 678" /></Field>
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <Button onClick={go} loading={busy}><MessageCircle className="h-4 w-4" /> Continue on WhatsApp</Button>
          </div>
        ) : (
          <div className="grid gap-3">
            <p className="text-sm">Your dates are held. Tap below to message us.</p>
            <Button asChild size="lg"><a href={link} target="_blank" rel="noopener noreferrer" onClick={onClose}><MessageCircle className="h-4 w-4" /> Open WhatsApp</a></Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
