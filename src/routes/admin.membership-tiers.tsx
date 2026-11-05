import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import type { Tier } from '~/lib/membership-admin'
import { requireRole } from '~/lib/auth'
import { usePermissions } from '~/lib/permissions'
import { errMessage } from '~/lib/utils'
import { formatKES } from '~/lib/money'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { Field, Input, Textarea } from '~/components/ui/form'
import { ErrorState, PageHeader, Skeleton, TableWrap, td, th } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/membership-tiers')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: Tiers,
})

function Tiers() {
  const { can } = usePermissions()
  const [edit, setEdit] = useState<Tier | 'new' | null>(null)
  const q = useQuery({ queryKey: ['tiers-admin'], queryFn: async () => { const { data, error } = await sb().from('membership_tiers').select('*').order('rank'); if (error) throw error; return data as Tier[] } })
  const manage = can('customers.manage')
  return (
    <div>
      <PageHeader title="Membership tiers" description="A customer reaches a tier by meeting its criteria (completed stays and money paid, within the tier's term). Staff can also set a tier by hand on the customer's page."
        actions={manage ? <Button onClick={() => setEdit('new')}><Plus className="h-4 w-4" aria-hidden /> New tier</Button> : undefined} />
      {q.isLoading && <Skeleton className="h-40" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && (
        <TableWrap>
          <thead><tr>{['Tier', 'Needs', 'Term', 'Benefits', 'Status'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">{q.data.map((t) => (
            <tr key={t.key} className={manage ? 'cursor-pointer hover:bg-muted/40' : ''} onClick={() => manage && setEdit(t)}>
              <td className={td}><b>{t.name}</b><p className="text-xs text-muted-foreground">Level {t.rank + 1}</p></td>
              <td className={td}>{t.min_completed_stays} stays and {formatKES(t.min_spend)}</td>
              <td className={td}>{t.expiry_months ? `${t.expiry_months} months` : 'No expiry'}</td>
              <td className={td}><ul className="list-disc pl-4 text-xs">{t.benefits.map((b) => <li key={b}>{b}</li>)}</ul></td>
              <td className={td}>{t.active ? <Badge className="border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300">On</Badge> : <Badge className="border-border bg-muted text-muted-foreground">Off</Badge>}</td>
            </tr>))}</tbody>
        </TableWrap>
      )}
      <p className="mt-4 text-sm text-muted-foreground">The Standard tier is where every verified member starts and cannot be removed. Tier benefits that are discounts are set up as member offers (Special offers, with a minimum tier).</p>
      {edit && q.data && <Editor tier={edit === 'new' ? null : edit} ranks={q.data.map((t) => t.rank)} onClose={() => setEdit(null)} />}
    </div>
  )
}

function Editor({ tier, ranks, onClose }: { tier: Tier | null; ranks: number[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [v, setV] = useState({ key: tier?.key ?? '', name: tier?.name ?? '', rank: String(tier?.rank ?? Math.max(...ranks) + 1), stays: String(tier?.min_completed_stays ?? 0), spend: String(tier?.min_spend ?? 0), expiry: tier?.expiry_months ? String(tier.expiry_months) : '', benefits: (tier?.benefits ?? []).join('\n'), active: tier?.active ?? true })
  const [err, setErr] = useState('')
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }))
  const save = useMutation({
    mutationFn: async () => {
      setErr('')
      const stays = Number(v.stays); const spend = Number(v.spend); const rank = Number(v.rank)
      if (v.name.trim().length < 2) throw new Error('Enter a tier name.')
      if (![stays, spend, rank].every((n) => Number.isInteger(n) && n >= 0)) throw new Error('Stays, spend and level must be whole numbers, 0 or more.')
      const expiry = v.expiry.trim() ? Number(v.expiry) : null
      if (expiry != null && (!Number.isInteger(expiry) || expiry < 1 || expiry > 120)) throw new Error('Term must be 1 to 120 months, or empty for no expiry.')
      const row = { name: v.name.trim(), min_completed_stays: stays, min_spend: spend, expiry_months: expiry, benefits: v.benefits.split('\n').map((b) => b.trim()).filter(Boolean), active: tier?.key === 'standard' ? true : v.active }
      if (tier) { const { error } = await sb().from('membership_tiers').update(row).eq('key', tier.key); if (error) throw error }
      else {
        if (!/^[a-z][a-z0-9_]{1,20}$/.test(v.key)) throw new Error('Use lowercase letters for the tier key, for example platinum.')
        const { error } = await sb().from('membership_tiers').insert({ ...row, key: v.key, rank })
        if (error) throw error.code === '23505' ? new Error('A tier with that key or level already exists.') : error
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tiers-admin'] }); toast.success('Saved'); onClose() },
    onError: (e) => setErr(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={tier ? `Edit ${tier.name}` : 'New tier'} description="Changing criteria affects who qualifies from the next completed stay.">
        <div className="grid gap-4">
          <Field label="Name" htmlFor="t-name"><Input id="t-name" value={v.name} onChange={set('name')} maxLength={40} /></Field>
          {!tier && <div className="grid grid-cols-2 gap-3"><Field label="Key" htmlFor="t-key" hint="Short, lowercase, permanent."><Input id="t-key" value={v.key} onChange={set('key')} /></Field><Field label="Level" htmlFor="t-rank" hint="Higher = better tier."><Input id="t-rank" inputMode="numeric" value={v.rank} onChange={set('rank')} /></Field></div>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Completed stays needed" htmlFor="t-stays"><Input id="t-stays" inputMode="numeric" value={v.stays} onChange={set('stays')} /></Field>
            <Field label="Money paid needed (KES)" htmlFor="t-spend"><Input id="t-spend" inputMode="numeric" value={v.spend} onChange={set('spend')} /></Field>
          </div>
          <Field label="Term (months)" htmlFor="t-exp" hint="Stays are counted over this window. Empty = all stays count and the tier never expires."><Input id="t-exp" inputMode="numeric" value={v.expiry} onChange={set('expiry')} /></Field>
          <Field label="Benefits (one per line)" htmlFor="t-ben"><Textarea id="t-ben" value={v.benefits} onChange={set('benefits')} /></Field>
          {tier?.key !== 'standard' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.active} onChange={(e) => setV((s) => ({ ...s, active: e.target.checked }))} /> Tier is switched on</label>}
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <Button loading={save.isPending} onClick={() => save.mutate()}>Save tier</Button>
        </div>
      </SheetContent>
    </Dialog>
  )
}
