import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CalendarDays, ChevronLeft, ChevronRight, ExternalLink, MessageCircle, Phone } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { addDays, formatDate, todayNairobi } from '~/lib/dates'
import { formatPhoneLocal } from '~/lib/phone'
import { formatKES } from '~/lib/money'
import { waLink } from '~/lib/brand'
import { DATES_TAKEN_MESSAGE, errMessage, isDatesTaken } from '~/lib/utils'
import { BOOKING_SELECT, balance, nextActions, type BookingRow } from '~/lib/bookings-api'
import { selectionRange } from '~/lib/calendar'
import type { BookingStatus } from '~/lib/types'
import { Button } from '~/components/ui/button'
import { StatusBadge } from '~/components/ui/badge'
import { Field, Input } from '~/components/ui/form'
import { Dialog, DialogContent, SheetContent } from '~/components/ui/dialog'
import { ErrorState, PageHeader, Skeleton, Tabs } from '~/components/ui/misc'
import { Timeline, type TimelineBooking } from '~/components/calendar/Timeline'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/calendar')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: CalendarPage,
})

const SHOWN: BookingStatus[] = ['pending', 'confirmed', 'checked_in', 'checked_out', 'blocked']

function CalendarPage() {
  const { me, scopeIds } = useAdmin()
  const nav = useNavigate()
  const qc = useQueryClient()
  const today = todayNairobi()
  const [view, setView] = useState<'14' | '30'>('14')
  const days = Number(view)
  const [start, setStart] = useState(addDays(today, -2))
  const end = addDays(start, days)
  const [selection, setSelection] = useState<{ unitId: string; from: string; to: string } | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  const units = useQuery({
    queryKey: ['cal-units', scopeIds],
    queryFn: async () => {
      const { data, error } = await sb().from('units').select('id, name, code, property_id, active').in('property_id', scopeIds).eq('active', true).order('sort').order('name')
      if (error) throw error
      return data as { id: string; name: string; code: string | null; property_id: string }[]
    },
  })
  const data = useQuery({
    queryKey: ['cal-bookings', scopeIds, start, days],
    queryFn: async () => {
      const [b, t] = await Promise.all([
        sb().from('bookings').select(BOOKING_SELECT).in('property_id', scopeIds).in('status', SHOWN).lt('check_in', end).gt('check_out', start).limit(2000),
        sb().from('housekeeping_tasks').select('unit_id, priority, status').in('property_id', scopeIds).in('status', ['dirty', 'in_progress']),
      ])
      if (b.error) throw b.error
      if (t.error) throw t.error
      return { bookings: b.data as unknown as BookingRow[], tasks: t.data as { unit_id: string; priority: boolean }[] }
    },
  })

  // Live: any change to bookings / tasks refreshes the grid.
  useEffect(() => {
    const ch = sb().channel('calendar')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, () => qc.invalidateQueries({ queryKey: ['cal-bookings'] }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'housekeeping_tasks' }, () => qc.invalidateQueries({ queryKey: ['cal-bookings'] }))
      .subscribe()
    return () => { sb().removeChannel(ch) }
  }, [qc])

  const bars: TimelineBooking[] = useMemo(() => (data.data?.bookings ?? []).map((b) => ({
    id: b.id, unit_id: b.unit_id, check_in: b.check_in, check_out: b.check_out, status: b.status,
    guestName: b.guest?.full_name ?? null, reference: b.reference, balance: balance(b), payment_review: b.payment_review,
  })), [data.data])
  const cleaning = useMemo(() => {
    const m = new Map<string, { priority: boolean }>()
    for (const t of data.data?.tasks ?? []) m.set(t.unit_id, { priority: (m.get(t.unit_id)?.priority ?? false) || t.priority })
    return m
  }, [data.data])
  const properties = me.properties.filter((p) => scopeIds.includes(p.id))
  const open = data.data?.bookings.find((b) => b.id === openId)
  const label = `${formatDate(start)} to ${formatDate(addDays(end, -1))}`

  return (
    <div>
      <PageHeader title="Calendar" description="Every unit in one view. Each column is a night. Drag across free nights (or tap a start night, then an end night) to book or block them."
        actions={<Button asChild><Link to="/admin/bookings/new">New booking</Link></Button>} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" aria-label="Previous" onClick={() => setStart(addDays(start, -days))}><ChevronLeft className="h-5 w-5" /></Button>
          <Button variant="outline" onClick={() => setStart(addDays(today, -2))}><CalendarDays className="h-4 w-4" /> Today</Button>
          <Button variant="outline" size="icon" aria-label="Next" onClick={() => setStart(addDays(start, days))}><ChevronRight className="h-5 w-5" /></Button>
          <span className="ml-2 hidden text-sm text-muted-foreground md:inline">{label}</span>
        </div>
        <Tabs label="View length" value={view} onChange={setView} tabs={[{ value: '14', label: '14 days' }, { value: '30', label: '30 days' }]} />
      </div>
      <Legend />
      {(units.isLoading || data.isLoading) && <Skeleton className="h-80" />}
      {(units.error || data.error) && <ErrorState error={units.error ?? data.error} retry={() => { units.refetch(); data.refetch() }} />}
      {units.data && data.data && (
        <Timeline start={start} days={days} properties={properties} units={units.data} bookings={bars} cleaning={cleaning}
          onSelectRange={(unitId, from, to) => setSelection({ unitId, from, to })} onOpenBooking={setOpenId} />
      )}

      {selection && units.data && (
        <SelectionSheet selection={selection} unit={units.data.find((u) => u.id === selection.unitId)} onClose={() => setSelection(null)}
          onBook={() => { const u = units.data.find((x) => x.id === selection.unitId); nav({ to: '/admin/bookings/new', search: { unit: selection.unitId, in: selection.from, out: selection.to, property: u?.property_id } }) }}
          onBlocked={() => { setSelection(null); qc.invalidateQueries({ queryKey: ['cal-bookings'] }) }} />
      )}
      {open && <BookingDrawer b={open} onClose={() => setOpenId(null)} onChanged={() => { qc.invalidateQueries({ queryKey: ['cal-bookings'] }); qc.invalidateQueries({ queryKey: ['bookings'] }) }} />}
    </div>
  )
}

