import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Phone, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { isOwner, requireRole } from '~/lib/auth'
import { errMessage } from '~/lib/utils'
import { formatPhoneLocal, normalizePhone } from '~/lib/phone'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { Field, Input, Select } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, TableWrap, td, th } from '~/components/ui/misc'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/contacts')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: ContactsPage,
})

type Contact = { id: string; label: string; kind: string; phone: string; note: string | null; show_on_website: boolean; active: boolean; sort: number }
const KINDS: [string, string][] = [['reception', 'Reception'], ['reservations', 'Reservations'], ['whatsapp', 'WhatsApp'], ['emergency', 'Emergency'], ['management', 'Management'], ['other', 'Other']]

function ContactsPage() {
  const { me } = useAdmin()
  const owner = isOwner(me)
  const [editing, setEditing] = useState<Contact | 'new' | null>(null)
  const q = useQuery({ queryKey: ['contacts'], queryFn: async () => {
    const { data, error } = await sb().from('contact_numbers').select('*').order('sort').order('label')
    if (error) throw error
    return data as Contact[]
  } })
  return (
    <div>
      <PageHeader title="Contact numbers" description="The numbers your team and guests use. Tick “Show on website” to publish one. Emergency and management numbers are never published."
        actions={owner ? <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden /> Add number</Button> : undefined} />
      {q.isLoading && <Skeleton className="h-40" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data?.length === 0 && <EmptyState icon={Phone} title="No contact numbers yet" description={owner ? 'Add reception, reservations and emergency numbers.' : 'The owner can add them.'} />}
      {!!q.data?.length && (
        <TableWrap>
          <thead><tr>{['Label', 'Type', 'Number', 'On website', 'Status'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">{q.data.map((c) => (
            <tr key={c.id} className={owner ? 'cursor-pointer hover:bg-muted/40' : ''} onClick={() => owner && setEditing(c)}>
              <td className={td}><span className="font-medium">{c.label}</span>{c.note && <p className="text-xs text-muted-foreground">{c.note}</p>}</td>
              <td className={td}>{KINDS.find(([k]) => k === c.kind)?.[1]}</td>
              <td className={td}><a href={`tel:+${c.phone}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>{formatPhoneLocal(c.phone)}</a></td>
              <td className={td}>{c.show_on_website && !['emergency', 'management'].includes(c.kind) ? 'Yes' : 'No'}</td>
              <td className={td}>{c.active ? <Badge className="border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300">Active</Badge> : <Badge className="border-border bg-muted text-muted-foreground">Off</Badge>}</td>
            </tr>))}</tbody>
        </TableWrap>
      )}
      {editing && <Editor c={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function Editor({ c, onClose }: { c: Contact | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [v, setV] = useState({ label: c?.label ?? '', kind: c?.kind ?? 'reception', phone: c ? formatPhoneLocal(c.phone) : '', note: c?.note ?? '', show: c?.show_on_website ?? false, active: c?.active ?? true })
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: async () => {
      setErr('')
      if (v.label.trim().length < 2) throw new Error('Give this number a label.')
      const p = normalizePhone(v.phone)
      if (!p.ok) throw new Error(p.error)
      const row = { label: v.label.trim(), kind: v.kind, phone: p.phone, note: v.note.trim() || null, show_on_website: v.show, active: v.active }
      const { error } = c ? await sb().from('contact_numbers').update(row).eq('id', c.id) : await sb().from('contact_numbers').insert(row)
      if (error) throw error.code === '23505' ? new Error('That number is already listed for this type.') : error
    },
    onSuccess: () => { toast.success('Saved'); qc.invalidateQueries({ queryKey: ['contacts'] }); onClose() },
    onError: (e) => setErr(errMessage(e)),
  })
  const del = useMutation({
    mutationFn: async () => { const { error } = await sb().from('contact_numbers').delete().eq('id', c!.id); if (error) throw error },
    onSuccess: () => { toast.success('Removed'); qc.invalidateQueries({ queryKey: ['contacts'] }); onClose() },
    onError: (e) => toast.error(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={c ? 'Edit number' : 'Add number'} description="Kenyan numbers only, for example 0712 345 678.">
        <div className="grid gap-4">
          <Field label="Label" htmlFor="ct-label"><Input id="ct-label" maxLength={40} value={v.label} onChange={(e) => setV({ ...v, label: e.target.value })} /></Field>
          <Field label="Type" htmlFor="ct-kind"><Select id="ct-kind" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Field label="Phone number" htmlFor="ct-phone"><Input id="ct-phone" inputMode="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} /></Field>
          <Field label="Note" htmlFor="ct-note"><Input id="ct-note" maxLength={120} placeholder="e.g. Open 7am to 10pm" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.show} disabled={['emergency', 'management'].includes(v.kind)} onChange={(e) => setV({ ...v, show: e.target.checked })} /> Show on the public website</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} /> In use</label>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <div className="flex gap-2"><Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>{c && <Button variant="outline" className="text-danger" loading={del.isPending} onClick={() => { if (confirm('Remove this number?')) del.mutate() }}>Remove</Button>}</div>
        </div>
      </SheetContent>
    </Dialog>
  )
}
