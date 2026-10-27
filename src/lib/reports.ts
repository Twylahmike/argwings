import { addDays, diffDays, monthStart, addMonths } from './dates'

export type RBooking = {
  id: string; property_id: string; guest_id: string | null; check_in: string; check_out: string; nights: number
  status: string; source: string; nightly_total: number; total_amount: number
}
export type RPayment = { booking_id: string; kind: string; status: string; amount: number; confirmed_at: string | null }

const OCCUPYING = ['confirmed', 'checked_in', 'checked_out']

/** Nights of [checkIn, checkOut) that fall inside [from, toExclusive). */
export function overlapNights(checkIn: string, checkOut: string, from: string, toExclusive: string): number {
  const s = checkIn > from ? checkIn : from
  const e = checkOut < toExclusive ? checkOut : toExclusive
  return Math.max(0, diffDays(s, e))
}

export function monthsBetween(from: string, toExclusive: string): string[] {
  const out: string[] = []
  for (let m = monthStart(from); m < toExclusive; m = addMonths(m, 1)) out.push(m)
  return out
}

export type OccupancyRow = { propertyId: string; month: string; bookedNights: number; availableNights: number; pct: number }

/** Occupancy % per property per month = booked nights / (units x days in the month window). */
export function occupancyByMonth(bookings: RBooking[], unitsPerProperty: Map<string, number>, from: string, toExclusive: string): OccupancyRow[] {
  const rows: OccupancyRow[] = []
  for (const [propertyId, units] of unitsPerProperty) {
    for (const m of monthsBetween(from, toExclusive)) {
      const ws = m > from ? m : from
      const we = addMonths(m, 1) < toExclusive ? addMonths(m, 1) : toExclusive
      const days = diffDays(ws, we)
      if (days <= 0) continue
      const booked = bookings.filter((b) => b.property_id === propertyId && OCCUPYING.includes(b.status))
        .reduce((s, b) => s + overlapNights(b.check_in, b.check_out, ws, we), 0)
      const available = units * days
      rows.push({ propertyId, month: m, bookedNights: booked, availableNights: available, pct: available ? Math.round((booked / available) * 1000) / 10 : 0 })
    }
  }
  return rows
}

/** Average daily rate = room revenue (excluding cleaning fees) / nights sold, for stays that start in the range. */
export function averageDailyRate(bookings: RBooking[], from: string, toExclusive: string): number {
  const rel = bookings.filter((b) => OCCUPYING.includes(b.status) && b.check_in >= from && b.check_in < toExclusive)
  const nights = rel.reduce((s, b) => s + b.nights, 0)
  return nights ? Math.round(rel.reduce((s, b) => s + b.nightly_total, 0) / nights) : 0
}

/** Net money in (payments minus refunds) by a key, within [from, toExclusive) in Nairobi dates. */
export function revenueBy(payments: RPayment[], bookings: RBooking[], key: (b: RBooking) => string, from: string, toExclusive: string): Map<string, number> {
  const byId = new Map(bookings.map((b) => [b.id, b]))
  const out = new Map<string, number>()
  for (const p of payments) {
    if (p.status !== 'succeeded' || !p.confirmed_at) continue
    const day = new Date(new Date(p.confirmed_at).getTime() + 3 * 3600_000).toISOString().slice(0, 10) // Nairobi date
    if (day < from || day >= toExclusive) continue
    const b = byId.get(p.booking_id)
    if (!b) continue
    const k = key(b)
    out.set(k, (out.get(k) ?? 0) + (p.kind === 'refund' ? -p.amount : p.amount))
  }
  return out
}

export function statusCounts(bookings: RBooking[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const b of bookings) if (b.status !== 'blocked') m.set(b.status, (m.get(b.status) ?? 0) + 1)
  return m
}

/** cancelled / all real bookings (blocks excluded). */
export function cancellationRate(bookings: RBooking[]): number {
  const real = bookings.filter((b) => b.status !== 'blocked')
  return real.length ? Math.round((real.filter((b) => b.status === 'cancelled').length / real.length) * 1000) / 10 : 0
}

export function topGuests(bookings: RBooking[], payments: RPayment[], names: Map<string, string>, limit = 5): { guestId: string; name: string; paid: number; stays: number }[] {
  const byBooking = new Map<string, number>()
  for (const p of payments) if (p.status === 'succeeded') byBooking.set(p.booking_id, (byBooking.get(p.booking_id) ?? 0) + (p.kind === 'refund' ? -p.amount : p.amount))
  const agg = new Map<string, { paid: number; stays: number }>()
  for (const b of bookings) {
    if (!b.guest_id || !OCCUPYING.includes(b.status)) continue
    const a = agg.get(b.guest_id) ?? { paid: 0, stays: 0 }
    a.paid += byBooking.get(b.id) ?? 0
    a.stays += 1
    agg.set(b.guest_id, a)
  }
  return [...agg].map(([guestId, a]) => ({ guestId, name: names.get(guestId) ?? 'Guest', ...a })).sort((x, y) => y.paid - x.paid).slice(0, limit)
}

export { addDays }
