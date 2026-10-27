import { addDays, eachDay, isoWeekday, nightsBetween } from './dates'

/**
 * Client-side mirror of the SQL function quote_stay(). Used for instant previews only:
 * the server always re-prices (create_booking) and its answer is the one that counts.
 * Priority per night: seasonal override > weekend rate (Fri + Sat nights) > base rate.
 * Cleaning fee is charged once per stay.
 */
export type PricedUnit = { base_rate: number; weekend_rate: number | null; cleaning_fee: number; min_nights: number }
export type RateOverride = { start_date: string; end_date: string; nightly_rate: number }

export type Quote = {
  nights: number
  nightlyTotal: number
  cleaningFee: number
  total: number
  minNights: number
  perNight: { date: string; rate: number; kind: 'override' | 'weekend' | 'base' }[]
  meetsMinNights: boolean
}

/** `overrides` must be ordered oldest -> newest; the newest matching override wins (like the SQL). */
export function quoteStay(unit: PricedUnit, overrides: RateOverride[], checkIn: string, checkOut: string): Quote {
  const nights = nightsBetween(checkIn, checkOut)
  const perNight = nights > 0
    ? eachDay(checkIn, checkOut).map((date) => {
        const matches = overrides.filter((o) => date >= o.start_date && date <= o.end_date)
        if (matches.length) return { date, rate: matches[matches.length - 1].nightly_rate, kind: 'override' as const }
        const wd = isoWeekday(date)
        if ((wd === 5 || wd === 6) && unit.weekend_rate != null) return { date, rate: unit.weekend_rate, kind: 'weekend' as const }
        return { date, rate: unit.base_rate, kind: 'base' as const }
      })
    : []
  const nightlyTotal = perNight.reduce((s, n) => s + n.rate, 0)
  return {
    nights: Math.max(nights, 0),
    nightlyTotal,
    cleaningFee: unit.cleaning_fee,
    total: nights > 0 ? nightlyTotal + unit.cleaning_fee : 0,
    minNights: unit.min_nights,
    perNight,
    meetsMinNights: nights >= unit.min_nights,
  }
}

/** deposit = round(total * pct / 100), then rounded UP to the nearest KES 10, never above the total. */
export function calcDeposit(total: number, percent: number): number {
  const raw = Math.round((total * percent) / 100)
  return Math.min(total, Math.ceil(raw / 10) * 10)
}

/** Lowest nightly rate a guest could pay for a unit (for "from KES X / night"). */
export function fromRate(unit: Pick<PricedUnit, 'base_rate' | 'weekend_rate'>): number {
  return unit.weekend_rate != null ? Math.min(unit.base_rate, unit.weekend_rate) : unit.base_rate
}

/** Do the two [in,out) ranges overlap? Back-to-back (out == in) does not. */
export function rangesOverlap(aIn: string, aOut: string, bIn: string, bOut: string): boolean {
  return aIn < bOut && bIn < aOut
}

export { addDays }
