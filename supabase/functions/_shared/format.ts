// Formatting helpers for messages. Plain TS (no Deno APIs) so Vitest can import it.
// KEEP IN SYNC with src/lib/money.ts and src/lib/dates.ts (a unit test compares them).

export function formatKES(amount: number | null | undefined): string {
  return `KES ${Math.round(Number(amount ?? 0)).toLocaleString('en-US')}`
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 'YYYY-MM-DD' -> 'Tue 3 Nov 2026' without any timezone conversion. */
export function formatDate(ymd: string | null | undefined): string {
  if (!ymd) return ''
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return `${WD[wd]} ${d} ${MO[m - 1]} ${y}`
}

/** 'YYYY-MM-DD' for "today" in Nairobi. */
export function todayNairobi(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return t.toISOString().slice(0, 10)
}

export function formatTime(t: string | null | undefined): string {
  return (t ?? '').slice(0, 5)
}
