import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { sb } from '~/lib/supabase'
import { formatDateTime, todayNairobi } from '~/lib/dates'
import { formatKES } from '~/lib/money'
import { usePermissions } from '~/lib/permissions'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Skeleton } from '~/components/ui/misc'

type Counts = { requests: number; inquiries: number; maintenance: number; overdueCleaning: number; roomsOut: number; unverified: number }

/** "Needs attention" tiles and the latest payments and reviews. Every number is a live count; a tile only shows what the person may open. */
export function Attention({ scopeIds }: { scopeIds: string[] }) {
  const { can } = usePermissions()
  const today = todayNairobi()
  const q = useQuery({
    queryKey: ['attention', scopeIds, today], refetchInterval: 60_000,
    queryFn: async () => {
      const head = { count: 'exact' as const, head: true }
      const [req, inq, mnt, hk, out, unv, pays, revs] = await Promise.all([
        sb().from('booking_requests').select('id', head).in('property_id', scopeIds).eq('status', 'new'),
        sb().from('inquiries').select('id', head).eq('status', 'new'),
        sb().from('maintenance_requests').select('id', head).in('property_id', scopeIds).in('status', ['open', 'assigned', 'in_progress']),
        sb().from('housekeeping_tasks').select('id', head).in('property_id', scopeIds).in('status', ['dirty', 'in_progress']).lt('due_date', today),
        sb().from('units').select('id', head).in('property_id', scopeIds).eq('active', true).neq('maintenance_status', 'ok'),
        sb().from('payments').select('id, booking:bookings!inner(property_id)', head).in('booking.property_id', scopeIds).eq('status', 'succeeded').eq('verified', false),
        sb().from('payments').select('id, amount, kind, method, confirmed_at, verified, booking:bookings!inner(reference, property_id)').in('booking.property_id', scopeIds).eq('status', 'succeeded').order('confirmed_at', { ascending: false }).limit(5),
        sb().from('reviews').select('id, guest_name, rating, body, status, created_at').order('created_at', { ascending: false }).limit(4),
      ])
      const c = (r: { count: number | null }) => r.count ?? 0
      return {
        counts: { requests: c(req), inquiries: c(inq), maintenance: c(mnt), overdueCleaning: c(hk), roomsOut: c(out), unverified: c(unv) } as Counts,
        payments: ((pays.data ?? []) as unknown as { id: string; amount: number; kind: string; method: string; confirmed_at: string; verified: boolean; booking: { reference: string } }[]),
        reviews: ((revs.data ?? []) as { id: string; guest_name: string; rating: number; body: string; status: string }[]),
      }
    },
  })
  if (q.isLoading) return <Skeleton className="h-32" />
  if (!q.data) return null
  const { counts: k } = q.data
  const tiles: { label: string; n: number; to: string; perm: string; warn: boolean }[] = [
    { label: 'Booking requests to answer', n: k.requests, to: '/admin/requests', perm: 'requests.manage', warn: k.requests > 0 },
    { label: 'Unanswered inquiries', n: k.inquiries, to: '/admin/inquiries', perm: 'inquiries.manage', warn: k.inquiries > 0 },
    { label: 'Open maintenance requests', n: k.maintenance, to: '/admin/maintenance', perm: 'maintenance.report', warn: k.maintenance > 0 },
    { label: 'Overdue cleaning', n: k.overdueCleaning, to: '/admin/housekeeping', perm: 'housekeeping.view', warn: k.overdueCleaning > 0 },
    { label: 'Rooms out of service', n: k.roomsOut, to: '/admin/rooms', perm: 'rooms.manage', warn: k.roomsOut > 0 },
    { label: 'Payments to verify', n: k.unverified, to: '/admin/finance', perm: 'payments.verify', warn: k.unverified > 0 },
  ].filter((t) => can(t.perm))
  return (
    <section aria-label="Needs attention" className="grid gap-4">
      {tiles.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {tiles.map((t) => (
            <Link key={t.label} to={t.to} className="rounded-xl border bg-card p-4 hover:border-brand">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.label}</p>
              <p className={`mt-1 text-2xl font-semibold tabular-nums ${t.warn ? 'text-amber-700 dark:text-amber-400' : ''}`}>{t.n}</p>
            </Link>))}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {can('finance.view') && (
          <Card><CardHeader><CardTitle>Recent payments</CardTitle></CardHeader><CardContent>
            {q.data.payments.length === 0 ? <p className="py-3 text-sm text-muted-foreground">No payments yet.</p> : (
              <ul className="divide-y text-sm">{q.data.payments.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                  <span>{p.booking.reference} <span className="text-xs text-muted-foreground">· {p.method.replace('_', ' ')} · {formatDateTime(p.confirmed_at)}</span>{!p.verified && <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">awaiting verification</span>}</span>
                  <b>{p.kind === 'refund' ? '-' : ''}{formatKES(p.amount)}</b>
                </li>))}</ul>
            )}
          </CardContent></Card>
        )}
        {can('cms.manage') && (
          <Card><CardHeader><CardTitle>Recent reviews</CardTitle></CardHeader><CardContent>
            {q.data.reviews.length === 0 ? <p className="py-3 text-sm text-muted-foreground">No reviews yet.</p> : (
              <ul className="divide-y text-sm">{q.data.reviews.map((r) => (
                <li key={r.id} className="py-2"><p><b>{r.guest_name}</b> <span aria-label={`${r.rating} stars`}>{'★'.repeat(r.rating)}</span> <span className="text-xs text-muted-foreground">{r.status}</span></p><p className="line-clamp-2 text-muted-foreground">{r.body}</p></li>))}</ul>
            )}
            <Link to="/admin/reviews" className="mt-2 inline-block text-sm text-brand hover:underline">Open reviews</Link>
          </CardContent></Card>
        )}
      </div>
    </section>
  )
}
