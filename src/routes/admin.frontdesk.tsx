import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DoorClosed, DoorOpen } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { errMessage } from '~/lib/utils'
import { addDays, formatDate, todayNairobi } from '~/lib/dates'
import { formatKES } from '~/lib/money'
import { formatPhoneLocal } from '~/lib/phone'
import { CheckInDialog, CheckOutDialog, type FrontDeskBooking } from '~/components/booking/FrontDeskDialogs'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/form'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { EmptyState, ErrorState, PageHeader, Skeleton } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/frontdesk')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: FrontDesk,
})

type Arrival = { id: string; reference: string; guest: string | null; phone: string | null; property: string; unit: string; guests: number; check_in: string; check_out: string; status: string; balance: number; deposit_ok: boolean; room_ready: boolean }
type InHouse = { id: string; reference: string; guest: string | null; phone: string | null; property: string; unit: string; check_out: string; balance: number; due_out: boolean; overdue: boolean }

function FrontDesk() {
  const qc = useQueryClient()
  const [date, setDate] = useState(todayNairobi())
  const [dialog, setDialog] = useState<{ kind: 'in' | 'out'; booking: FrontDeskBooking } | null>(null)
  const [ref, setRef] = useState('')
  const q = useQuery({
    queryKey: ['frontdesk', date],
    queryFn: async () => {
      const { data, error } = await sb().rpc('arrivals_departures', { p_date: date })
      if (error) throw error
      return data as { arrivals: Arrival[]; in_house: InHouse[] }
    },
  })
  async function open(kind: 'in' | 'out', id?: string, reference?: string) {
    let query = sb().from('bookings').select('id, reference, property_id, unit_id, num_guests, check_in, check_out, total_amount, amount_paid, deposit_required, status')
    query = id ? query.eq('id', id) : query.ilike('reference', (reference ?? '').trim())
    const { data, error } = await query.maybeSingle()
    if (error) return toast.error(errMessage(error))
    if (!data) return toast.error('No booking with that reference.')
    if (kind === 'in' && data.status !== 'confirmed') return toast.error(`That booking is ${String(data.status).replace('_', ' ')}, so it cannot be checked in.`)
    if (kind === 'out' && data.status !== 'checked_in') return toast.error(`That booking is ${String(data.status).replace('_', ' ')}, so it cannot be checked out.`)
    setDialog({ kind, booking: data as FrontDeskBooking })
  }
  const done = () => { setDialog(null); qc.invalidateQueries({ queryKey: ['frontdesk'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }) }
  const today = todayNairobi()
  return (
    <div>
      <PageHeader title="Check-in & check-out" description="Today's arrivals and the guests in the house. Rooms must be paid for, free and clean before a guest can be checked in."
        actions={<div className="flex items-center gap-2"><Input type="date" aria-label="Day" className="w-40" value={date} onChange={(e) => setDate(e.target.value || today)} /><Button variant="outline" onClick={() => setDate(addDays(date, 1))}>Next day</Button></div>} />
      <div className="mb-5 flex max-w-md gap-2">
        <Input aria-label="Booking reference" placeholder="Find by booking reference, e.g. BNB-2611-0001" value={ref} onChange={(e) => setRef(e.target.value)} />
        <Button variant="outline" disabled={!ref.trim()} onClick={() => open('in', undefined, ref)}>Check in</Button>
      </div>
      {q.isLoading && <Skeleton className="h-64" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Expected arrivals ({q.data.arrivals.length})</CardTitle></CardHeader>
            <CardContent>
              {q.data.arrivals.length === 0 ? <EmptyState icon={DoorOpen} title="No arrivals" description={`Nobody is booked to arrive on ${formatDate(date)}.`} /> : (
                <ul className="divide-y">{q.data.arrivals.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                    <div className="min-w-0">
                      <Link to="/admin/bookings/$id" params={{ id: a.id }} className="font-medium text-brand hover:underline">{a.guest ?? a.reference}</Link>
                      <p className="text-xs text-muted-foreground">{a.property} · {a.unit} · {a.guests} guest{a.guests === 1 ? '' : 's'} · until {formatDate(a.check_out)}{a.phone ? ` · ${formatPhoneLocal(a.phone)}` : ''}</p>
                      <p className="mt-1 flex flex-wrap gap-1">
                        {a.status === 'pending' && <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">Awaiting payment</Badge>}
                        {!a.deposit_ok && a.status === 'confirmed' && <Badge className="border-danger/40 bg-danger/10 text-danger">Deposit missing</Badge>}
                        {!a.room_ready && <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">Room not ready</Badge>}
                        {a.balance > 0 && <Badge className="border-border bg-muted text-muted-foreground">Owes {formatKES(a.balance)}</Badge>}
                      </p>
                    </div>
                    <Button size="sm" disabled={a.status !== 'confirmed'} onClick={() => open('in', a.id)}>Check in</Button>
                  </li>))}</ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>In the house ({q.data.in_house.length})</CardTitle></CardHeader>
            <CardContent>
              {q.data.in_house.length === 0 ? <EmptyState icon={DoorClosed} title="Nobody checked in" description="Guests appear here after check-in." /> : (
                <ul className="divide-y">{q.data.in_house.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                    <div className="min-w-0">
                      <Link to="/admin/bookings/$id" params={{ id: h.id }} className="font-medium text-brand hover:underline">{h.guest ?? h.reference}</Link>
                      <p className="text-xs text-muted-foreground">{h.property} · {h.unit} · leaves {formatDate(h.check_out)}</p>
                      <p className="mt-1 flex flex-wrap gap-1">
                        {h.overdue && <Badge className="border-danger/40 bg-danger/10 text-danger">Past check-out</Badge>}
                        {!h.overdue && h.due_out && <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">Leaving today</Badge>}
                        {h.balance > 0 && <Badge className="border-border bg-muted text-muted-foreground">Owes {formatKES(h.balance)}</Badge>}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => open('out', h.id)}>Check out</Button>
                  </li>))}</ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}
      {dialog?.kind === 'in' && <CheckInDialog booking={dialog.booking} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'out' && <CheckOutDialog booking={dialog.booking} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  )
}
