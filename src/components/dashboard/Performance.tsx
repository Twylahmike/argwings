import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { sb } from '~/lib/supabase'
import { addDays, formatDayMonth, monthStart, todayNairobi } from '~/lib/dates'
import { formatKES } from '~/lib/money'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { ErrorState, Skeleton, Tabs } from '~/components/ui/misc'
import { Input } from '~/components/ui/form'

type Window = { revenue: number; occupied_nights: number; room_revenue: number; bookings: number; cancellations: number; no_shows: number
  arrivals: number; available_nights: number; occupancy_pct: number; adr: number; revpar: number }
type Overview = { days: number; units: number; current: Window; previous: Window
  by_method: { key: string; amount: number }[]; by_source: { key: string; count: number; amount: number }[]
  daily: { day: string; revenue: number; occupied: number }[] }

type Preset = 'today' | '7d' | '30d' | 'month' | 'year' | 'custom'
const METHOD: Record<string, string> = { mpesa_stk: 'M-Pesa (STK)', mpesa_manual: 'M-Pesa (manual)', cash: 'Cash', bank: 'Bank', other: 'Other' }
const SOURCE: Record<string, string> = { website: 'Website', whatsapp: 'WhatsApp', walk_in: 'Walk-in', phone: 'Phone', manual: 'Staff entry' }

export function rangeFor(p: Preset, today: string, custom: { from: string; to: string }): { from: string; to: string } {
  if (p === 'today') return { from: today, to: today }
  if (p === '7d') return { from: addDays(today, -6), to: today }
  if (p === '30d') return { from: addDays(today, -29), to: today }
  if (p === 'month') return { from: monthStart(today), to: today }
  if (p === 'year') return { from: `${today.slice(0, 4)}-01-01`, to: today }
  return custom
}

/** Percent change vs the previous period; null when there is nothing to compare with. */
export function changePct(cur: number, prev: number): number | null {
  if (!prev) return cur ? null : 0
  return Math.round(((cur - prev) / prev) * 100)
}

function Kpi({ label, value, cur, prev, hint, invert }: { label: string; value: string; cur: number; prev: number; hint?: string; invert?: boolean }) {
  const ch = changePct(cur, prev)
  const good = ch == null || ch === 0 ? null : (ch > 0) !== !!invert
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 whitespace-nowrap text-xl font-semibold tabular-nums sm:text-2xl">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {ch == null ? 'No earlier data to compare' : <span className={good == null ? '' : good ? 'text-emerald-700 dark:text-emerald-400' : 'text-danger'}>{ch > 0 ? '▲' : ch < 0 ? '▼' : '•'} {Math.abs(ch)}%</span>}
        {ch != null && ' vs previous period'}{hint ? ` · ${hint}` : ''}
      </p>
    </div>
  )
}

