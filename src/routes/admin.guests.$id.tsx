import { useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowLeft, Download, Trash2 } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { isOwner, requireRole } from '~/lib/auth'
import { fetchBookings } from '~/lib/bookings-api'
import type { Guest } from '~/lib/types'
import { formatDate } from '~/lib/dates'
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
  const [form, setForm] = useState<{ full_name: string; email: string; id_number: string; notes: string } | null>(null)
  const g = guest.data
  const f = form ?? (g ? { full_name: g.full_name, email: g.email ?? '', id_number: g.id_number ?? '', notes: g.notes ?? '' } : null)

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await sb().from('guests').update({ full_name: f!.full_name.trim(), email: f!.email.trim() || null, id_number: f!.id_number.trim() || null, notes: f!.notes.trim() || null }).eq('id', id)
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
            <div className="flex flex-wrap gap-2">
              <Button disabled={!form || !f!.full_name.trim()} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
              <Button variant="outline" onClick={exportData}><Download className="h-4 w-4" /> Export their data</Button>
              {isOwner(me) && <Button variant="outline" className="text-danger" onClick={erase}><Trash2 className="h-4 w-4" /> Delete their data</Button>}
            </div>
          </CardContent>
        </Card>
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
