import { format } from 'date-fns'

/**
 * Dates are 'YYYY-MM-DD' strings everywhere (Postgres `date`). They are never turned into UTC instants,
 * so there is no timezone drift. Instants (timestamptz) are always shown in Africa/Nairobi.
 */
export const TZ = 'Africa/Nairobi'

export function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d) // local midnight; only ever formatted back locally
}
export function toYmd(d: Date): string {
  return format(d, 'yyyy-MM-dd')
}

/** Today in Nairobi as YYYY-MM-DD, independent of the viewer's device timezone. */
export function todayNairobi(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function addDays(ymd: string, n: number): string {
  const d = parseYmd(ymd)
  d.setDate(d.getDate() + n)
  return toYmd(d)
}
export function diffDays(a: string, b: string): number {
  return Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / 86_400_000)
}
export const nightsBetween = diffDays

/** 1 (Mon) .. 7 (Sun), matching Postgres isodow. */
export function isoWeekday(ymd: string): number {
  const d = parseYmd(ymd).getDay()
  return d === 0 ? 7 : d
}

export function eachDay(from: string, toExclusive: string): string[] {
  const out: string[] = []
  for (let d = from; d < toExclusive; d = addDays(d, 1)) out.push(d)
  return out
}

/** "Tue 4 Nov 2026" */
export function formatDate(ymd: string | null | undefined): string {
  if (!ymd) return ''
  return format(parseYmd(ymd.slice(0, 10)), 'EEE d MMM yyyy')
}
/** "4 Nov" */
export function formatDayMonth(ymd: string): string {
  return format(parseYmd(ymd), 'd MMM')
}
export function formatMonth(ymd: string): string {
  return format(parseYmd(ymd), 'MMMM yyyy')
}
/** "Tue 4 Nov 2026, 14:30" in Nairobi time, 24h. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]))
  return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}`
}
/** '14:00:00' -> '14:00' */
export function formatTime(t: string | null | undefined): string {
  return (t ?? '').slice(0, 5)
}

export function monthStart(ymd: string): string {
  return ymd.slice(0, 7) + '-01'
}
export function addMonths(ymd: string, n: number): string {
  const d = parseYmd(monthStart(ymd))
  d.setMonth(d.getMonth() + n)
  return toYmd(d)
}