export function Performance({ propertyId }: { propertyId: string }) {
  const today = todayNairobi()
  const [preset, setPreset] = useState<Preset>('30d')
  const [custom, setCustom] = useState({ from: addDays(today, -29), to: today })
  const r = rangeFor(preset, today, custom)
  const validRange = !!r.from && !!r.to && r.to >= r.from && r.to <= addDays(today, 366)

  const q = useQuery({
    queryKey: ['overview', propertyId, r.from, r.to],
    enabled: validRange,
    queryFn: async () => {
      const { data, error } = await sb().rpc('dashboard_overview', { p_from: r.from, p_to: r.to, p_property: propertyId === 'all' ? null : propertyId })
      if (error) throw error
      return data as Overview
    },
  })
  const d = q.data
  const series = useMemo(() => (d?.daily ?? []).map((x) => ({ ...x, label: formatDayMonth(x.day), pct: d && d.units ? Math.round((x.occupied / d.units) * 100) : 0 })), [d])

  return (
    <section aria-label="Performance" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Performance</h2>
        <Tabs label="Period" value={preset} onChange={setPreset} tabs={[{ value: 'today', label: 'Today' }, { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }, { value: 'month', label: 'This month' }, { value: 'year', label: 'This year' }, { value: 'custom', label: 'Custom' }]} />
      </div>
      {preset === 'custom' && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-2">From <Input type="date" className="w-40" value={custom.from} onChange={(e) => setCustom((s) => ({ ...s, from: e.target.value }))} /></label>
          <label className="flex items-center gap-2">To <Input type="date" className="w-40" value={custom.to} onChange={(e) => setCustom((s) => ({ ...s, to: e.target.value }))} /></label>
          {!validRange && <span role="alert" className="text-danger">Choose an end date on or after the start date.</span>}
        </div>
      )}
      {q.isLoading && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-24" />)}</div>}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Revenue received" value={formatKES(d.current.revenue)} cur={d.current.revenue} prev={d.previous.revenue} hint="after refunds" />
            <Kpi label="Occupancy" value={`${d.current.occupancy_pct}%`} cur={d.current.occupancy_pct} prev={d.previous.occupancy_pct} hint={`${d.current.occupied_nights} nights`} />
            <Kpi label="Avg nightly rate" value={formatKES(d.current.adr)} cur={d.current.adr} prev={d.previous.adr} />
            <Kpi label="Revenue per available night" value={formatKES(d.current.revpar)} cur={d.current.revpar} prev={d.previous.revpar} />
            <Kpi label="New bookings" value={String(d.current.bookings)} cur={d.current.bookings} prev={d.previous.bookings} />
            <Kpi label="Arrivals" value={String(d.current.arrivals)} cur={d.current.arrivals} prev={d.previous.arrivals} />
            <Kpi label="Cancellations" value={String(d.current.cancellations)} cur={d.current.cancellations} prev={d.previous.cancellations} invert />
            <Kpi label="No-shows" value={String(d.current.no_shows)} cur={d.current.no_shows} prev={d.previous.no_shows} invert />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Revenue received per day</CardTitle></CardHeader>
              <CardContent>
                {d.current.revenue === 0 && d.daily.every((x) => x.revenue === 0) ? <p className="py-6 text-sm text-muted-foreground">No payments received in this period.</p> : (
                  <div className="h-56" role="img" aria-label="Revenue received per day">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={series} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} />
                        <YAxis tick={{ fontSize: 11 }} width={48} tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
                        <Tooltip formatter={(v) => formatKES(Number(v))} />
                        <Area type="monotone" dataKey="revenue" name="Revenue" stroke="var(--color-brand, #a9761f)" fill="var(--color-brand, #a9761f)" fillOpacity={0.2} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Occupancy per day (%)</CardTitle></CardHeader>
              <CardContent>
                <div className="h-56" role="img" aria-label="Occupancy per day">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={series} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={24} />
                      <YAxis tick={{ fontSize: 11 }} width={36} domain={[0, 100]} />
                      <Tooltip formatter={(v) => `${v}%`} />
                      <Bar dataKey="pct" name="Occupied" fill="var(--color-brand, #a9761f)" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
            <Breakdown title="Revenue by payment method" empty="No payments in this period." rows={d.by_method.map((m) => ({ label: METHOD[m.key] ?? m.key, value: m.amount, text: formatKES(m.amount) }))} />
            <Breakdown title="Bookings by source" empty="No confirmed bookings created in this period." rows={d.by_source.map((s) => ({ label: SOURCE[s.key] ?? s.key, value: s.count, text: `${s.count} · ${formatKES(s.amount)}` }))} />
          </div>
        </>
      )}
    </section>
  )
}

function Breakdown({ title, rows, empty }: { title: string; rows: { label: string; value: number; text: string }[]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)))
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>
        {rows.length === 0 ? <p className="py-3 text-sm text-muted-foreground">{empty}</p> : (
          <ul className="grid gap-3">{rows.map((r) => (
            <li key={r.label} className="text-sm">
              <div className="flex justify-between gap-3"><span>{r.label}</span><span className="tabular-nums text-muted-foreground">{r.text}</span></div>
              <div className="mt-1 h-2 rounded bg-muted"><div className="h-2 rounded bg-brand" style={{ width: `${Math.max(3, (Math.abs(r.value) / max) * 100)}%` }} /></div>
            </li>))}</ul>
        )}
      </CardContent>
    </Card>
  )
}
