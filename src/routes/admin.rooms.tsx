import { useMemo, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BedDouble, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { errMessage, cn } from '~/lib/utils'
import { formatDate } from '~/lib/dates'
import { Button } from '~/components/ui/button'
import { Dialog, DialogContent } from '~/components/ui/dialog'
import { Field, Input, Select } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton } from '~/components/ui/misc'
import { BookingLink } from '~/components/booking/BookingBits'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/rooms')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: RoomsPage,
})

type RoomStatus = 'available' | 'reserved' | 'occupied' | 'dirty' | 'cleaning' | 'maintenance' | 'out_of_service'
type Room = { unit_id: string; property_id: string; unit_name: string; property_name: string; status: RoomStatus; booking_id: string | null; guest_name: string | null; check_out: string | null; next_check_in: string | null; maintenance_note: string | null }

const META: Record<RoomStatus, { label: string; card: string; dot: string }> = {
  available: { label: 'Available', card: 'border-emerald-600/40 bg-emerald-600/5', dot: 'bg-emerald-600' },
  reserved: { label: 'Reserved', card: 'border-sky-500/40 bg-sky-500/5', dot: 'bg-sky-500' },
  occupied: { label: 'Occupied', card: 'border-brand/50 bg-brand/10', dot: 'bg-brand' },
  dirty: { label: 'Dirty', card: 'border-amber-500/50 bg-amber-500/5', dot: 'bg-amber-500' },
  cleaning: { label: 'Cleaning', card: 'border-orange-500/50 bg-orange-500/5', dot: 'bg-orange-500' },
  maintenance: { label: 'Maintenance', card: 'border-purple-500/50 bg-purple-500/5', dot: 'bg-purple-500' },
  out_of_service: { label: 'Out of service', card: 'border-border bg-muted', dot: 'bg-muted-foreground' },
}
const ORDER: RoomStatus[] = ['available', 'reserved', 'occupied', 'dirty', 'cleaning', 'maintenance', 'out_of_service']
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' })

function RoomsPage() {
  const { scopeIds } = useAdmin()
  const [date, setDate] = useState(today())
  const [filter, setFilter] = useState<'all' | RoomStatus>('all')
  const [editing, setEditing] = useState<Room | null>(null)
  const q = useQuery({
    queryKey: ['room-board', date],
    queryFn: async () => {
      const { data, error } = await sb().rpc('room_board', { p_date: date })
      if (error) throw error
      return data as Room[]
    },
    refetchInterval: 60_000,
  })
  const rooms = useMemo(() => (q.data ?? []).filter((r) => scopeIds.includes(r.property_id)), [q.data, scopeIds])
  const counts = useMemo(() => Object.fromEntries(ORDER.map((s) => [s, rooms.filter((r) => r.status === s).length])) as Record<RoomStatus, number>, [rooms])
  const shown = rooms.filter((r) => filter === 'all' || r.status === filter)
  const byProperty = useMemo(() => {
    const m = new Map<string, Room[]>()
    for (const r of shown) m.set(r.property_name, [...(m.get(r.property_name) ?? []), r])
    return [...m.entries()]
  }, [shown])
  return (
    <div>
      <PageHeader title="Rooms and occupancy" description="Every bookable unit and what state it is in. Cleaning status comes from Housekeeping, occupancy from bookings."
        actions={<div className="flex items-center gap-2"><label htmlFor="rb-date" className="text-sm text-muted-foreground">Day</label><Input id="rb-date" type="date" className="w-40" value={date} onChange={(e) => setDate(e.target.value || today())} /></div>} />
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        <button onClick={() => setFilter('all')} aria-pressed={filter === 'all'} className={cn('h-10 rounded-full border px-4 text-sm', filter === 'all' ? 'bg-foreground text-background' : 'bg-card hover:bg-muted')}>All ({rooms.length})</button>
        {ORDER.map((s) => (
          <button key={s} onClick={() => setFilter(s)} aria-pressed={filter === s} className={cn('inline-flex h-10 items-center gap-2 rounded-full border px-4 text-sm', filter === s ? 'bg-foreground text-background' : 'bg-card hover:bg-muted')}>
            <span aria-hidden className={cn('h-2 w-2 rounded-full', META[s].dot)} /> {META[s].label} ({counts[s]})
          </button>
        ))}
      </div>
      {q.isLoading && <Skeleton className="h-64" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && rooms.length === 0 && <EmptyState icon={BedDouble} title="No rooms yet" description="Add a property with units under Properties and they appear here." />}
      {byProperty.map(([name, list]) => (
        <section key={name} className="mb-6" aria-label={name}>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{name}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((r) => (
              <div key={r.unit_id} className={cn('rounded-xl border p-4', META[r.status].card)}>
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold">{r.unit_name}</p>
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium"><span aria-hidden className={cn('h-2 w-2 rounded-full', META[r.status].dot)} />{META[r.status].label}</span>
                </div>
                <div className="mt-2 min-h-[2.5rem] text-sm text-muted-foreground">
                  {(r.status === 'occupied' || r.status === 'reserved') && <p>{r.guest_name ?? 'Guest'}{r.check_out ? ` · out ${formatDate(r.check_out)}` : ''}</p>}
                  {(r.status === 'maintenance' || r.status === 'out_of_service') && <p>{r.maintenance_note || 'No note'}</p>}
                  {r.status === 'available' && r.next_check_in && <p>Next arrival {formatDate(r.next_check_in)}</p>}
                  {(r.status === 'dirty' || r.status === 'cleaning') && <p>See <Link to="/admin/housekeeping" className="text-brand underline">Housekeeping</Link></p>}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {r.booking_id && <BookingLink id={r.booking_id}>Open booking</BookingLink>}
                  <Button size="sm" variant="ghost" onClick={() => setEditing(r)}><Wrench className="h-4 w-4" aria-hidden /> Room condition</Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {editing && <Condition room={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function Condition({ room, onClose }: { room: Room; onClose: () => void }) {
  const qc = useQueryClient()
  const [status, setStatus] = useState<'ok' | 'maintenance' | 'out_of_service'>(room.status === 'maintenance' ? 'maintenance' : room.status === 'out_of_service' ? 'out_of_service' : 'ok')
  const [note, setNote] = useState(room.maintenance_note ?? '')
  const save = useMutation({
    mutationFn: async () => {
      const { error } = await sb().from('units').update({ maintenance_status: status, maintenance_note: status === 'ok' ? null : note.trim() || null }).eq('id', room.unit_id)
      if (error) throw error
    },
    onSuccess: () => { toast.success('Saved'); qc.invalidateQueries({ queryKey: ['room-board'] }); onClose() },
    onError: (e) => toast.error(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`${room.unit_name}: room condition`} description="Maintenance or out of service stops new bookings for this unit. Existing bookings are not changed.">
        <div className="grid gap-4">
          <Field label="Condition" htmlFor="rc-s"><Select id="rc-s" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="ok">Ready for guests</option><option value="maintenance">Under maintenance</option><option value="out_of_service">Out of service</option></Select></Field>
          {status !== 'ok' && <Field label="Note" htmlFor="rc-n" hint="What is wrong, and when it should be back."><Input id="rc-n" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
          {status !== 'ok' && (room.status === 'occupied' || room.status === 'reserved') && <p role="alert" className="rounded-md bg-amber-500/10 p-3 text-sm">This room has a guest booked. Marking it unavailable does not cancel the booking: sort that out first.</p>}
          <Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
