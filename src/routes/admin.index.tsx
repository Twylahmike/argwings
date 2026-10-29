import { useEffect } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { isOwner, requireRole } from '~/lib/auth'
import { BOOKING_SELECT, balance, type BookingRow } from '~/lib/bookings-api'
import { addDays, formatDate, monthStart, todayNairobi } from '~/lib/dates'
import { formatKES } from '~/lib/money'
import { occupancyPct } from '~/lib/dashboard'
import { StatusBadge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { ErrorState, PageHeader, Skeleton, Stat } from '~/components/ui/misc'
import { BookingLink, Money } from '~/components/booking/BookingBits'
import { useAdmin } from '~/components/layout/AdminShell'
import { GettingStarted } from '~/components/layout/GettingStarted'

export const Route = createFileRoute('/admin/')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: Dashboard,
})

function Dashboard() {
  const { me, scopeIds, propertyId } = useAdmin()
  const qc = useQueryClient()
  const today = todayNairobi()
  const month = monthStart(today)

  const q = useQuery({
    queryKey: ['dashboard', scopeIds, today],
    queryFn: async () => {
      const [live, owing, review, units, tasks, pnl] = await Promise.all([
        sb().from('bookings').select(BOOKING_SELECT).in('property_id', scopeIds).in('status', ['pending', 'confirmed', 'checked_in', 'checked_out', 'blocked']).lte('check_in', addDays(today, 14)).gte('check_out', today).limit(2000),
        sb().from('bookings').select(BOOKING_SELECT).in('property_id', scopeIds).in('status', ['confirmed', 'checked_in', 'checked_out']).gte('check_out', addDays(today, -60)).limit(2000),
        sb().from('bookings').select(BOOKING_SELECT).in('property_id', scopeIds).eq('payment_review', true).limit(50),
        sb().from('units').select('id', { count: 'exact', head: true }).in('property_id', scopeIds).eq('active', true),
        sb().from('housekeeping_tasks').select('id', { count: 'exact', head: true }).in('property_id', scopeIds).in('status', ['dirty', 'in_progress']),
        sb().rpc('monthly_pnl', { p_month: month }),
      ])
      for (const r of [live, owing, review, units, tasks, pnl]) if (r.error) throw r.error
      const liveRows = live.data as unknown as BookingRow[]
      const revenue = (pnl.data as { property_id: string; income: number; refunds: number }[]).filter((r) => scopeIds.includes(r.property_id)).reduce((s, r) => s + r.income - r.refunds, 0)
      const holds = await sb().from('bookings').select('id', { count: 'exact', head: true }).in('property_id', scopeIds).eq('status', 'pending')
      return { liveRows, owing: (owing.data as unknown as BookingRow[]).filter((b) => balance(b) > 0), review: review.data as unknown as BookingRow[], unitCount: units.count ?? 0, tasks: tasks.count ?? 0, revenue, holds: holds.count ?? 0 }
    },
  })

  // Realtime: bookings and payments change the numbers, so refresh when either does.
  useEffect(() => {
    const ch = sb().channel('dash')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, () => qc.invalidateQueries({ queryKey: ['dashboard'] }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, () => qc.invalidateQueries({ queryKey: ['dashboard'] }))
      .subscribe()
    return () => { sb().removeChannel(ch) }
  }, [qc])

  const d = q.data
  const real = (d?.liveRows ?? []).filter((b) => b.status !== 'blocked')
  const arrivals = real.filter((b) => b.check_in === today && ['pending', 'confirmed'].includes(b.status))
  const departures = real.filter((b) => b.check_out === today && b.status === 'checked_in')
  const inHouse = real.filter((b) => b.status === 'checked_in' && b.check_in <= today && b.check_out > today)
  const total = (d?.liveRows ?? []).filter((b) => b.status !== 'checked_out' || b.check_out > today)

  return (
    <div>
      <PageHeader title={`Hello, ${me.fullName.split(' ')[0]}`} description={`${formatDate(today)} · ${propertyId === 'all' ? 'All properties' : me.properties.find((p) => p.id === propertyId)?.name}`} />
      {q.isLoading && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-24" />)}</div>}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {d && (
        <div className="grid grid-cols-1 gap-5">
          {isOwner(me) && <GettingStarted />}
          {d.review.length > 0 && (
            <div role="alert" className="rounded-xl border border-danger/50 bg-danger/5 p-4">
              <p className="flex items-center gap-2 font-semibold text-danger"><AlertTriangle className="h-5 w-5" aria-hidden /> Payments needing review ({d.review.length})</p>
              <ul className="mt-2 grid gap-1 text-sm">{d.review.map((b) => <li key={b.id}><BookingLink id={b.id}>{b.reference}</BookingLink> · {b.guest?.full_name} · {b.review_reason}</li>)}</ul>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 [&>*:last-child]:col-span-2 lg:[&>*:last-child]:col-span-1">
            <Stat label="Arriving today" value={arrivals.length} /><Stat label="Departing today" value={departures.length} />
            <Stat label="In-house guests" value={inHouse.reduce((s, b) => s + b.num_guests, 0)} hint={`${inHouse.length} booking${inHouse.length === 1 ? '' : 's'}`} />
            <Stat label="Needs cleaning" value={d.tasks} tone={d.tasks > 0 ? 'warn' : undefined} hint="units" />
            <Stat label="Occupancy tonight" value={`${occupancyPct(total, d.unitCount, today, 1)}%`} /><Stat label="Next 7 nights" value={`${occupancyPct(total, d.unitCount, today, 7)}%`} />
            <Stat label="Revenue this month" value={formatKES(d.revenue)} /><Stat label="Outstanding balances" value={formatKES(d.owing.reduce((s, b) => s + balance(b), 0))} hint={`${d.owing.length} booking${d.owing.length === 1 ? '' : 's'}`} tone={d.owing.length ? 'warn' : undefined} />
            <Stat label="Pending holds" value={d.holds} />
          </div>
          <OccupancyStrip bookings={total} units={d.unitCount} from={today} />
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <ListCard title="Arriving today" rows={arrivals} empty="No arrivals today." extra={(b) => <><StatusBadge status={b.status} /> {balance(b) > 0 && <span className="text-xs text-amber-700 dark:text-amber-400">owes {formatKES(balance(b))}</span>}</>} />
            <ListCard title="Departing today" dateOf="out" rows={departures} empty="No departures today." extra={(b) => balance(b) > 0 ? <span className="text-xs text-amber-700 dark:text-amber-400">owes {formatKES(balance(b))}</span> : <span className="text-xs text-emerald-700 dark:text-emerald-400">paid</span>} />
            <ListCard title="Balances due" rows={d.owing.sort((a, b) => a.check_in.localeCompare(b.check_in)).slice(0, 10)} empty="Nobody owes anything." extra={(b) => <Money value={balance(b)} className="font-medium" />} />
          </div>
          <p className="text-xs text-muted-foreground">Updates live as bookings and payments come in. <Link to="/admin/calendar" className="underline">Open the calendar</Link></p>
        </div>
      )}
    </div>
  )
}

function ListCard({ title, rows, empty, extra, dateOf = 'in' }: { title: string; rows: BookingRow[]; empty: string; extra: (b: BookingRow) => React.ReactNode; dateOf?: 'in' | 'out' }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>
        {rows.length === 0 ? <p className="py-3 text-sm text-muted-foreground">{empty}</p> : (
          <ul className="divide-y">{rows.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <div className="min-w-0"><BookingLink id={b.id}>{b.guest?.full_name ?? b.reference}</BookingLink><p className="truncate text-xs text-muted-foreground">{b.property.name} · {b.unit.name} · {formatDate(dateOf === 'out' ? b.check_out : b.check_in)}</p></div>
              <div className="flex shrink-0 items-center gap-2">{extra(b)}</div>
            </li>))}</ul>
        )}
      </CardContent>
    </Card>
  )
}

