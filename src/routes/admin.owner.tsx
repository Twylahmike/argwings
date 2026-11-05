import { useMemo, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { FileSpreadsheet, Printer } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { addDays, formatDate, monthStart, todayNairobi } from '~/lib/dates'
import { formatKES } from '~/lib/money'
import { useBrand } from '~/lib/brand'
import { downloadXlsx } from '~/lib/xlsx'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/form'
import { ErrorState, PageHeader, Skeleton, Stat, Tabs } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/owner')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner']),
  component: OwnerPage,
})

type Preset = 'today' | 'week' | 'month' | 'last_month' | 'year' | 'custom'
type Overview = {
  finance: { gross_booking_value: number; collected: number; unverified: number; refunds: number; outstanding: number; expenses: number; expenses_pending: number; net_operating_income: number }
  monthly: { month: string; revenue: number; expenses: number }[]
  by_property: { property: string; collected: number; bookings: number; occupied_nights: number; units: number }[]
  units: { total: number; occupied: number; maintenance: number; available: number }
  performance: { occupancy_pct: number; adr: number; revpar: number; occupied_nights: number; available_nights: number }
  bookings: { total: number; confirmed: number; pending_requests: number; cancelled: number; upcoming_checkins: number; upcoming_checkouts: number }
  operations: { rooms_to_clean: number; open_maintenance: number; open_tickets: number; unverified_payments: number; pending_expenses: number }
  staff_activity: { name: string; actions: number }[]
}

function range(p: Preset, today: string, custom: { from: string; to: string }) {
  if (p === 'today') return { from: today, to: today }
  if (p === 'week') { const wd = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7; return { from: addDays(today, -wd), to: today } }
  if (p === 'month') return { from: monthStart(today), to: today }
  if (p === 'last_month') { const s = monthStart(today); const e = addDays(s, -1); return { from: monthStart(e), to: e } }
  if (p === 'year') return { from: `${today.slice(0, 4)}-01-01`, to: today }
  return custom
}

