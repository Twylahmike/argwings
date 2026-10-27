import { addDays } from './dates'
import { overlapNights } from './reports'

type B = { check_in: string; check_out: string; status: string; unit_id?: string }
const OCC = ['confirmed', 'checked_in']

/** Occupancy % over `days` nights from `from`: occupied unit-nights / (units x days). Blocked nights are not counted as sold. */
export function occupancyPct(bookings: B[], unitCount: number, from: string, days: number): number {
  if (!unitCount || days <= 0) return 0
  const to = addDays(from, days)
  const nights = bookings.filter((b) => OCC.includes(b.status) || b.status === 'checked_out').reduce((s, b) => s + overlapNights(b.check_in, b.check_out, from, to), 0)
  return Math.min(100, Math.round((nights / (unitCount * days)) * 100))
}
