import { useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowLeft, Download, FileText, Trash2 } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { isOwner, requireRole } from '~/lib/auth'
import { fetchBookings } from '~/lib/bookings-api'
import type { Guest } from '~/lib/types'
import { formatDate, formatDateTime } from '~/lib/dates'
import { formatKES, parseKES } from '~/lib/money'
import { formatPhoneLocal } from '~/lib/phone'
import { errMessage } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { StatusBadge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Field, Input, Textarea } from '~/components/ui/form'
import { ErrorState, Skeleton, TableWrap, td, th } from '~/components/ui/misc'
import { BalanceCell, BookingLink, Money } from '~/components/booking/BookingBits'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/guests/$id')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: GuestPage,
})

function GuestPage() {
  const { id } = Route.useParams()
  const { me, scopeIds } = useAdmin()
  const qc = useQueryClient()
  const nav = useNavigate()
  const guest = useQuery({
    queryKey: ['guest', id],
    queryFn: async () => {
      const { data, error } = await sb().from('guests').select('*').eq('id', id).maybeSingle()
      if (error) throw error
      if (!data) throw new Error('Guest not found, or you do not have access.')
      return data as Guest
    },
  })
  const stays = useQuery({
    queryKey: ['guest-bookings', id, scopeIds],
    queryFn: async () => (await fetchBookings({ propertyIds: scopeIds })).filter((b) => b.guest_id === id),
  })
  const [form, setForm] = useState<{ full_name: string; email: string; id_number: string; notes: string; vip: boolean; flagged: boolean; flag_reason: string; comms_opt_out: boolean } | null>(null)
  const g = guest.data
  const f = form ?? (g ? { full_name: g.full_name, email: g.email ?? '', id_number: g.id_number ?? '', notes: g.notes ?? '', vip: g.vip, flagged: g.flagged, flag_reason: g.flag_reason ?? '', comms_opt_out: g.comms_opt_out } : null)

  const save = useMutation({
    mutationFn: async () => {
      if (f!.flagged && f!.flag_reason.trim().length < 3) throw new Error('Add a short reason for the flag.')
      const { error } = await sb().from('guests').update({ full_name: f!.full_name.trim(), email: f!.email.trim() || null, id_number: f!.id_number.trim() || null, notes: f!.notes.trim() || null, vip: f!.vip, flagged: f!.flagged, flag_reason: f!.flagged ? f!.flag_reason.trim() : null, comms_opt_out: f!.comms_opt_out }).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => { toast.success('Saved'); setForm(null); qc.invalidateQueries({ queryKey: ['guest', id] }); qc.invalidateQueries({ queryKey: ['guests'] }) },
    onError: (e) => toast.error(errMessage(e)),
  })

  async function exportData() {
    const { data, error } = await sb().rpc('export_guest_data', { p_guest: id })
    if (error) return toast.error(errMessage(error))
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = `guest-${id.slice(0, 8)}.json`; a.click(); URL.revokeObjectURL(url)
  }
  async function erase() {
    if (!confirm('Delete this guest\'s personal data? Name, phone, email, ID and notes are anonymised. Bookings and payment records are kept. This cannot be undone.')) return
    const { error } = await sb().rpc('anonymise_guest', { p_guest: id })
    if (error) return toast.error(errMessage(error))
    toast.success('Guest data deleted'); qc.invalidateQueries({ queryKey: ['guests'] }); nav({ to: '/admin/guests' })
  }

  if (guest.isLoading) return <Skeleton className="h-96" />
  if (guest.error) return <ErrorState error={guest.error} retry={() => guest.refetch()} />
  const owing = (stays.data ?? []).filter((b) => ['confirmed', 'checked_in', 'checked_out', 'pending'].includes(b.status)).reduce((s, b) => s + Math.max(0, b.total_amount - b.amount_paid), 0)

  return (
    <div className="max-w-5xl">
      <Link to="/admin/guests" className="mb-3 inline-flex h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Guests</Link>
      <h1 className="mb-1 text-xl font-semibold md:text-2xl">{g!.full_name}</h1>
      <p className="mb-4 text-sm text-muted-foreground">{formatPhoneLocal(g!.phone)} · Outstanding balances: <b><Money value={owing} /></b></p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Details</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <Field label="Name" htmlFor="g-name"><Input id="g-name" value={f!.full_name} onChange={(e) => setForm({ ...f!, full_name: e.target.value })} /></Field>
            <Field label="Email" htmlFor="g-email"><Input id="g-email" type="email" value={f!.email} onChange={(e) => setForm({ ...f!, email: e.target.value })} /></Field>
            <Field label="ID / passport number" htmlFor="g-id" hint="Optional. Only owners and managers can see this."><Input id="g-id" value={f!.id_number} onChange={(e) => setForm({ ...f!, id_number: e.target.value })} /></Field>
            <Field label="Staff notes" htmlFor="g-notes" hint="Never shown to the guest."><Textarea id="g-notes" rows={4} value={f!.notes} onChange={(e) => setForm({ ...f!, notes: e.target.value })} /></Field>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={f!.vip} onChange={(e) => setForm({ ...f!, vip: e.target.checked })} /> VIP guest</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={f!.flagged} onChange={(e) => setForm({ ...f!, flagged: e.target.checked })} /> Flag (think twice before hosting again)</label>
            </div>
            <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={f!.comms_opt_out} onChange={(e) => setForm({ ...f!, comms_opt_out: e.target.checked })} /> Do not send reminders or thank-you messages (confirmations and receipts are still sent)</label>
            {f!.flagged && <Field label="Reason for the flag" htmlFor="g-flag" hint="Staff only. Required."><Input id="g-flag" maxLength={300} value={f!.flag_reason} onChange={(e) => setForm({ ...f!, flag_reason: e.target.value })} /></Field>}
            <div className="flex flex-wrap gap-2">
              <Button disabled={!form || !f!.full_name.trim()} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
              <Button variant="outline" asChild><Link to="/admin/statement/$id" params={{ id }}><FileText className="h-4 w-4" /> Statement</Link></Button>
              <Button variant="outline" onClick={exportData}><Download className="h-4 w-4" /> Export their data</Button>
              {isOwner(me) && <Button variant="outline" className="text-danger" onClick={erase}><Trash2 className="h-4 w-4" /> Delete their data</Button>}
            </div>
          </CardContent>
        </Card>
        <CreditCard guestId={id} owner={isOwner(me)} />
        <Card>
          <CardHeader><CardTitle>Stay history</CardTitle></CardHeader>
          <CardContent>
            {stays.isLoading && <Skeleton className="h-24" />}
            {stays.data?.length === 0 && <p className="text-sm text-muted-foreground">No stays yet.</p>}
            {!!stays.data?.length && (
              <TableWrap>
                <thead><tr>{['Ref', 'Dates', 'Status', 'Balance'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
                <tbody className="divide-y">{stays.data.map((b) => (
                  <tr key={b.id}><td className={td}><BookingLink id={b.id}>{b.reference.slice(-9)}</BookingLink><p className="text-xs text-muted-foreground">{b.property.name}</p></td>
                    <td className={td}>{formatDate(b.check_in)}<br /><span className="text-muted-foreground">{b.nights} nights</span></td><td className={td}><StatusBadge status={b.status} /></td><td className={td}><BalanceCell b={b} /></td></tr>))}</tbody>
              </TableWrap>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

type CreditEntry = { id: string; amount: number; kind: string; reason: string; created_at: string }
const KIND_LABEL: Record<string, string> = { credit_added: 'Credit added', credit_used: 'Used on a booking', adjustment: 'Correction' }

function CreditCard({ guestId, owner }: { guestId: string; owner: boolean }) {
  const qc = useQueryClient()
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const q = useQuery({ queryKey: ['guest-credit-ledger', guestId], queryFn: async () => {
    const { data, error } = await sb().from('guest_credit_entries').select('id, amount, kind, reason, created_at').eq('guest_id', guestId).order('created_at', { ascending: false })
    if (error) throw error
    return data as CreditEntry[]
  } })
  const balance = (q.data ?? []).reduce((s, e) => s + e.amount, 0)
  const run = useMutation({
    mutationFn: async (fn: 'add_guest_credit' | 'adjust_guest_credit') => {
      setErr('')
      const n = parseKES(amount.replace(/^-/, ''))
      if (!n) throw new Error('Enter an amount in shillings.')
      const signed = fn === 'adjust_guest_credit' && amount.trim().startsWith('-') ? -n : n
      const { error } = await sb().rpc(fn, { p_guest: guestId, p_amount: signed, p_reason: reason })
      if (error) throw error
    },
    onSuccess: () => { setAmount(''); setReason(''); toast.success('Credit updated'); qc.invalidateQueries({ queryKey: ['guest-credit-ledger', guestId] }); qc.invalidateQueries({ queryKey: ['guest-credit', guestId] }) },
    onError: (e) => setErr(errMessage(e)),
  })
  return (
    <Card>
      <CardHeader><CardTitle>Guest credit: {formatKES(balance)}</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-xs text-muted-foreground">Credit is money you owe the guest, for example a refund held for their next stay. Use it from a booking's Payments section. Entries cannot be edited or deleted.</p>
        <div className="grid gap-2 sm:grid-cols-[8rem_1fr]">
          <Input aria-label="Credit amount" inputMode="numeric" placeholder={owner ? 'KES (or -KES)' : 'KES'} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Input aria-label="Reason" placeholder="Reason, e.g. refund held as credit" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!amount.trim() || reason.trim().length < 3} loading={run.isPending} onClick={() => run.mutate('add_guest_credit')}>Add credit</Button>
          {owner && <Button variant="ghost" disabled={!amount.trim() || reason.trim().length < 3} onClick={() => run.mutate('adjust_guest_credit')}>Owner correction</Button>}
        </div>
        <ul className="divide-y text-sm">
          {q.data?.map((e) => (
            <li key={e.id} className="flex items-start justify-between gap-3 py-2">
              <div><p>{KIND_LABEL[e.kind] ?? e.kind}: {e.reason}</p><p className="text-xs text-muted-foreground">{formatDateTime(e.created_at)}</p></div>
              <span className={e.amount < 0 ? 'text-danger' : 'text-emerald-700 dark:text-emerald-400'}>{e.amount < 0 ? '-' : '+'}{formatKES(Math.abs(e.amount))}</span>
            </li>))}
          {q.data?.length === 0 && <li className="py-2 text-muted-foreground">No credit entries.</li>}
        </ul>
      </CardContent>
    </Card>
  )
}
