import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LifeBuoy, Plus, Search } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { errMessage } from '~/lib/utils'
import { formatDateTime } from '~/lib/dates'
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES, cap, ticketLabel, type Ticket, type TicketMessage, type TicketStatus } from '~/lib/tickets'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { Field, Input, Select, Textarea } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, Tabs, TableWrap, td, th } from '~/components/ui/misc'
import { BookingLink } from '~/components/booking/BookingBits'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/support')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: SupportPage,
})

const PRIORITY_TONE: Record<string, string> = {
  low: 'border-border bg-muted text-muted-foreground', normal: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  high: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300', urgent: 'border-danger/50 bg-danger/10 text-danger',
}

function SupportPage() {
  const { me } = useAdmin()
  const [tab, setTab] = useState<'active' | TicketStatus | 'all'>('active')
  const [term, setTerm] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const q = useQuery({
    queryKey: ['tickets'],
    queryFn: async () => {
      const [t, p, s] = await Promise.all([
        sb().from('support_tickets').select('*').order('created_at', { ascending: false }).limit(1000),
        sb().from('properties').select('id, name'),
        sb().from('profiles').select('id, full_name, active').eq('active', true),
      ])
      if (t.error) throw t.error
      return { rows: t.data as Ticket[], props: new Map((p.data ?? []).map((x) => [x.id as string, x.name as string])), staff: (s.data ?? []) as { id: string; full_name: string }[] }
    },
  })
  const rows = useMemo(() => {
    const t = term.trim().toLowerCase()
    return (q.data?.rows ?? []).filter((r) => (tab === 'all' ? true : tab === 'active' ? !['resolved', 'closed'].includes(r.status) : r.status === tab) &&
      (!t || r.subject.toLowerCase().includes(t) || r.description.toLowerCase().includes(t) || `#${r.ticket_no}` === t || String(r.ticket_no) === t))
  }, [q.data, tab, term])
  const open = q.data?.rows.find((r) => r.id === openId)
  const staffName = (id: string | null) => q.data?.staff.find((s) => s.id === id)?.full_name
  return (
    <div>
      <PageHeader title="Support" description="Track complaints, maintenance issues and guest questions until they are resolved."
        actions={<Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> New ticket</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs label="Ticket status" value={tab} onChange={setTab} tabs={[{ value: 'active', label: 'Active' }, ...TICKET_STATUSES.map((s) => ({ value: s.value, label: s.label })), { value: 'all', label: 'All' }]} />
        <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input aria-label="Search tickets" className="pl-9" placeholder="Search subject or ticket number" value={term} onChange={(e) => setTerm(e.target.value)} /></div>
      </div>
      {q.isLoading && <Skeleton className="h-64" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && rows.length === 0 && <EmptyState icon={LifeBuoy} title="No tickets here" description="Create a ticket when a guest reports a problem or something needs fixing." />}
      {rows.length > 0 && (
        <TableWrap>
          <thead><tr>{['#', 'Subject', 'Category', 'Priority', 'Status', 'Property', 'Assigned', 'Opened'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">{rows.map((r) => (
            <tr key={r.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setOpenId(r.id)}>
              <td className={td}>{r.ticket_no}</td>
              <td className={td}><button className="text-left font-medium text-brand hover:underline" onClick={() => setOpenId(r.id)}>{r.subject}</button></td>
              <td className={td}>{cap(r.category)}</td>
              <td className={td}><Badge className={PRIORITY_TONE[r.priority]}>{cap(r.priority)}</Badge></td>
              <td className={td}>{ticketLabel(r.status)}</td>
              <td className={td}>{r.property_id ? q.data!.props.get(r.property_id) ?? '—' : '—'}</td>
              <td className={td}>{staffName(r.assigned_to) ?? '—'}</td>
              <td className={`${td} whitespace-nowrap`}>{formatDateTime(r.created_at)}</td>
            </tr>))}</tbody>
        </TableWrap>
      )}
      {open && q.data && <Detail ticket={open} staff={q.data.staff} onClose={() => setOpenId(null)} />}
      {creating && q.data && <Create props={me.properties} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id) }} />}
    </div>
  )
}

