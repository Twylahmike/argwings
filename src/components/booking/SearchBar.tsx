import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { addDays, todayNairobi } from '~/lib/dates'
import { Button } from '~/components/ui/button'
import { Field, Input, Select } from '~/components/ui/form'

export function SearchBar({ initial, propertyId }: { initial?: { checkIn?: string; checkOut?: string; guests?: number }; propertyId?: string }) {
  const nav = useNavigate()
  const today = todayNairobi()
  const [checkIn, setCheckIn] = useState(initial?.checkIn ?? '')
  const [checkOut, setCheckOut] = useState(initial?.checkOut ?? '')
  const [guests, setGuests] = useState(initial?.guests ?? 2)
  const [error, setError] = useState('')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!checkIn || !checkOut) return setError('Choose your check-in and check-out dates.')
    if (checkOut <= checkIn) return setError('Check-out must be after check-in.')
    setError('')
    nav({ to: '/search', search: { in: checkIn, out: checkOut, guests, ...(propertyId ? { property: propertyId } : {}) } })
  }
  return (
    <form action="/search" method="get" onSubmit={submit} className="grid gap-3 rounded-2xl border bg-card p-4 shadow-sm sm:grid-cols-[1fr_1fr_8rem_auto] sm:items-end" aria-label="Search availability">
      <Field label="Check-in" htmlFor="s-in"><Input id="s-in" name="in" type="date" min={today} value={checkIn} onChange={(e) => { setCheckIn(e.target.value); if (checkOut && checkOut <= e.target.value) setCheckOut(addDays(e.target.value, 1)) }} /></Field>
      <Field label="Check-out" htmlFor="s-out"><Input id="s-out" name="out" type="date" min={checkIn ? addDays(checkIn, 1) : today} value={checkOut} onChange={(e) => setCheckOut(e.target.value)} /></Field>
      <Field label="Guests" htmlFor="s-guests">
        <Select id="s-guests" name="guests" value={guests} onChange={(e) => setGuests(Number(e.target.value))}>{Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}</Select>
      </Field>
      {propertyId && <input type="hidden" name="property" value={propertyId} />}
      <Button type="submit" size="lg"><Search className="h-4 w-4" /> Search</Button>
      {error && <p role="alert" className="text-sm text-danger sm:col-span-4">{error}</p>}
    </form>
  )
}
