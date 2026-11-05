/** Pure report builders for the reporting centre (so the numbers can be tested). Money is whole KES. */
import { addDays, diffDays } from './dates'

export const REPORT_KINDS = [
  { id: 'daily', label: 'Daily sales' }, { id: 'weekly', label: 'Weekly sales' }, { id: 'monthly', label: 'Monthly revenue' }, { id: 'annual', label: 'Annual revenue' },
  { id: 'occupancy', label: 'Occupancy' }, { id: 'bookings', label: 'Bookings' }, { id: 'cancellations', label: 'Cancellations' }, { id: 'guests', label: 'Guests' },
  { id: 'payments', label: 'Payments' }, { id: 'outstanding', label: 'Outstanding balances' }, { id: 'expenses', label: 'Expenses' }, { id: 'profitability', label: 'Profitability' },
  { id: 'accommodation', label: 'Accommodation performance' }, { id: 'sources', label: 'Booking source performance' },
] as const
export type ReportKind = (typeof REPORT_KINDS)[number]['id']

export type RBook = { id: string; reference: string; property_id: string; unit_id: string; guest_id: string | null; check_in: string; check_out: string; nights: number; status: string; source: string; nightly_total: number; total_amount: number; amount_paid: number; cancel_reason: string | null; cancelled_at: string | null; created_at: string }
export type RPay = { booking_id: string; reference: string; property_id: string; kind: string; method: string; amount: number; verified: boolean; confirmed_at: string; mpesa_receipt: string | null }
export type RExp = { property_id: string; category: string; amount: number; expense_date: string; description: string | null; status: string; voided: boolean }
export type ReportData = {
  bookings: RBook[]; payments: RPay[]; expenses: RExp[]
  properties: Map<string, string>; units: Map<string, { name: string; property_id: string }>; guests: Map<string, string>
}
export type Col = { label: string; money?: boolean; num?: boolean }
export type Report = { title: string; columns: Col[]; rows: (string | number)[][]; totals?: (string | number)[] }

const LIVE = ['confirmed', 'checked_in', 'checked_out']
const signed = (p: { kind: string; amount: number }) => (p.kind === 'refund' ? -p.amount : p.amount)
const day = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 10) // Nairobi date
const isoWeekStart = (ymd: string) => { const d = new Date(ymd + 'T00:00:00Z'); const wd = (d.getUTCDay() + 6) % 7; return addDays(ymd, -wd) }
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

function group<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>(); for (const r of rows) { const k = key(r); m.set(k, [...(m.get(k) ?? []), r]) } return m
}
function revenueSeries(d: ReportData, title: string, keyOf: (ymd: string) => string, label: string): Report {
  const paid = d.payments.filter((p) => p.verified)
  const g = group(paid, (p) => keyOf(day(p.confirmed_at)))
  const rows = [...g.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, ps]) => [k, ps.filter((p) => p.kind !== 'refund').length, sum(ps.filter((p) => p.kind !== 'refund').map((p) => p.amount)), sum(ps.filter((p) => p.kind === 'refund').map((p) => p.amount)), sum(ps.map(signed))])
  return { title, columns: [{ label }, { label: 'Payments', num: true }, { label: 'Received', money: true }, { label: 'Refunds', money: true }, { label: 'Net collected', money: true }], rows, totals: ['Total', sum(rows.map((r) => r[1] as number)), sum(rows.map((r) => r[2] as number)), sum(rows.map((r) => r[3] as number)), sum(rows.map((r) => r[4] as number))] }
}

