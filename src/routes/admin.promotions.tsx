import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Tag } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { isOwner, requireRole } from '~/lib/auth'
import { errMessage } from '~/lib/utils'
import { formatDate } from '~/lib/dates'
import { formatKES } from '~/lib/money'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { Field, Input, Select } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, TableWrap, td, th } from '~/components/ui/misc'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/promotions')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: PromotionsPage,
})

type Code = {
  id: string; code: string; description: string | null; kind: 'percent' | 'fixed'; value: number; property_id: string | null
  min_nights: number; min_total: number; valid_from: string | null; valid_to: string | null; max_uses: number | null; active: boolean
}
const describe = (c: Code) => (c.kind === 'percent' ? `${c.value}% off the room charge` : `${formatKES(c.value)} off the room charge`)

function PromotionsPage() {
  const { me } = useAdmin()
  const [editing, setEditing] = useState<Code | 'new' | null>(null)
  const q = useQuery({
    queryKey: ['discount-codes'],
    queryFn: async () => {
      const [c, r, p] = await Promise.all([
        sb().from('discount_codes').select('*').order('created_at', { ascending: false }),
        sb().from('discount_redemptions').select('code_id, amount, booking:bookings(status)'),
        sb().from('properties').select('id, name'),
      ])
      if (c.error) throw c.error
      const uses = new Map<string, { n: number; total: number }>()
      for (const x of (r.data ?? []) as unknown as { code_id: string; amount: number; booking: { status: string } | null }[]) {
        if (!x.booking || ['cancelled', 'expired', 'no_show'].includes(x.booking.status)) continue
        const u = uses.get(x.code_id) ?? { n: 0, total: 0 }
        uses.set(x.code_id, { n: u.n + 1, total: u.total + x.amount })
      }
      return { rows: c.data as Code[], uses, props: new Map((p.data ?? []).map((x) => [x.id as string, x.name as string])) }
    },
  })
  const rows = useMemo(() => q.data?.rows ?? [], [q.data])
  return (
    <div>
      <PageHeader title="Promotions" description="Discount codes guests can enter when booking. Checked and applied by the system, so the discount cannot be edited in the browser."
        actions={<Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden /> New code</Button>} />
      {q.isLoading && <Skeleton className="h-48" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && rows.length === 0 && <EmptyState icon={Tag} title="No discount codes yet" description="Create a code such as WELCOME10 for 10% off, or LONGSTAY for stays of 7 nights or more." />}
      {rows.length > 0 && (
        <TableWrap>
          <thead><tr>{['Code', 'Offer', 'Applies to', 'Valid', 'Used', 'Status'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">{rows.map((c) => {
            const u = q.data!.uses.get(c.id)
            const expired = !!c.valid_to && c.valid_to < new Date().toISOString().slice(0, 10)
            return (
              <tr key={c.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setEditing(c)}>
                <td className={td}><button className="font-mono font-semibold text-brand hover:underline" onClick={() => setEditing(c)}>{c.code}</button>{c.description && <p className="text-xs text-muted-foreground">{c.description}</p>}</td>
                <td className={td}>{describe(c)}{c.min_nights > 1 && <p className="text-xs text-muted-foreground">{c.min_nights}+ nights</p>}</td>
                <td className={td}>{c.property_id ? q.data!.props.get(c.property_id) ?? '—' : 'All properties'}</td>
                <td className={`${td} whitespace-nowrap`}>{c.valid_from || c.valid_to ? `${c.valid_from ? formatDate(c.valid_from) : 'Now'} to ${c.valid_to ? formatDate(c.valid_to) : 'no end'}` : 'Always'}</td>
                <td className={td}>{u?.n ?? 0}{c.max_uses ? ` / ${c.max_uses}` : ''}{u ? <p className="text-xs text-muted-foreground">{formatKES(u.total)} given</p> : null}</td>
                <td className={td}>{!c.active ? <Badge className="border-border bg-muted text-muted-foreground">Off</Badge> : expired ? <Badge className="border-border bg-muted text-muted-foreground">Expired</Badge> : <Badge className="border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300">Live</Badge>}</td>
              </tr>)
          })}</tbody>
        </TableWrap>
      )}
      {editing && q.data && <Editor code={editing === 'new' ? null : editing} owner={isOwner(me)} props={me.properties} onClose={() => setEditing(null)} />}
    </div>
  )
}

