import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Download } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { addDays, addMonths, formatMonth, monthStart, todayNairobi } from '~/lib/dates'
import { formatKES } from '~/lib/money'
import { toCsv, downloadCsv } from '~/lib/csv'
import { averageDailyRate, cancellationRate, occupancyByMonth, revenueBy, statusCounts, topGuests, type RBooking, type RPayment } from '~/lib/reports'
import { SOURCE_LABEL, STATUS_LABEL, type BookingSource, type BookingStatus } from '~/lib/types'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/form'
import { ErrorState, PageHeader, Skeleton, Stat, TableWrap, td } from '~/components/ui/misc'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/reports')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: ReportsPage,
})

function ReportsPage() {
  const { me, scopeIds } = useAdmin()
  const today = todayNairobi()
  const [from, setFrom] = useState(addMonths(monthStart(today), -2))
  const [to, setTo] = useState(addDays(addMonths(monthStart(today), 1), -1)) // inclusive
  const toEx = addDays(to, 1)
  const valid = from && to && to >= from

  const q = useQuery({
    queryKey: ['reports', scopeIds, from, to],
    enabled: !!valid,
    queryFn: async () => {
      const [b, p, u, g] = await Promise.all([
        sb().from('bookings').select('id, property_id, guest_id, check_in, check_out, nights, status, source, nightly_total, total_amount').in('property_id', scopeIds).lt('check_in', toEx).gt('check_out', from).limit(5000),
        sb().from('payments').select('booking_id, kind, status, amount, confirmed_at, booking:bookings!inner(property_id)').in('booking.property_id', scopeIds).eq('status', 'succeeded').gte('confirmed_at', `${from}T00:00:00+03:00`).lt('confirmed_at', `${toEx}T00:00:00+03:00`).limit(10000),
        sb().from('units').select('property_id').in('property_id', scopeIds).eq('active', true),
        sb().from('guests').select('id, full_name').limit(5000),
      ])
      for (const r of [b, p, u, g]) if (r.error) throw r.error
      const units = new Map<string, number>()
      for (const x of u.data!) units.set(x.property_id, (units.get(x.property_id) ?? 0) + 1)
      return { bookings: b.data as RBooking[], payments: p.data as unknown as RPayment[], units, guests: new Map(g.data!.map((x) => [x.id as string, x.full_name as string])) }
    },
  })
  const name = (id: string) => me.properties.find((p) => p.id === id)?.name ?? id

  const r = useMemo(() => {
    if (!q.data) return null
    const { bookings, payments, units, guests } = q.data
    const occ = occupancyByMonth(bookings, units, from, toEx)
    const byProp = revenueBy(payments, bookings, (b) => b.property_id, from, toEx)
    const bySource = revenueBy(payments, bookings, (b) => b.source, from, toEx)
    const total = [...byProp.values()].reduce((s, v) => s + v, 0)
    return { occ, byProp, bySource, total, adr: averageDailyRate(bookings, from, toEx), statuses: statusCounts(bookings), cancel: cancellationRate(bookings), top: topGuests(bookings, payments, guests), count: bookings.filter((b) => b.status !== 'blocked').length }
  }, [q.data, from, toEx])

  const occChart = useMemo(() => {
    const months = [...new Set((r?.occ ?? []).map((o) => o.month))]
    return months.map((m) => ({ month: formatMonth(m).slice(0, 8), ...Object.fromEntries((r?.occ ?? []).filter((o) => o.month === m).map((o) => [name(o.propertyId), o.pct])) }))
  }, [r])
  const palette = ['#0f766e', '#1d4ed8', '#b45309', '#7c3aed', '#be123c']

  function exportAll() {
    if (!r) return
    const rows = [
      ...r.occ.map((o) => ({ section: 'Occupancy %', a: name(o.propertyId), b: o.month.slice(0, 7), v: o.pct })),
      ...[...r.byProp].map(([k, v]) => ({ section: 'Revenue by property (KES)', a: name(k), b: '', v })),
      ...[...r.bySource].map(([k, v]) => ({ section: 'Revenue by source (KES)', a: SOURCE_LABEL[k as BookingSource] ?? k, b: '', v })),
      ...[...r.statuses].map(([k, v]) => ({ section: 'Bookings by status', a: STATUS_LABEL[k as BookingStatus] ?? k, b: '', v })),
      { section: 'Average daily rate (KES)', a: '', b: '', v: r.adr }, { section: 'Cancellation rate %', a: '', b: '', v: r.cancel },
      ...r.top.map((t) => ({ section: 'Top guests (paid KES)', a: t.name, b: `${t.stays} stays`, v: t.paid })),
    ]
    downloadCsv(`report-${from}-to-${to}.csv`, toCsv(rows, [{ header: 'Section', value: (x) => x.section }, { header: 'Item', value: (x) => x.a }, { header: 'Detail', value: (x) => x.b }, { header: 'Value', value: (x) => x.v }]))
  }

  return (
    <div>
      <PageHeader title="Reports" description="Occupancy and revenue for the dates you choose. Use the property filter at the top to focus on one BNB."
        actions={<Button variant="outline" onClick={exportAll} disabled={!r}><Download className="h-4 w-4" /> Export CSV</Button>} />
      <div className="mb-5 flex flex-wrap gap-3">
        <label className="grid gap-1 text-sm font-medium">From<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="grid gap-1 text-sm font-medium">To<Input type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {!valid && <p role="alert" className="text-sm text-danger">Choose a start date before the end date.</p>}
      {q.isLoading && <Skeleton className="h-96" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {r && (
        <div className="grid gap-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Revenue" value={formatKES(r.total)} hint="Net of refunds" /><Stat label="Average daily rate" value={formatKES(r.adr)} />
            <Stat label="Bookings" value={r.count} /><Stat label="Cancellation rate" value={`${r.cancel}%`} />
          </div>
          <Card><CardHeader><CardTitle>Occupancy by property and month (%)</CardTitle></CardHeader><CardContent>
            <div className="h-64" role="img" aria-label="Bar chart of occupancy percentage per property per month">
              <ResponsiveContainer><BarChart data={occChart}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="month" tick={{ fontSize: 12 }} /><YAxis unit="%" width={44} domain={[0, 100]} tick={{ fontSize: 12 }} /><Tooltip /><Legend />
                {[...new Set(r.occ.map((o) => o.propertyId))].map((id, i) => <Bar key={id} dataKey={name(id)} fill={palette[i % palette.length]} radius={[3, 3, 0, 0]} />)}</BarChart></ResponsiveContainer>
            </div></CardContent></Card>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card><CardHeader><CardTitle>Revenue by property</CardTitle></CardHeader><CardContent><Table rows={[...r.byProp].map(([k, v]) => [name(k), formatKES(v)])} /></CardContent></Card>
            <Card><CardHeader><CardTitle>Revenue by source</CardTitle></CardHeader><CardContent><Table rows={[...r.bySource].map(([k, v]) => [SOURCE_LABEL[k as BookingSource] ?? k, formatKES(v)])} /></CardContent></Card>
            <Card><CardHeader><CardTitle>Bookings by status</CardTitle></CardHeader><CardContent><Table rows={[...r.statuses].map(([k, v]) => [STATUS_LABEL[k as BookingStatus] ?? k, String(v)])} /></CardContent></Card>
            <Card><CardHeader><CardTitle>Top guests</CardTitle></CardHeader><CardContent><Table rows={r.top.map((t) => [`${t.name} (${t.stays} stay${t.stays > 1 ? 's' : ''})`, formatKES(t.paid)])} /></CardContent></Card>
          </div>
        </div>
      )}
    </div>
  )
}

function Table({ rows }: { rows: string[][] }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">No data for these dates.</p>
  return <TableWrap><tbody className="divide-y">{rows.map(([a, b]) => <tr key={a}><td className={td}>{a}</td><td className={`${td} text-right font-medium tabular-nums`}>{b}</td></tr>)}</tbody></TableWrap>
}