function OwnerPage() {
  const brand = useBrand()
  const today = todayNairobi()
  const [preset, setPreset] = useState<Preset>('month')
  const [custom, setCustom] = useState({ from: addDays(today, -29), to: today })
  const r = range(preset, today, custom)
  const ok = !!r.from && !!r.to && r.to >= r.from && r.to <= addDays(today, 366)
  const q = useQuery({
    queryKey: ['owner-overview', r.from, r.to], enabled: ok,
    queryFn: async () => {
      const { data, error } = await sb().rpc('owner_overview', { p_from: r.from, p_to: r.to })
      if (error) throw error
      return data as Overview
    },
  })
  const d = q.data
  const chart = useMemo(() => (d?.monthly ?? []).map((m) => ({ ...m, label: m.month.slice(2) })), [d])

  function exportSheets() {
    if (!d) return
    const f = d.finance
    downloadXlsx(`owner-overview-${r.from}-to-${r.to}.xlsx`, [
      { name: 'Summary', rows: [[brand.businessName], ['Owner overview'], [`${r.from} to ${r.to}`], [], ['Gross booking value', f.gross_booking_value], ['Revenue collected (verified)', f.collected], ['Awaiting verification', f.unverified], ['Refunds', f.refunds], ['Outstanding receivables', f.outstanding], ['Expenses (approved)', f.expenses], ['Net operating income', f.net_operating_income], [], ['Occupancy %', d.performance.occupancy_pct], ['Average daily rate', d.performance.adr], ['Revenue per available night', d.performance.revpar]] },
      { name: 'By property', rows: [['Property', 'Collected (KES)', 'Bookings', 'Occupied nights', 'Rooms'], ...d.by_property.map((p) => [p.property, p.collected, p.bookings, p.occupied_nights, p.units])] },
      { name: 'Monthly', rows: [['Month', 'Revenue (KES)', 'Expenses (KES)'], ...d.monthly.map((m) => [m.month, m.revenue, m.expenses])] },
    ])
  }

  return (
    <div className="print-area">
      <div className="print:hidden"><PageHeader title="Owner's overview" description="How the business is doing, without opening every module. Revenue counts verified payments only."
        actions={<div className="flex gap-2"><Button variant="outline" disabled={!d} onClick={exportSheets}><FileSpreadsheet className="h-4 w-4" /> Excel</Button><Button variant="outline" disabled={!d} onClick={() => window.print()}><Printer className="h-4 w-4" /> PDF / Print</Button></div>} /></div>
      <div className="mb-4 hidden print:block"><p className="text-lg font-semibold">{brand.businessName} · Owner's overview</p><p className="text-sm">{formatDate(r.from)} to {formatDate(r.to)}</p></div>
      <div className="mb-5 flex flex-wrap items-center gap-3 print:hidden">
        <Tabs label="Period" value={preset} onChange={setPreset} tabs={[{ value: 'today', label: 'Today' }, { value: 'week', label: 'This week' }, { value: 'month', label: 'This month' }, { value: 'last_month', label: 'Last month' }, { value: 'year', label: 'This year' }, { value: 'custom', label: 'Custom' }]} />
        {preset === 'custom' && <><Input type="date" aria-label="From" className="w-40" value={custom.from} onChange={(e) => setCustom((s) => ({ ...s, from: e.target.value }))} /><Input type="date" aria-label="To" className="w-40" value={custom.to} onChange={(e) => setCustom((s) => ({ ...s, to: e.target.value }))} /></>}
      </div>
      {!ok && <p role="alert" className="text-sm text-danger">Choose an end date on or after the start date.</p>}
      {q.isLoading && <Skeleton className="h-96" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {d && (
        <div className="grid gap-5">
          <section aria-label="Financial overview" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Booking value" value={formatKES(d.finance.gross_booking_value)} hint="Stays starting in the period" />
            <Stat label="Revenue collected" value={formatKES(d.finance.collected)} hint="Verified, after refunds" />
            <Stat label="Outstanding" value={formatKES(d.finance.outstanding)} hint="Owed by guests" tone={d.finance.outstanding > 0 ? 'warn' : undefined} />
            <Stat label="Expenses" value={formatKES(d.finance.expenses)} hint="Approved" />
            <Stat label="Net operating income" value={formatKES(d.finance.net_operating_income)} tone={d.finance.net_operating_income < 0 ? 'danger' : undefined} />
            <Stat label="Awaiting verification" value={formatKES(d.finance.unverified)} hint="Not counted as revenue yet" tone={d.finance.unverified !== 0 ? 'warn' : undefined} />
            <Stat label="Refunds" value={formatKES(d.finance.refunds)} />
            <Stat label="Expenses awaiting approval" value={formatKES(d.finance.expenses_pending)} tone={d.finance.expenses_pending > 0 ? 'warn' : undefined} />
          </section>
          <Card><CardHeader><CardTitle>Revenue and expenses, last 12 months</CardTitle></CardHeader><CardContent>
            <div className="h-64" role="img" aria-label="Monthly revenue and expenses">
              <ResponsiveContainer><BarChart data={chart}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" tick={{ fontSize: 11 }} /><YAxis width={52} tick={{ fontSize: 11 }} tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} /><Tooltip formatter={(v) => formatKES(Number(v))} /><Legend />
                <Bar dataKey="revenue" name="Revenue" fill="var(--color-brand, #a9761f)" radius={[3, 3, 0, 0]} /><Bar dataKey="expenses" name="Expenses" fill="#6b7280" radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer>
            </div></CardContent></Card>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card><CardHeader><CardTitle>Property performance</CardTitle></CardHeader><CardContent className="grid gap-4">
              <div className="grid grid-cols-3 gap-3 text-center text-sm">
                <div><p className="text-xl font-semibold">{d.performance.occupancy_pct}%</p><p className="text-muted-foreground">Occupancy</p></div>
                <div><p className="text-xl font-semibold">{formatKES(d.performance.adr)}</p><p className="text-muted-foreground">Avg daily rate</p></div>
                <div><p className="text-xl font-semibold">{formatKES(d.performance.revpar)}</p><p className="text-muted-foreground">Per available night</p></div>
              </div>
              <p className="text-sm text-muted-foreground">{d.units.total} rooms: {d.units.occupied} occupied now, {d.units.available} available, {d.units.maintenance} out of service.</p>
              {d.by_property.length === 0 ? <p className="text-sm text-muted-foreground">No properties yet.</p> : (
                <ol className="divide-y text-sm">{d.by_property.map((p, i) => <li key={p.property} className="flex items-center justify-between gap-3 py-2"><span>{i + 1}. {p.property} <span className="text-xs text-muted-foreground">({p.bookings} booking{p.bookings === 1 ? '' : 's'}, {p.occupied_nights} nights)</span></span><b>{formatKES(p.collected)}</b></li>)}</ol>
              )}
            </CardContent></Card>
            <Card><CardHeader><CardTitle>Bookings</CardTitle></CardHeader><CardContent>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                {([['Reservations made', d.bookings.total], ['Confirmed', d.bookings.confirmed], ['Pending requests', d.bookings.pending_requests], ['Cancelled', d.bookings.cancelled], ['Check-ins, next 7 days', d.bookings.upcoming_checkins], ['Check-outs, next 7 days', d.bookings.upcoming_checkouts]] as const).map(([k, v]) => <div key={k} className="rounded-lg border p-3"><dt className="text-muted-foreground">{k}</dt><dd className="text-xl font-semibold">{v}</dd></div>)}
              </dl>
            </CardContent></Card>
            <Card><CardHeader><CardTitle>Operations needing attention</CardTitle></CardHeader><CardContent>
              <ul className="grid gap-2 text-sm">
                {([['Rooms to clean', d.operations.rooms_to_clean, '/admin/housekeeping'], ['Open maintenance requests', d.operations.open_maintenance, '/admin/maintenance'], ['Unresolved support tickets', d.operations.open_tickets, '/admin/support'], ['Payments to verify', d.operations.unverified_payments, '/admin/finance'], ['Expenses to approve', d.operations.pending_expenses, '/admin/finance']] as const).map(([k, v, to]) => (
                  <li key={k} className="flex items-center justify-between rounded-lg border p-3"><Link to={to} className="hover:underline">{k}</Link><b className={v > 0 ? 'text-amber-700 dark:text-amber-400' : ''}>{v}</b></li>))}
              </ul>
            </CardContent></Card>
            <Card><CardHeader><CardTitle>Staff activity</CardTitle></CardHeader><CardContent>
              {d.staff_activity.length === 0 ? <p className="text-sm text-muted-foreground">No recorded activity in this period.</p> : (
                <ul className="divide-y text-sm">{d.staff_activity.map((s, i) => <li key={`${s.name}-${i}`} className="flex justify-between py-2"><span>{s.name}</span><span className="tabular-nums text-muted-foreground">{s.actions} actions</span></li>)}</ul>
              )}
            </CardContent></Card>
          </div>
        </div>
      )}
    </div>
  )
}