function Editor({ code, owner, props, onClose }: { code: Code | null; owner: boolean; props: { id: string; name: string }[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [v, setV] = useState({
    code: code?.code ?? '', description: code?.description ?? '', kind: code?.kind ?? 'percent', value: String(code?.value ?? 10),
    property_id: code?.property_id ?? (owner ? '' : props[0]?.id ?? ''), min_nights: String(code?.min_nights ?? 1), min_total: String(code?.min_total ?? 0),
    valid_from: code?.valid_from ?? '', valid_to: code?.valid_to ?? '', max_uses: code?.max_uses ? String(code.max_uses) : '', active: code?.active ?? true,
  })
  const [err, setErr] = useState('')
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }))
  const save = useMutation({
    mutationFn: async () => {
      setErr('')
      const codeText = v.code.trim().toUpperCase()
      if (!/^[A-Z0-9_-]{3,24}$/.test(codeText)) throw new Error('Use 3 to 24 letters, numbers, - or _ for the code.')
      const value = Number(v.value)
      if (!Number.isInteger(value) || value < 1 || (v.kind === 'percent' && value > 100)) throw new Error(v.kind === 'percent' ? 'Percent must be a whole number from 1 to 100.' : 'Enter the amount in whole shillings.')
      const minNights = Number(v.min_nights); const minTotal = Number(v.min_total)
      if (!Number.isInteger(minNights) || minNights < 1) throw new Error('Minimum nights must be 1 or more.')
      if (!Number.isInteger(minTotal) || minTotal < 0) throw new Error('Minimum room total cannot be negative.')
      const maxUses = v.max_uses.trim() ? Number(v.max_uses) : null
      if (maxUses != null && (!Number.isInteger(maxUses) || maxUses < 1)) throw new Error('Maximum uses must be 1 or more, or empty for unlimited.')
      if (v.valid_from && v.valid_to && v.valid_to < v.valid_from) throw new Error('The end date must be on or after the start date.')
      if (!owner && !v.property_id) throw new Error('Choose a property for this code.')
      const row = {
        code: codeText, description: v.description.trim() || null, kind: v.kind, value, property_id: v.property_id || null,
        min_nights: minNights, min_total: minTotal, valid_from: v.valid_from || null, valid_to: v.valid_to || null, max_uses: maxUses, active: v.active,
      }
      const { error } = code ? await sb().from('discount_codes').update(row).eq('id', code.id) : await sb().from('discount_codes').insert(row)
      if (error) throw error.code === '23505' ? new Error('That code already exists.') : error
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['discount-codes'] }); toast.success('Saved'); onClose() },
    onError: (e) => setErr(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={code ? `Edit ${code.code}` : 'New discount code'} description="Applies to the room charge only, never the cleaning fee.">
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Code" htmlFor="dc-code" hint="Guests type this. Letters and numbers."><Input id="dc-code" className="font-mono uppercase" value={v.code} onChange={set('code')} maxLength={24} /></Field>
            <Field label="Note for staff" htmlFor="dc-desc"><Input id="dc-desc" value={v.description} onChange={set('description')} maxLength={200} /></Field>
            <Field label="Type" htmlFor="dc-kind"><Select id="dc-kind" value={v.kind} onChange={set('kind')}><option value="percent">Percent off</option><option value="fixed">Fixed amount off (KES)</option></Select></Field>
            <Field label={v.kind === 'percent' ? 'Percent' : 'Amount (KES)'} htmlFor="dc-value"><Input id="dc-value" inputMode="numeric" value={v.value} onChange={set('value')} /></Field>
            <Field label="Property" htmlFor="dc-prop"><Select id="dc-prop" value={v.property_id} onChange={set('property_id')}>{owner && <option value="">All properties</option>}{props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <Field label="Maximum uses" htmlFor="dc-max" hint="Empty = unlimited. A cancelled booking gives its use back."><Input id="dc-max" inputMode="numeric" value={v.max_uses} onChange={set('max_uses')} /></Field>
            <Field label="Minimum nights" htmlFor="dc-mn"><Input id="dc-mn" inputMode="numeric" value={v.min_nights} onChange={set('min_nights')} /></Field>
            <Field label="Minimum room total (KES)" htmlFor="dc-mt"><Input id="dc-mt" inputMode="numeric" value={v.min_total} onChange={set('min_total')} /></Field>
            <Field label="Valid from" htmlFor="dc-vf"><Input id="dc-vf" type="date" value={v.valid_from} onChange={set('valid_from')} /></Field>
            <Field label="Valid until" htmlFor="dc-vt"><Input id="dc-vt" type="date" value={v.valid_to} onChange={set('valid_to')} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.active} onChange={(e) => setV((s) => ({ ...s, active: e.target.checked }))} /> Code is switched on</label>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <Button loading={save.isPending} onClick={() => save.mutate()}>Save code</Button>
        </div>
      </SheetContent>
    </Dialog>
  )
}
