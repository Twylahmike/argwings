import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Gift, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { AUDIENCE_LABEL, type Offer, type Tier } from '~/lib/membership-admin'
import { requireRole } from '~/lib/auth'
import { usePermissions } from '~/lib/permissions'
import { callFunction } from '~/lib/functions'
import { errMessage } from '~/lib/utils'
import { formatDate } from '~/lib/dates'
import { formatKES } from '~/lib/money'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { Field, Input, Select, Textarea } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, TableWrap, td, th } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/offers')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: Offers,
})

const describe = (o: Offer) => (o.kind === 'percent' ? `${o.value}% off` : `${formatKES(o.value)} off`) + (o.max_discount ? ` (max ${formatKES(o.max_discount)})` : '')

function Offers() {
  const { can } = usePermissions()
  const qc = useQueryClient()
  const [edit, setEdit] = useState<Offer | 'new' | null>(null)
  const q = useQuery({
    queryKey: ['offers-admin'],
    queryFn: async () => {
      const [o, r, x, p] = await Promise.all([
        sb().from('promotional_offers').select('*').order('created_at', { ascending: false }),
        sb().from('customer_rewards').select('offer_id'),
        sb().from('reward_redemptions').select('offer_id, amount, released_at'),
        sb().from('properties').select('id, name').order('sort'),
      ])
      if (o.error) throw o.error
      const issued = new Map<string, number>(); for (const a of r.data ?? []) issued.set(a.offer_id as string, (issued.get(a.offer_id as string) ?? 0) + 1)
      const used = new Map<string, { n: number; total: number }>(); for (const a of (x.data ?? []) as { offer_id: string; amount: number; released_at: string | null }[]) { if (a.released_at) continue; const u = used.get(a.offer_id) ?? { n: 0, total: 0 }; used.set(a.offer_id, { n: u.n + 1, total: u.total + a.amount }) }
      return { rows: o.data as Offer[], issued, used, props: (p.data ?? []) as { id: string; name: string }[] }
    },
  })
  const toggle = useMutation({
    mutationFn: async (o: Offer) => { const { error } = await sb().from('promotional_offers').update({ active: !o.active }).eq('id', o.id); if (error) throw error },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['offers-admin'] }), onError: (e) => toast.error(errMessage(e)),
  })
  const manage = can('offers.manage')
  const promote = useMutation({
    mutationFn: (o: Offer) => callFunction<{ recipients: number; accepted: number; failed: number; skipped: number }>('member-emails', { action: 'promote', offer_id: o.id }),
    onSuccess: (r) => toast.success(r.recipients === 0 ? 'No opted-in members to email.' : `${r.accepted} accepted by the email provider${r.failed ? `, ${r.failed} failed` : ''}${r.skipped ? `, ${r.skipped} skipped (email is off)` : ''}.`),
    onError: (e) => toast.error(errMessage(e)),
  })
  const today = new Date().toISOString().slice(0, 10)
  return (
    <div>
      <PageHeader title="Special offers" description="Welcome, birthday and member offers. The welcome offer is given to every new verified member. All rules are checked by the system when a booking is made."
        actions={manage ? <Button onClick={() => setEdit('new')}><Plus className="h-4 w-4" aria-hidden /> New offer</Button> : undefined} />
      {q.isLoading && <Skeleton className="h-48" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && !q.data.rows.length && <EmptyState icon={Gift} title="No offers yet" description="Create a welcome offer so new members get a reason to book." />}
      {!!q.data?.rows.length && (
        <TableWrap>
          <thead><tr>{['Offer', 'Type', 'Discount', 'Rules', 'Valid', 'Issued / used', 'Status'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">{q.data.rows.map((o) => {
            const u = q.data!.used.get(o.id); const expired = !!o.valid_to && o.valid_to < today
            return (
              <tr key={o.id} className={manage ? 'cursor-pointer hover:bg-muted/40' : ''} onClick={() => manage && setEdit(o)}>
                <td className={td}><b>{o.name}</b>{o.description && <p className="text-xs text-muted-foreground">{o.description}</p>}</td>
                <td className={td}>{AUDIENCE_LABEL[o.audience]}</td>
                <td className={td}>{describe(o)}</td>
                <td className={td}><ul className="text-xs text-muted-foreground">
                  {o.first_booking_only && <li>First booking only</li>}{o.returning_only && <li>Returning guests</li>}{o.min_tier_key && <li>{o.min_tier_key}+ tier</li>}
                  {o.min_total > 0 && <li>From {formatKES(o.min_total)}</li>}{o.property_ids.length > 0 && <li>{o.property_ids.length} propert{o.property_ids.length === 1 ? 'y' : 'ies'}</li>}{o.stackable && <li>Stacks with codes</li>}
                  <li>{o.per_customer_limit}× per customer{o.max_redemptions ? `, ${o.max_redemptions} total` : ''}</li></ul></td>
                <td className={`${td} whitespace-nowrap text-xs`}>{o.valid_from || o.valid_to ? `${o.valid_from ? formatDate(o.valid_from) : 'Now'} to ${o.valid_to ? formatDate(o.valid_to) : 'no end'}` : 'Always'}{o.valid_days ? <p className="text-muted-foreground">Reward lasts {o.valid_days} days</p> : null}</td>
                <td className={td}>{q.data!.issued.get(o.id) ?? 0} / {u?.n ?? 0}{u ? <p className="text-xs text-muted-foreground">{formatKES(u.total)} given</p> : null}</td>
                <td className={td} onClick={(e) => e.stopPropagation()}>
                  {manage && o.audience === 'member' && o.active && !expired && <Button size="sm" variant="outline" className="mb-1" loading={promote.isPending} onClick={() => { if (window.confirm('Email this offer to all opted-in members who qualify?')) promote.mutate(o) }}>Email members</Button>}
                  {expired ? <Badge className="border-border bg-muted text-muted-foreground">Expired</Badge> : manage
                    ? <button type="button" role="switch" aria-checked={o.active} aria-label={`${o.name} is ${o.active ? 'on' : 'off'}`} onClick={() => toggle.mutate(o)} className="inline-flex h-11 items-center"><Badge className={o.active ? 'border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300' : 'border-border bg-muted text-muted-foreground'}>{o.active ? 'On' : 'Off'}</Badge></button>
                    : <Badge>{o.active ? 'On' : 'Off'}</Badge>}
                </td>
              </tr>)
          })}</tbody>
        </TableWrap>
      )}
      {edit && q.data && <Editor offer={edit === 'new' ? null : edit} props={q.data.props} onClose={() => setEdit(null)} />}
    </div>
  )
}

