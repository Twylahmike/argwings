import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Inbox, Mail, MessageCircle, Phone, Search } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { waLink } from '~/lib/brand'
import { errMessage } from '~/lib/utils'
import { formatDate, formatDateTime } from '~/lib/dates'
import { formatPhoneLocal } from '~/lib/phone'
import { INQUIRY_STATUSES, inquiryLabel, type Inquiry, type InquiryNote, type InquiryStatus } from '~/lib/inquiries'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { Field, Input, Select, Textarea } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, Tabs, TableWrap, td, th } from '~/components/ui/misc'
import { BookingLink } from '~/components/booking/BookingBits'

export const Route = createFileRoute('/admin/inquiries')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: InquiriesPage,
})

const TONE: Record<InquiryStatus, string> = {
  new: 'border-brand/50 bg-brand/10 text-brand', contacted: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  awaiting_response: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  converted: 'border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300', closed: 'border-border bg-muted text-muted-foreground',
}
const today = () => new Date().toISOString().slice(0, 10)

function InquiriesPage() {
  const [tab, setTab] = useState<'all' | InquiryStatus>('new')
  const [term, setTerm] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['inquiries'],
    queryFn: async () => {
      const [i, p, s] = await Promise.all([
        sb().from('inquiries').select('*').order('created_at', { ascending: false }).limit(1000),
        sb().from('properties').select('id, name'),
        sb().from('profiles').select('id, full_name, active').eq('active', true),
      ])
      if (i.error) throw i.error
      return {
        rows: i.data as Inquiry[],
        props: new Map((p.data ?? []).map((x) => [x.id as string, x.name as string])),
        staff: (s.data ?? []) as { id: string; full_name: string }[],
      }
    },
  })
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: q.data?.rows.length ?? 0 }
    for (const r of q.data?.rows ?? []) c[r.status] = (c[r.status] ?? 0) + 1
    return c
  }, [q.data])
  const rows = useMemo(() => {
    const t = term.trim().toLowerCase(); const d = t.replace(/\D/g, '')
    return (q.data?.rows ?? []).filter((r) => (tab === 'all' || r.status === tab) &&
      (!t || r.name.toLowerCase().includes(t) || r.message.toLowerCase().includes(t) || (r.email ?? '').toLowerCase().includes(t) || (d.length >= 3 && r.phone.includes(d.replace(/^0/, '254')))))
  }, [q.data, tab, term])
  const open = q.data?.rows.find((r) => r.id === openId)
  const overdue = (r: Inquiry) => r.follow_up_on && r.follow_up_on < today() && r.status !== 'closed' && r.status !== 'converted'
  return (
    <div>
      <PageHeader title="Inquiries" description="Questions from your website. Reply by WhatsApp, phone or email, keep notes, and link a booking when it converts." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs label="Inquiry status" value={tab} onChange={setTab} tabs={[{ value: 'all', label: `All (${counts.all})` }, ...INQUIRY_STATUSES.map((s) => ({ value: s.value, label: `${s.label} (${counts[s.value] ?? 0})` }))]} />
        <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input aria-label="Search inquiries" className="pl-9" placeholder="Search name, phone, message" value={term} onChange={(e) => setTerm(e.target.value)} /></div>
      </div>
      {q.isLoading && <Skeleton className="h-64" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && rows.length === 0 && <EmptyState icon={Inbox} title="No inquiries here" description="New questions from the website contact form appear here." />}
      {rows.length > 0 && (
        <TableWrap>
          <thead><tr>{['Received', 'From', 'Message', 'Property / dates', 'Status', 'Follow-up'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.id} className="cursor-pointer align-top hover:bg-muted/40" onClick={() => setOpenId(r.id)}>
                <td className={`${td} whitespace-nowrap`}>{formatDateTime(r.created_at)}</td>
                <td className={td}><button className="text-left font-medium text-brand hover:underline" onClick={() => setOpenId(r.id)}>{r.name}</button><p className="text-xs text-muted-foreground">{formatPhoneLocal(r.phone)}</p></td>
                <td className={`${td} max-w-sm`}><p className="line-clamp-2 text-muted-foreground">{r.message}</p></td>
                <td className={td}>{r.property_id ? q.data!.props.get(r.property_id) ?? '—' : '—'}{r.check_in && <p className="text-xs text-muted-foreground">{formatDate(r.check_in)}{r.check_out ? ` to ${formatDate(r.check_out)}` : ''}</p>}</td>
                <td className={td}><Badge className={TONE[r.status]}>{inquiryLabel(r.status)}</Badge></td>
                <td className={`${td} whitespace-nowrap ${overdue(r) ? 'font-medium text-danger' : ''}`}>{r.follow_up_on ? formatDate(r.follow_up_on) : '—'}{overdue(r) ? ' (overdue)' : ''}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      {open && q.data && <Detail inquiry={open} staff={q.data.staff} propName={open.property_id ? q.data.props.get(open.property_id) : undefined} onClose={() => setOpenId(null)} />}
    </div>
  )
}

function Detail({ inquiry: r, staff, propName, onClose }: { inquiry: Inquiry; staff: { id: string; full_name: string }[]; propName?: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [ref, setRef] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const linked = useQuery({ queryKey: ['inquiry-booking', r.booking_id], enabled: !!r.booking_id, queryFn: async () => (await sb().from('bookings').select('id, reference').eq('id', r.booking_id!).maybeSingle()).data })
  const notes = useQuery({ queryKey: ['inquiry-notes', r.id], queryFn: async () => {
    const { data, error } = await sb().from('inquiry_notes').select('*').eq('inquiry_id', r.id).order('created_at', { ascending: false })
    if (error) throw error
    return data as InquiryNote[]
  } })
  const update = useMutation({
    mutationFn: async (patch: Partial<Inquiry>) => { const { error } = await sb().from('inquiries').update(patch).eq('id', r.id); if (error) throw error },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['inquiries'] }); toast.success('Saved') },
    onError: (e) => toast.error(errMessage(e)),
  })
  const addNote = useMutation({
    mutationFn: async () => {
      const { data: u } = await sb().auth.getUser()
      const { error } = await sb().from('inquiry_notes').insert({ inquiry_id: r.id, user_id: u.user?.id, body: note.trim() })
      if (error) throw error
    },
    onSuccess: () => { setNote(''); qc.invalidateQueries({ queryKey: ['inquiry-notes', r.id] }) },
    onError: (e) => toast.error(errMessage(e)),
  })
  async function convert() {
    setErr('')
    const { data } = await sb().from('bookings').select('id').ilike('reference', ref.trim()).maybeSingle()
    if (!data) return setErr('No booking with that reference. Create the booking first, then link it here.')
    update.mutate({ booking_id: data.id, status: 'converted' }, { onSuccess: () => setRef('') })
  }
  const wa = waLink(r.phone, `Hi ${r.name.split(' ')[0]}, thanks for your message. `)
  const staffName = (id: string | null) => staff.find((s) => s.id === id)?.full_name
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={r.name} description={`Received ${formatDateTime(r.created_at)} via ${r.source}`}>
        <div className="grid gap-4 text-sm">
          <div className="flex flex-wrap gap-2">
            <a href={wa} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-md border bg-card px-3 hover:bg-muted"><MessageCircle className="h-4 w-4" aria-hidden /> WhatsApp</a>
            <a href={`tel:+${r.phone}`} className="inline-flex h-10 items-center gap-2 rounded-md border bg-card px-3 hover:bg-muted"><Phone className="h-4 w-4" aria-hidden /> {formatPhoneLocal(r.phone)}</a>
            {r.email && <a href={`mailto:${r.email}`} className="inline-flex h-10 items-center gap-2 rounded-md border bg-card px-3 hover:bg-muted"><Mail className="h-4 w-4" aria-hidden /> Email</a>}
          </div>
          <p className="whitespace-pre-line rounded-md bg-muted p-3">{r.message}</p>
          {(propName || r.check_in) && <p className="text-muted-foreground">{propName}{r.check_in ? ` · ${formatDate(r.check_in)}${r.check_out ? ` to ${formatDate(r.check_out)}` : ''}` : ''}{r.guests ? ` · ${r.guests} guest${r.guests === 1 ? '' : 's'}` : ''}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Status" htmlFor="iq-status"><Select id="iq-status" value={r.status} onChange={(e) => {
              const v = e.target.value as InquiryStatus
              if (v === 'converted' && !r.booking_id) return toast.error('Link a booking below to mark this as converted.')
              update.mutate({ status: v })
            }}>{INQUIRY_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select></Field>
            <Field label="Assigned to" htmlFor="iq-assign"><Select id="iq-assign" value={r.assigned_to ?? ''} onChange={(e) => update.mutate({ assigned_to: e.target.value || null })}>
              <option value="">Unassigned</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}</Select></Field>
            <Field label="Follow up on" htmlFor="iq-follow"><Input id="iq-follow" type="date" value={r.follow_up_on ?? ''} onChange={(e) => update.mutate({ follow_up_on: e.target.value || null })} /></Field>
            {r.assigned_to && <p className="self-end pb-2 text-xs text-muted-foreground">Handled by {staffName(r.assigned_to) ?? 'a team member'}</p>}
          </div>
          <div className="rounded-md border p-3">
            <p className="mb-2 font-medium">Linked booking</p>
            {r.booking_id
              ? <p>{linked.data ? <BookingLink id={linked.data.id}>{linked.data.reference}</BookingLink> : 'Loading...'}</p>
              : <div className="grid gap-2"><div className="flex gap-2"><Input aria-label="Booking reference" placeholder="BNB-2611-0001" value={ref} onChange={(e) => setRef(e.target.value)} /><Button variant="outline" disabled={!ref.trim()} loading={update.isPending} onClick={convert}>Link and convert</Button></div>
                {err && <p role="alert" className="text-xs text-danger">{err}</p>}
                <p className="text-xs text-muted-foreground">An inquiry is only marked converted once a real booking is linked.</p></div>}
          </div>
          <div>
            <p className="mb-2 font-medium">Internal notes</p>
            <div className="flex gap-2"><Textarea aria-label="New note" rows={2} placeholder="What was said or agreed" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button variant="outline" disabled={!note.trim()} loading={addNote.isPending} onClick={() => addNote.mutate()}>Add</Button></div>
            <ul className="mt-3 space-y-2">
              {notes.data?.map((n) => <li key={n.id} className="rounded-md bg-muted p-2"><p className="whitespace-pre-line">{n.body}</p><p className="mt-1 text-xs text-muted-foreground">{staffName(n.user_id) ?? 'Team'} · {formatDateTime(n.created_at)}</p></li>)}
              {notes.data?.length === 0 && <li className="text-xs text-muted-foreground">No notes yet.</li>}
            </ul>
          </div>
        </div>
      </SheetContent>
    </Dialog>
  )
}