function Create({ props, onClose, onCreated }: { props: { id: string; name: string }[]; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient()
  const [v, setV] = useState({ subject: '', description: '', category: 'general', priority: 'normal', property_id: '', booking_ref: '' })
  const [err, setErr] = useState('')
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }))
  const save = useMutation({
    mutationFn: async () => {
      setErr('')
      if (v.subject.trim().length < 3) throw new Error('Give the ticket a short subject.')
      let booking_id: string | null = null; let guest_id: string | null = null
      if (v.booking_ref.trim()) {
        const { data } = await sb().from('bookings').select('id, guest_id').ilike('reference', v.booking_ref.trim()).maybeSingle()
        if (!data) throw new Error('No booking with that reference.')
        booking_id = data.id; guest_id = data.guest_id
      }
      const { data: u } = await sb().auth.getUser()
      const { data, error } = await sb().from('support_tickets').insert({
        subject: v.subject.trim(), description: v.description.trim(), category: v.category, priority: v.priority,
        property_id: v.property_id || null, booking_id, guest_id, created_by: u.user?.id,
      }).select('id').single()
      if (error) throw error
      return data.id as string
    },
    onSuccess: (id) => { qc.invalidateQueries({ queryKey: ['tickets'] }); toast.success('Ticket created'); onCreated(id) },
    onError: (e) => setErr(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title="New ticket" description="Describe the problem so anyone on the team can pick it up.">
        <div className="grid gap-4">
          <Field label="Subject" htmlFor="tk-subject"><Input id="tk-subject" value={v.subject} onChange={set('subject')} maxLength={140} /></Field>
          <Field label="Details" htmlFor="tk-desc"><Textarea id="tk-desc" rows={4} value={v.description} onChange={set('description')} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Category" htmlFor="tk-cat"><Select id="tk-cat" value={v.category} onChange={set('category')}>{TICKET_CATEGORIES.map((c) => <option key={c} value={c}>{cap(c)}</option>)}</Select></Field>
            <Field label="Priority" htmlFor="tk-pri"><Select id="tk-pri" value={v.priority} onChange={set('priority')}>{TICKET_PRIORITIES.map((c) => <option key={c} value={c}>{cap(c)}</option>)}</Select></Field>
            <Field label="Property" htmlFor="tk-prop"><Select id="tk-prop" value={v.property_id} onChange={set('property_id')}><option value="">Not specific</option>{props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <Field label="Booking reference (optional)" htmlFor="tk-ref"><Input id="tk-ref" placeholder="BNB-2611-0001" value={v.booking_ref} onChange={set('booking_ref')} /></Field>
          </div>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <Button loading={save.isPending} onClick={() => save.mutate()}>Create ticket</Button>
        </div>
      </SheetContent>
    </Dialog>
  )
}

function Detail({ ticket: t, staff, onClose }: { ticket: Ticket; staff: { id: string; full_name: string }[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const [internal, setInternal] = useState(true)
  const linked = useQuery({ queryKey: ['ticket-booking', t.booking_id], enabled: !!t.booking_id, queryFn: async () => (await sb().from('bookings').select('id, reference').eq('id', t.booking_id!).maybeSingle()).data })
  const msgs = useQuery({ queryKey: ['ticket-messages', t.id], queryFn: async () => {
    const { data, error } = await sb().from('support_ticket_messages').select('*').eq('ticket_id', t.id).order('created_at')
    if (error) throw error
    return data as TicketMessage[]
  } })
  const update = useMutation({
    mutationFn: async (patch: Partial<Ticket>) => { const { error } = await sb().from('support_tickets').update(patch).eq('id', t.id); if (error) throw error },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tickets'] }); toast.success('Saved') },
    onError: (e) => toast.error(errMessage(e)),
  })
  const send = useMutation({
    mutationFn: async () => {
      const { data: u } = await sb().auth.getUser()
      const { error } = await sb().from('support_ticket_messages').insert({ ticket_id: t.id, user_id: u.user?.id, body: body.trim(), internal })
      if (error) throw error
    },
    onSuccess: () => { setBody(''); qc.invalidateQueries({ queryKey: ['ticket-messages', t.id] }) },
    onError: (e) => toast.error(errMessage(e)),
  })
  const who = (id: string) => staff.find((s) => s.id === id)?.full_name ?? 'Team'
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={`#${t.ticket_no} ${t.subject}`} description={`Opened ${formatDateTime(t.created_at)}${t.resolved_at ? ` · resolved ${formatDateTime(t.resolved_at)}` : ''}`}>
        <div className="grid gap-4 text-sm">
          {t.description && <p className="whitespace-pre-line rounded-md bg-muted p-3">{t.description}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Status" htmlFor="tk-status"><Select id="tk-status" value={t.status} onChange={(e) => update.mutate({ status: e.target.value as TicketStatus })}>{TICKET_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select></Field>
            <Field label="Priority" htmlFor="tk-p2"><Select id="tk-p2" value={t.priority} onChange={(e) => update.mutate({ priority: e.target.value as Ticket['priority'] })}>{TICKET_PRIORITIES.map((c) => <option key={c} value={c}>{cap(c)}</option>)}</Select></Field>
            <Field label="Assigned to" htmlFor="tk-assign"><Select id="tk-assign" value={t.assigned_to ?? ''} onChange={(e) => update.mutate({ assigned_to: e.target.value || null })}><option value="">Unassigned</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}</Select></Field>
            {linked.data && <p className="self-end pb-2">Booking: <BookingLink id={linked.data.id}>{linked.data.reference}</BookingLink></p>}
          </div>
          <div>
            <p className="mb-2 font-medium">Conversation</p>
            <Textarea aria-label="Reply or note" rows={2} placeholder="Write an update" value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="mt-2 flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note (staff only)</label>
              <Button variant="outline" disabled={!body.trim()} loading={send.isPending} onClick={() => send.mutate()}>Add</Button>
            </div>
            <ul className="mt-3 space-y-2">
              {msgs.data?.map((m) => <li key={m.id} className="rounded-md bg-muted p-2"><p className="whitespace-pre-line">{m.body}</p><p className="mt-1 text-xs text-muted-foreground">{who(m.user_id)} · {formatDateTime(m.created_at)}{m.internal ? ' · internal' : ''}</p></li>)}
              {msgs.data?.length === 0 && <li className="text-xs text-muted-foreground">No updates yet.</li>}
            </ul>
          </div>
        </div>
      </SheetContent>
    </Dialog>
  )
}