function Editor({ offer, props, onClose }: { offer: Offer | null; props: { id: string; name: string }[]; onClose: () => void }) {
  const qc = useQueryClient()
  const tiers = useQuery({ queryKey: ['tiers-admin'], queryFn: async () => { const { data, error } = await sb().from('membership_tiers').select('key, name, rank').order('rank'); if (error) throw error; return data as Pick<Tier, 'key' | 'name' | 'rank'>[] } })
  const [v, setV] = useState({
    name: offer?.name ?? '', description: offer?.description ?? '', terms: offer?.terms ?? '', audience: offer?.audience ?? 'member', kind: offer?.kind ?? 'percent', value: String(offer?.value ?? 5),
    max_discount: offer?.max_discount ? String(offer.max_discount) : '', min_total: String(offer?.min_total ?? 0), min_tier_key: offer?.min_tier_key ?? '',
    first: offer?.first_booking_only ?? false, returning: offer?.returning_only ?? false, valid_from: offer?.valid_from ?? '', valid_to: offer?.valid_to ?? '',
    valid_days: offer?.valid_days ? String(offer.valid_days) : '', max_redemptions: offer?.max_redemptions ? String(offer.max_redemptions) : '', per_customer: String(offer?.per_customer_limit ?? 1),
    stackable: offer?.stackable ?? false, active: offer?.active ?? true, property_ids: offer?.property_ids ?? [] as string[],
  })
  const [err, setErr] = useState('')
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }))
  const int = (s: string, label: string, min: number, max?: number) => { const n = Number(s); if (!Number.isInteger(n) || n < min || (max != null && n > max)) throw new Error(`${label} must be a whole number${max != null ? ` from ${min} to ${max}` : `, ${min} or more`}.`); return n }
  const opt = (s: string, label: string, min: number, max?: number) => (s.trim() ? int(s, label, min, max) : null)
  const save = useMutation({
    mutationFn: async () => {
      setErr('')
      if (v.name.trim().length < 3) throw new Error('Give the offer a name.')
      const value = int(v.value, 'The discount', 1, v.kind === 'percent' ? 100 : undefined)
      if (v.first && v.returning) throw new Error('An offer cannot be both first-booking-only and returning-guests-only.')
      if (v.valid_from && v.valid_to && v.valid_to < v.valid_from) throw new Error('The end date must be on or after the start date.')
      const row = {
        name: v.name.trim(), description: v.description.trim() || null, terms: v.terms.trim() || null, audience: v.audience, kind: v.kind, value,
        max_discount: opt(v.max_discount, 'Maximum discount', 1), min_total: int(v.min_total, 'Minimum booking value', 0), property_ids: v.property_ids, min_tier_key: v.min_tier_key || null,
        first_booking_only: v.first, returning_only: v.returning, valid_from: v.valid_from || null, valid_to: v.valid_to || null, valid_days: opt(v.valid_days, 'Reward validity', 1, 730),
        max_redemptions: opt(v.max_redemptions, 'Total redemptions', 1), per_customer_limit: int(v.per_customer, 'Uses per customer', 1), stackable: v.stackable, active: v.active,
      }
      const { error } = offer ? await sb().from('promotional_offers').update(row).eq('id', offer.id) : await sb().from('promotional_offers').insert(row)
      if (error) throw error
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['offers-admin'] }); toast.success('Saved'); onClose() },
    onError: (e) => setErr(errMessage(e)),
  })
  const toggleProp = (id: string) => setV((s) => ({ ...s, property_ids: s.property_ids.includes(id) ? s.property_ids.filter((x) => x !== id) : [...s.property_ids, id] }))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={offer ? `Edit offer` : 'New offer'} description="Applies to the room charge only, never the cleaning fee.">
        <div className="grid gap-4">
          <Field label="Name" htmlFor="o-name"><Input id="o-name" value={v.name} onChange={set('name')} maxLength={80} /></Field>
          <Field label="Short description (shown to members)" htmlFor="o-desc"><Input id="o-desc" value={v.description} onChange={set('description')} maxLength={300} /></Field>
          <Field label="Terms (shown to members)" htmlFor="o-terms"><Textarea id="o-terms" value={v.terms} onChange={set('terms')} maxLength={1000} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Who gets it" htmlFor="o-aud" hint="Welcome: given on verification. Birthday: given on the day. Member: open to eligible members."><Select id="o-aud" value={v.audience} onChange={set('audience')}><option value="welcome">Welcome offer (new members)</option><option value="birthday">Birthday reward</option><option value="member">Member offer (open)</option></Select></Field>
            <Field label="Type" htmlFor="o-kind"><Select id="o-kind" value={v.kind} onChange={set('kind')}><option value="percent">Percent off</option><option value="fixed">Fixed amount off (KES)</option></Select></Field>
            <Field label={v.kind === 'percent' ? 'Percent' : 'Amount (KES)'} htmlFor="o-val"><Input id="o-val" inputMode="numeric" value={v.value} onChange={set('value')} /></Field>
            <Field label="Maximum discount (KES)" htmlFor="o-max" hint="Empty = no cap."><Input id="o-max" inputMode="numeric" value={v.max_discount} onChange={set('max_discount')} /></Field>
            <Field label="Minimum booking value (KES)" htmlFor="o-min" hint="Room total before the discount."><Input id="o-min" inputMode="numeric" value={v.min_total} onChange={set('min_total')} /></Field>
            <Field label="Minimum tier" htmlFor="o-tier"><Select id="o-tier" value={v.min_tier_key} onChange={set('min_tier_key')}><option value="">Any member</option>{(tiers.data ?? []).map((t) => <option key={t.key} value={t.key}>{t.name} and above</option>)}</Select></Field>
            <Field label="Starts" htmlFor="o-from"><Input id="o-from" type="date" value={v.valid_from} onChange={set('valid_from')} /></Field>
            <Field label="Ends" htmlFor="o-to"><Input id="o-to" type="date" value={v.valid_to} onChange={set('valid_to')} /></Field>
            <Field label="Reward lasts (days)" htmlFor="o-days" hint="For welcome and birthday rewards: days from issue."><Input id="o-days" inputMode="numeric" value={v.valid_days} onChange={set('valid_days')} /></Field>
            <Field label="Uses per customer" htmlFor="o-pc"><Input id="o-pc" inputMode="numeric" value={v.per_customer} onChange={set('per_customer')} /></Field>
            <Field label="Total redemption limit" htmlFor="o-tot" hint="Empty = unlimited."><Input id="o-tot" inputMode="numeric" value={v.max_redemptions} onChange={set('max_redemptions')} /></Field>
          </div>
          <fieldset className="grid gap-2 rounded-lg border p-3 text-sm"><legend className="px-1 text-xs font-medium text-muted-foreground">Eligible accommodation (none ticked = all)</legend>
            {props.map((p) => <label key={p.id} className="flex items-center gap-2"><input type="checkbox" checked={v.property_ids.includes(p.id)} onChange={() => toggleProp(p.id)} /> {p.name}</label>)}</fieldset>
          <div className="grid gap-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={v.first} onChange={(e) => setV((s) => ({ ...s, first: e.target.checked, returning: e.target.checked ? false : s.returning }))} /> First booking only</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={v.returning} onChange={(e) => setV((s) => ({ ...s, returning: e.target.checked, first: e.target.checked ? false : s.first }))} /> Returning guests only (at least one completed stay)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={v.stackable} onChange={(e) => setV((s) => ({ ...s, stackable: e.target.checked }))} /> Can be combined with a discount code</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={v.active} onChange={(e) => setV((s) => ({ ...s, active: e.target.checked }))} /> Offer is switched on</label>
          </div>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <Button loading={save.isPending} onClick={() => save.mutate()}>Save offer</Button>
        </div>
      </SheetContent>
    </Dialog>
  )
}