/** 14 nights of occupancy as plain CSS bars (no chart library on the landing screen). */
function OccupancyStrip({ bookings, units, from }: { bookings: BookingRow[]; units: number; from: string }) {
  const days = Array.from({ length: 14 }, (_, i) => addDays(from, i))
  return (
    <Card>
      <CardHeader><CardTitle>Next 14 nights</CardTitle></CardHeader>
      <CardContent>
        <ul className="flex items-end gap-1" aria-label="Occupancy for the next 14 nights">
          {days.map((d, i) => {
            const pct = occupancyPct(bookings, units, d, 1)
            return (
              <li key={d} className="flex flex-1 flex-col items-center gap-1" title={`${formatDate(d)}: ${pct}% occupied`}>
                <span className="text-[10px] tabular-nums text-muted-foreground">{pct}</span>
                <span className="flex h-20 w-full items-end rounded bg-muted"><span className="w-full rounded bg-brand" style={{ height: `${Math.max(pct, 3)}%`, opacity: i === 0 ? 1 : 0.75 }} /></span>
                <span className={`text-[10px] ${i === 0 ? 'font-semibold text-brand' : 'text-muted-foreground'}`}>{Number(d.slice(8))}</span>
              </li>
            )
          })}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">Percent of units occupied each night.</p>
      </CardContent>
    </Card>
  )
}
