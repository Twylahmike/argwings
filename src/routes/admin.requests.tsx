import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarCheck, Mail, MessageCircle, Phone } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { waLink } from '~/lib/brand'
import { errMessage, isDatesTaken, DATES_TAKEN_MESSAGE } from '~/lib/utils'
import { formatDate, formatDateTime } from '~/lib/dates'
import { formatPhoneLocal } from '~/lib/phone'
import { REQUEST_LABEL, type BookingRequest, type RequestStatus } from '~/lib/requests'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { Field, Input, Textarea } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, Tabs, TableWrap, td, th } from '~/components/ui/misc'
import { BookingLink } from '~/components/booking/BookingBits'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/requests')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: RequestsPage,
})

const TONE: Record<RequestStatus, string> = {
  new: 'border-brand/50 bg-brand/10 text-brand', approved: 'border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300',
  alternative_offered: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300', rejected: 'text-muted-foreground', expired: 'text-muted-foreground', withdrawn: 'text-muted-foreground',
}
type View = 'open' | 'approved' | 'closed' | 'all'
const isOpen = (s: RequestStatus) => s === 'new' || s === 'alternative_offered'
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' })

function RequestsPage() {
  const { scopeIds } = useAdmin()
  const [view, setView] = useState<View>('open')
  const [openId, setOpenId] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['requests', scopeIds],
    queryFn: async () => {
      const [r, u, p] = await Promise.all([
        sb().from('booking_requests').select('*').in('property_id', scopeIds).order('created_at', { ascending: false }).limit(500),
        sb().from('units').select('id, name, property_id'), sb().from('properties').select('id, name'),
      ])
      if (r.error) throw r.error
      return {
        rows: r.data as BookingRequest[],
        units: new Map((u.data ?? []).map((x) => [x.id as string, x.name as string])),
        props: new Map((p.data ?? []).map((x) => [x.id as string, x.name as string])),
      }
    },
  })
  const rows = useMemo(() => (q.data?.rows ?? []).filter((r) => view === 'all' || (view === 'open' ? isOpen(r.status) : view === 'approved' ? r.status === 'approved' : !isOpen(r.status) && r.status !== 'approved')), [q.data, view])
  const count = (f: (r: BookingRequest) => boolean) => q.data?.rows.filter(f).length ?? 0
  const open = q.data?.rows.find((r) => r.id === openId)
  return (
    <div>
      <PageHeader title="Booking requests" description="Guests ask for dates; you approve, decline or offer other dates. Approving creates a booking held for payment." />
      <div className="mb-4"><Tabs label="Request status" value={view} onChange={setView} tabs={[
        { value: 'open', label: `Needs action (${count((r) => isOpen(r.status))})` }, { value: 'approved', label: `Approved (${count((r) => r.status === 'approved')})` },
        { value: 'closed', label: `Closed (${count((r) => !isOpen(r.status) && r.status !== 'approved')})` }, { value: 'all', label: 'All' }]} /></div>
      {q.isLoading && <Skeleton className="h-56" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && rows.length === 0 && <EmptyState icon={CalendarCheck} title="No requests here" description="When your booking mode is set to 'Request first' (Settings), guests' requests appear here." />}
      {rows.length > 0 && (
        <TableWrap>
          <thead><tr>{['Received', 'Guest', 'Place', 'Dates', 'Guests', 'Status'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">{rows.map((r) => (
            <tr key={r.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setOpenId(r.id)}>
              <td className={`${td} whitespace-nowrap`}>{formatDateTime(r.created_at)}</td>
              <td className={td}><button className="text-left font-medium text-brand hover:underline" onClick={() => setOpenId(r.id)}>{r.name}</button><p className="text-xs text-muted-foreground">{formatPhoneLocal(r.phone)}</p></td>
              <td className={td}>{q.data!.props.get(r.property_id)}<p className="text-xs text-muted-foreground">{q.data!.units.get(r.unit_id)}</p></td>
              <td className={`${td} whitespace-nowrap`}>{formatDate(r.check_in)} to {formatDate(r.check_out)}{r.alt_check_in && <p className="text-xs text-sky-700 dark:text-sky-300">Offered {formatDate(r.alt_check_in)} to {formatDate(r.alt_check_out)}</p>}</td>
              <td className={td}>{r.guests}</td>
              <td className={td}><Badge className={TONE[r.status]}>{REQUEST_LABEL[r.status]}</Badge></td>
            </tr>))}</tbody>
        </TableWrap>
      )}
      {open && q.data && <Detail r={open} place={`${q.data.props.get(open.property_id) ?? ''} · ${q.data.units.get(open.unit_id) ?? ''}`} onClose={() => setOpenId(null)} />}
    </div>
  )
}