export function buildReport(kind: ReportKind, d: ReportData, from: string, toIncl: string): Report {
  const toEx = addDays(toIncl, 1)
  const prop = (id: string) => d.properties.get(id) ?? id
  const guest = (id: string | null) => (id ? d.guests.get(id) ?? '—' : '—')
  const real = d.bookings.filter((b) => b.status !== 'blocked')
  const nightsIn = (b: RBook) => Math.max(0, diffDays(b.check_in > from ? b.check_in : from, b.check_out < toEx ? b.check_out : toEx))
  switch (kind) {
    case 'daily': return revenueSeries(d, 'Daily sales', (y) => y, 'Date')
    case 'weekly': return revenueSeries(d, 'Weekly sales', isoWeekStart, 'Week starting')
    case 'monthly': return revenueSeries(d, 'Monthly revenue', (y) => y.slice(0, 7), 'Month')
    case 'annual': return revenueSeries(d, 'Annual revenue', (y) => y.slice(0, 4), 'Year')
    case 'occupancy': {
      const days = diffDays(from, toEx)
      const units = [...d.units.values()]
      const rows = [...d.properties.entries()].map(([id, name]) => {
        const n = units.filter((u) => u.property_id === id).length
        const occ = sum(real.filter((b) => b.property_id === id && LIVE.includes(b.status)).map(nightsIn))
        const avail = n * days
        return [name, n, avail, occ, avail ? Math.round((occ / avail) * 1000) / 10 : 0]
      })
      const tAv = sum(rows.map((r) => r[2] as number)), tOc = sum(rows.map((r) => r[3] as number))
      return { title: 'Occupancy', columns: [{ label: 'Property' }, { label: 'Rooms', num: true }, { label: 'Available nights', num: true }, { label: 'Occupied nights', num: true }, { label: 'Occupancy %', num: true }], rows, totals: ['All', sum(rows.map((r) => r[1] as number)), tAv, tOc, tAv ? Math.round((tOc / tAv) * 1000) / 10 : 0] }
    }
    case 'bookings': {
      const rows = real.sort((a, b) => b.check_in.localeCompare(a.check_in)).map((b) => [b.reference, guest(b.guest_id), prop(b.property_id), d.units.get(b.unit_id)?.name ?? '', b.check_in, b.check_out, b.nights, b.status.replace('_', ' '), b.source.replace('_', ' '), b.total_amount, b.amount_paid])
      return { title: 'Bookings', columns: [{ label: 'Reference' }, { label: 'Guest' }, { label: 'Property' }, { label: 'Room' }, { label: 'Check-in' }, { label: 'Check-out' }, { label: 'Nights', num: true }, { label: 'Status' }, { label: 'Source' }, { label: 'Total', money: true }, { label: 'Paid', money: true }], rows, totals: ['Total', '', '', '', '', '', sum(rows.map((r) => r[6] as number)), '', '', sum(rows.map((r) => r[9] as number)), sum(rows.map((r) => r[10] as number))] }
    }
    case 'cancellations': {
      const c = real.filter((b) => b.status === 'cancelled' || b.status === 'no_show')
      const rows = c.map((b) => [b.reference, guest(b.guest_id), prop(b.property_id), b.check_in, b.status.replace('_', ' '), b.cancel_reason ?? '', b.total_amount])
      const rate = real.length ? Math.round((c.length / real.length) * 1000) / 10 : 0
      return { title: `Cancellations (${rate}% of bookings)`, columns: [{ label: 'Reference' }, { label: 'Guest' }, { label: 'Property' }, { label: 'Check-in' }, { label: 'Status' }, { label: 'Reason' }, { label: 'Value lost', money: true }], rows, totals: ['Total', '', '', '', '', '', sum(rows.map((r) => r[6] as number))] }
    }
    case 'guests': {
      const g = group(real.filter((b) => b.guest_id && LIVE.includes(b.status)), (b) => b.guest_id!)
      const rows = [...g.entries()].map(([id, bs]) => [guest(id), bs.length, sum(bs.map((b) => b.nights)), sum(bs.map((b) => b.amount_paid)), bs.map((b) => b.check_in).sort().at(-1) ?? '']).sort((a, b) => (b[3] as number) - (a[3] as number))
      return { title: 'Guests', columns: [{ label: 'Guest' }, { label: 'Stays', num: true }, { label: 'Nights', num: true }, { label: 'Paid', money: true }, { label: 'Last stay' }], rows, totals: ['Total', sum(rows.map((r) => r[1] as number)), sum(rows.map((r) => r[2] as number)), sum(rows.map((r) => r[3] as number)), ''] }
    }
    case 'payments': {
      const rows = d.payments.sort((a, b) => b.confirmed_at.localeCompare(a.confirmed_at)).map((p) => [day(p.confirmed_at), p.reference, prop(p.property_id), p.kind, p.method.replace('_', ' '), p.mpesa_receipt ?? '', p.verified ? 'Verified' : 'Awaiting verification', signed(p)])
      return { title: 'Payments', columns: [{ label: 'Date' }, { label: 'Booking' }, { label: 'Property' }, { label: 'Type' }, { label: 'Method' }, { label: 'Receipt' }, { label: 'Verification' }, { label: 'Amount', money: true }], rows, totals: ['Verified total', '', '', '', '', '', '', sum(d.payments.filter((p) => p.verified).map(signed))] }
    }
    case 'outstanding': {
      const rows = real.filter((b) => LIVE.includes(b.status) && b.total_amount > b.amount_paid).sort((a, b) => a.check_in.localeCompare(b.check_in)).map((b) => [b.reference, guest(b.guest_id), prop(b.property_id), b.check_in, b.status.replace('_', ' '), b.total_amount, b.amount_paid, b.total_amount - b.amount_paid])
      return { title: 'Outstanding balances', columns: [{ label: 'Reference' }, { label: 'Guest' }, { label: 'Property' }, { label: 'Check-in' }, { label: 'Status' }, { label: 'Total', money: true }, { label: 'Paid', money: true }, { label: 'Balance', money: true }], rows, totals: ['Total', '', '', '', '', sum(rows.map((r) => r[5] as number)), sum(rows.map((r) => r[6] as number)), sum(rows.map((r) => r[7] as number))] }
    }
    case 'expenses': {
      const ok = d.expenses.filter((e) => !e.voided && e.status === 'approved')
      const rows = ok.sort((a, b) => b.expense_date.localeCompare(a.expense_date)).map((e) => [e.expense_date, prop(e.property_id), e.category, e.description ?? '', e.amount])
      return { title: 'Expenses (approved)', columns: [{ label: 'Date' }, { label: 'Property' }, { label: 'Category' }, { label: 'Description' }, { label: 'Amount', money: true }], rows, totals: ['Total', '', '', '', sum(rows.map((r) => r[4] as number))] }
    }
    case 'profitability': {
      const rows = [...d.properties.entries()].map(([id, name]) => {
        const inc = sum(d.payments.filter((p) => p.verified && p.property_id === id).map(signed))
        const exp = sum(d.expenses.filter((e) => !e.voided && e.status === 'approved' && e.property_id === id).map((e) => e.amount))
        return [name, inc, exp, inc - exp, inc ? Math.round(((inc - exp) / inc) * 1000) / 10 : 0]
      })
      const ti = sum(rows.map((r) => r[1] as number)), te = sum(rows.map((r) => r[2] as number))
      return { title: 'Profitability', columns: [{ label: 'Property' }, { label: 'Collected', money: true }, { label: 'Expenses', money: true }, { label: 'Net operating income', money: true }, { label: 'Margin %', num: true }], rows, totals: ['All', ti, te, ti - te, ti ? Math.round(((ti - te) / ti) * 1000) / 10 : 0] }
    }
    case 'accommodation': {
      const days = diffDays(from, toEx)
      const rows = [...d.units.entries()].map(([id, u]) => {
        const bs = real.filter((b) => b.unit_id === id && LIVE.includes(b.status))
        const nights = sum(bs.map(nightsIn))
        const rev = sum(bs.map((b) => (b.nights ? Math.round((b.nightly_total * nightsIn(b)) / b.nights) : 0)))
        return [`${prop(u.property_id)} · ${u.name}`, bs.length, nights, days ? Math.round((nights / days) * 1000) / 10 : 0, rev, nights ? Math.round(rev / nights) : 0]
      }).sort((a, b) => (b[4] as number) - (a[4] as number))
      return { title: 'Accommodation performance', columns: [{ label: 'Room' }, { label: 'Bookings', num: true }, { label: 'Nights sold', num: true }, { label: 'Occupancy %', num: true }, { label: 'Room revenue', money: true }, { label: 'Average nightly rate', money: true }], rows, totals: ['All', sum(rows.map((r) => r[1] as number)), sum(rows.map((r) => r[2] as number)), '', sum(rows.map((r) => r[4] as number)), ''] }
    }
    case 'sources': {
      const g = group(real.filter((b) => LIVE.includes(b.status)), (b) => b.source)
      const rows = [...g.entries()].map(([k, bs]) => [k.replace('_', ' '), bs.length, sum(bs.map((b) => b.total_amount)), sum(bs.map((b) => b.amount_paid))]).sort((a, b) => (b[2] as number) - (a[2] as number))
      return { title: 'Booking source performance', columns: [{ label: 'Source' }, { label: 'Bookings', num: true }, { label: 'Booking value', money: true }, { label: 'Paid', money: true }], rows, totals: ['Total', sum(rows.map((r) => r[1] as number)), sum(rows.map((r) => r[2] as number)), sum(rows.map((r) => r[3] as number))] }
    }
  }
}