function Legend() {
  const items: [BookingStatus, string][] = [['pending', 'Pending'], ['confirmed', 'Confirmed'], ['checked_in', 'Checked in'], ['checked_out', 'Checked out'], ['blocked', 'Blocked']]
  return (
    <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
      {items.map(([s, l]) => <li key={s} className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm" style={{ background: `hsl(var(--st-${s}))` }} /> {l}</li>)}
      <li className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm border-2" style={{ borderColor: 'hsl(var(--st-pending))' }} /> Needs cleaning</li>
      <li className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm outline outline-2" style={{ outlineColor: 'hsl(var(--danger))' }} /> Payment needs review</li>
    </ul>
  )
}

function SelectionSheet({ selection, unit, onClose, onBook, onBlocked }: {
  selection: { unitId: string; from: string; to: string }; unit?: { name: string }; onClose: () => void; onBook: () => void; onBlocked: () => void
}) {
  const [note, setNote] = useState('')
  const nights = selectionRange(selection.from, addDays(selection.to, -1)).nights
  const block = useMutation({
    mutationFn: async () => { const { error } = await sb().rpc('staff_block_dates', { p_unit: selection.unitId, p_in: selection.from, p_out: selection.to, p_notes: note.trim() || null }); if (error) throw error },
    onSuccess: () => { toast.success('Dates blocked'); onBlocked() },
    onError: (e) => toast.error(isDatesTaken(e) ? DATES_TAKEN_MESSAGE : errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={unit?.name ?? 'Selected dates'} description={`${formatDate(selection.from)} to ${formatDate(selection.to)} · ${nights} night${nights > 1 ? 's' : ''}`}>
        <div className="grid gap-4">
          <Button size="lg" onClick={onBook}>New booking for these dates</Button>
          <div className="grid gap-2 border-t pt-4">
            <Field label="Or block them (maintenance, personal use)" htmlFor="blk-note"><Input id="blk-note" placeholder="Reason (optional)" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            <Button variant="outline" loading={block.isPending} onClick={() => block.mutate()}>Block these dates</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function BookingDrawer({ b, onClose, onChanged }: { b: BookingRow; onClose: () => void; onChanged: () => void }) {
  const [reason, setReason] = useState('')
  const [asking, setAsking] = useState<BookingStatus | null>(null)
  const act = useMutation({
    mutationFn: async (v: { to: BookingStatus; reason?: string }) => {
      const { error } = await sb().from('bookings').update({ status: v.to, ...(v.reason ? { cancel_reason: v.reason } : {}) }).eq('id', b.id)
      if (error) throw error
    },
    onSuccess: () => { toast.success('Updated'); onChanged(); onClose() },
    onError: (e) => toast.error(errMessage(e)),
  })
  const actions = nextActions(b.status)
  const bal = balance(b)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={b.guest?.full_name ?? 'Blocked dates'} description={b.reference}>
        <div className="grid gap-4">
          <div className="flex items-center gap-2"><StatusBadge status={b.status} /><span className="text-sm text-muted-foreground">{b.property.name} · {b.unit.name}</span></div>
          <p className="text-sm">{formatDate(b.check_in)} to {formatDate(b.check_out)} · {b.nights} night{b.nights > 1 ? 's' : ''}</p>
          {b.status !== 'blocked' && (
            <p className="text-sm">Total {formatKES(b.total_amount)} · Paid {formatKES(b.amount_paid)} · <b className={bal > 0 ? 'text-amber-700 dark:text-amber-400' : ''}>Balance {formatKES(bal)}</b></p>
          )}
          {b.notes && <p className="rounded-md bg-muted p-3 text-sm">{b.notes}</p>}
          {b.guest && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild><a href={`tel:+${b.guest.phone}`}><Phone className="h-4 w-4" /> {formatPhoneLocal(b.guest.phone)}</a></Button>
              <Button variant="outline" size="sm" asChild><a href={waLink(b.guest.phone)} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4" /> WhatsApp</a></Button>
            </div>
          )}
          {asking ? (
            <div className="grid gap-2">
              <Field label="Reason" htmlFor="dr-reason"><Input id="dr-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <div className="flex gap-2"><Button variant="danger" disabled={!reason.trim()} loading={act.isPending} onClick={() => act.mutate({ to: asking, reason: reason.trim() })}>Confirm</Button><Button variant="ghost" onClick={() => setAsking(null)}>Back</Button></div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {actions.map((a) => <Button key={a.to} variant={a.variant} loading={act.isPending && act.variables?.to === a.to} onClick={() => (a.needsReason ? setAsking(a.to) : act.mutate({ to: a.to }))}>{a.label}</Button>)}
            </div>
          )}
          {b.status !== 'blocked' && <Button variant="ghost" asChild><Link to="/admin/bookings/$id" params={{ id: b.id }}><ExternalLink className="h-4 w-4" /> Open full booking</Link></Button>}
        </div>
      </SheetContent>
    </Dialog>
  )
}