function Detail({ r, place, onClose }: { r: BookingRequest; place: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [mode, setMode] = useState<null | 'approve' | 'reject' | 'alt'>(null)
  const [note, setNote] = useState('')
  const [altIn, setAltIn] = useState('')
  const [altOut, setAltOut] = useState('')
  const [err, setErr] = useState('')
  const [newNote, setNewNote] = useState('')
  const notes = useQuery({ queryKey: ['request-notes', r.id], queryFn: async () => {
    const { data, error } = await sb().from('booking_request_notes').select('id, body, created_at').eq('request_id', r.id).order('created_at', { ascending: false })
    if (error) throw error
    return data as { id: string; body: string; created_at: string }[]
  } })
  const booking = useQuery({ queryKey: ['request-booking', r.booking_id], enabled: !!r.booking_id, queryFn: async () => (await sb().from('bookings').select('id, reference').eq('id', r.booking_id!).maybeSingle()).data })
  const done = () => { qc.invalidateQueries({ queryKey: ['requests'] }); qc.invalidateQueries({ queryKey: ['notif-count'] }); setMode(null); setNote(''); setErr('') }
  const approve = useMutation({
    mutationFn: async () => { const { error } = await sb().rpc('approve_booking_request', { p_request: r.id, p_note: note || null }); if (error) throw error },
    onSuccess: () => { toast.success('Approved. A booking is now held for the guest to pay.'); done() },
    onError: (e) => setErr(isDatesTaken(e) ? DATES_TAKEN_MESSAGE : errMessage(e)),
  })
  const reject = useMutation({
    mutationFn: async () => { const { error } = await sb().rpc('reject_booking_request', { p_request: r.id, p_note: note || null }); if (error) throw error },
    onSuccess: () => { toast.success('Request declined'); done() }, onError: (e) => setErr(errMessage(e)),
  })
  const offer = useMutation({
    mutationFn: async () => { const { error } = await sb().rpc('offer_alternative_dates', { p_request: r.id, p_in: altIn, p_out: altOut, p_note: note || null }); if (error) throw error },
    onSuccess: () => { toast.success('Other dates offered'); done() }, onError: (e) => setErr(errMessage(e)),
  })
  const addNote = useMutation({
    mutationFn: async () => { const { data: u } = await sb().auth.getUser(); const { error } = await sb().from('booking_request_notes').insert({ request_id: r.id, user_id: u.user?.id, body: newNote.trim() }); if (error) throw error },
    onSuccess: () => { setNewNote(''); qc.invalidateQueries({ queryKey: ['request-notes', r.id] }) }, onError: (e) => toast.error(errMessage(e)),
  })
  const trackUrl = `${window.location.origin}/request/${r.public_token}`
  const wa = waLink(r.phone, `Hi ${r.name.split(' ')[0]}, about your booking request for ${formatDate(r.check_in)} to ${formatDate(r.check_out)}. Details here: ${trackUrl}`)
  const busy = approve.isPending || reject.isPending || offer.isPending
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={r.name} description={`${place} · received ${formatDateTime(r.created_at)}`}>
        <div className="grid gap-4 text-sm">
          <div className="flex flex-wrap gap-2">
            <a href={wa} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-md border bg-card px-3 hover:bg-muted"><MessageCircle className="h-4 w-4" aria-hidden /> WhatsApp</a>
            <a href={`tel:+${r.phone}`} className="inline-flex h-10 items-center gap-2 rounded-md border bg-card px-3 hover:bg-muted"><Phone className="h-4 w-4" aria-hidden /> {formatPhoneLocal(r.phone)}</a>
            {r.email && <a href={`mailto:${r.email}`} className="inline-flex h-10 items-center gap-2 rounded-md border bg-card px-3 hover:bg-muted"><Mail className="h-4 w-4" aria-hidden /> Email</a>}
          </div>
          <div className="rounded-md bg-muted p-3">
            <p className="font-medium">{formatDate(r.check_in)} to {formatDate(r.check_out)} · {r.guests} guest{r.guests === 1 ? '' : 's'}</p>
            {r.message && <p className="mt-1 whitespace-pre-line text-muted-foreground">{r.message}</p>}
          </div>
          <p><Badge className={TONE[r.status]}>{REQUEST_LABEL[r.status]}</Badge>{r.decided_at && <span className="ml-2 text-xs text-muted-foreground">{formatDateTime(r.decided_at)}</span>}</p>
          {r.decision_note && <p className="text-muted-foreground">Note to guest: {r.decision_note}</p>}
          {r.alt_check_in && <p>Offered: <b>{formatDate(r.alt_check_in)} to {formatDate(r.alt_check_out)}</b>. Waiting for the guest to accept.</p>}
          {r.booking_id && <p>Booking: {booking.data ? <BookingLink id={booking.data.id}>{booking.data.reference}</BookingLink> : '...'}</p>}
          {isOpen(r.status) && mode === null && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setMode('approve')}>Approve</Button>
              <Button variant="outline" onClick={() => { setMode('alt'); setAltIn(r.check_in > today() ? r.check_in : today()) }}>Offer other dates</Button>
              <Button variant="outline" className="text-danger" onClick={() => setMode('reject')}>Decline</Button>
            </div>
          )}
          {mode && (
            <div className="grid gap-3 rounded-md border p-3">
              {mode === 'approve' && <p>This creates a booking for {formatDate(r.check_in)} to {formatDate(r.check_out)}, held so the guest can pay the deposit from their link. If the dates were taken meanwhile it will say so.</p>}
              {mode === 'reject' && <p>The guest will see that you cannot offer these dates.</p>}
              {mode === 'alt' && <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Check-in" htmlFor="ra-in"><Input id="ra-in" type="date" min={today()} value={altIn} onChange={(e) => setAltIn(e.target.value)} /></Field>
                <Field label="Check-out" htmlFor="ra-out"><Input id="ra-out" type="date" min={altIn || today()} value={altOut} onChange={(e) => setAltOut(e.target.value)} /></Field></div>}
              <Field label="Note to the guest (optional)" htmlFor="ra-note"><Textarea id="ra-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              {err && <p role="alert" className="text-sm text-danger">{err}</p>}
              <div className="flex gap-2">
                <Button loading={busy} disabled={mode === 'alt' && (!altIn || !altOut)} variant={mode === 'reject' ? 'danger' : 'default'}
                  onClick={() => { setErr(''); (mode === 'approve' ? approve : mode === 'reject' ? reject : offer).mutate() }}>
                  {mode === 'approve' ? 'Confirm approval' : mode === 'reject' ? 'Confirm decline' : 'Send offer'}</Button>
                <Button variant="ghost" onClick={() => { setMode(null); setErr('') }}>Back</Button>
              </div>
            </div>
          )}
          <div>
            <p className="mb-2 font-medium">Notes and communication</p>
            <div className="flex gap-2"><Textarea aria-label="New note" rows={2} placeholder="What was said or agreed" value={newNote} onChange={(e) => setNewNote(e.target.value)} />
              <Button variant="outline" disabled={!newNote.trim()} loading={addNote.isPending} onClick={() => addNote.mutate()}>Add</Button></div>
            <ul className="mt-3 space-y-2">{notes.data?.map((n) => <li key={n.id} className="rounded-md bg-muted p-2"><p className="whitespace-pre-line">{n.body}</p><p className="mt-1 text-xs text-muted-foreground">{formatDateTime(n.created_at)}</p></li>)}
              {notes.data?.length === 0 && <li className="text-xs text-muted-foreground">No notes yet.</li>}</ul>
          </div>
          <p className="text-xs text-muted-foreground">Guest tracking link: <span className="break-all">{trackUrl}</span></p>
        </div>
      </SheetContent>
    </Dialog>
  )
}
