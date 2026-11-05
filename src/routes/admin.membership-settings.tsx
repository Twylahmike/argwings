import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { adminRpc, type Offer, type Overview } from '~/lib/membership-admin'
import { requireRole } from '~/lib/auth'
import { usePermissions } from '~/lib/permissions'
import { errMessage } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Field, Input, Select, Textarea } from '~/components/ui/form'
import { ErrorState, PageHeader, Skeleton } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/membership-settings')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: MembershipSettings,
})

function MembershipSettings() {
  const { can } = usePermissions()
  const qc = useQueryClient()
  const sw = useQuery({ queryKey: ['membership-switches'], queryFn: () => adminRpc<Overview>('membership_overview', { p_days: 30 }) })
  const toggle = useMutation({
    mutationFn: ({ key, on }: { key: string; on: boolean }) => adminRpc('set_membership_setting', { p_key: key, p_value: on }),
    onSuccess: () => { toast.success('Saved'); qc.invalidateQueries({ queryKey: ['membership-switches'] }); qc.invalidateQueries({ queryKey: ['brand'] }) },
    onError: (e) => toast.error(errMessage(e)),
  })
  const manage = can('customers.manage')
  return (
    <div className="grid max-w-3xl gap-6">
      <PageHeader title="Membership settings" description="Registration is free and optional. Guest checkout stays available unless you switch it off here. Changes show on the website within a few minutes." />
      {sw.isLoading && <Skeleton className="h-32" />}
      {sw.error && <ErrorState error={sw.error} retry={() => sw.refetch()} />}
      {sw.data && (
        <Card><CardHeader><CardTitle>Switches</CardTitle></CardHeader><CardContent className="grid gap-4 text-sm">
          <label className="flex items-start gap-3"><input type="checkbox" className="mt-0.5 h-5 w-5" disabled={!manage || toggle.isPending} checked={sw.data.registration_enabled} onChange={(e) => toggle.mutate({ key: 'registration_enabled', on: e.target.checked })} />
            <span><b>Optional registration is on.</b> Visitors can join for free and see the invitations. When off, the invitations disappear and no new memberships are created (existing members keep theirs).</span></label>
          <label className="flex items-start gap-3"><input type="checkbox" className="mt-0.5 h-5 w-5" disabled={!manage || toggle.isPending} checked={sw.data.guest_checkout_enabled} onChange={(e) => toggle.mutate({ key: 'guest_checkout_enabled', on: e.target.checked })} />
            <span><b>Guest checkout is on.</b> Anyone can book without an account. Turn this off only if you want bookings to be for members only.</span></label>
          {!sw.data.guest_checkout_enabled && <p role="alert" className="rounded-md border border-danger/40 bg-danger/5 p-2 text-danger">Guest checkout is off: visitors must create an account before they can book.</p>}
        </CardContent></Card>
      )}
      <WelcomeOffer manage={can('offers.manage')} />
    </div>
  )
}

function WelcomeOffer({ manage }: { manage: boolean }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['welcome-offer'],
    queryFn: async () => {
      const [o, p] = await Promise.all([
        sb().from('promotional_offers').select('*').eq('audience', 'welcome').order('created_at').limit(1),
        sb().from('properties').select('id, name').order('sort'),
      ])
      if (o.error) throw o.error
      return { offer: ((o.data ?? [])[0] as Offer | undefined) ?? null, props: (p.data ?? []) as { id: string; name: string }[] }
    },
  })
  const [v, setV] = useState({ on: true, kind: 'percent', value: '5', min_total: '0', max_discount: '', min_nights: '1', valid_from: '', valid_to: '', valid_days: '60', applies_to: 'room', stackable: false, terms: '', property_ids: [] as string[] })
  const [err, setErr] = useState('')
  useEffect(() => {
    const o = q.data?.offer
    if (o) setV({ on: o.active, kind: o.kind, value: String(o.value), min_total: String(o.min_total), max_discount: o.max_discount ? String(o.max_discount) : '', min_nights: String(o.min_nights), valid_from: o.valid_from ?? '', valid_to: o.valid_to ?? '', valid_days: o.valid_days ? String(o.valid_days) : '', applies_to: o.applies_to, stackable: o.stackable, terms: o.terms ?? '', property_ids: o.property_ids })
  }, [q.data?.offer])
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }))
  const int = (s: string, label: string, min: number, max?: number) => { const n = Number(s); if (!Number.isInteger(n) || n < min || (max != null && n > max)) throw new Error(`${label} must be a whole number${max != null ? ` from ${min} to ${max}` : `, ${min} or more`}.`); return n }
  const save = useMutation({
    mutationFn: async () => {
      setErr('')
      const raw = Number(v.value)
      if (!Number.isInteger(raw) || raw < 0 || (v.kind === 'percent' && raw > 100)) throw new Error(v.kind === 'percent' ? 'Enter a whole percentage from 0 to 100.' : 'Enter the amount in whole shillings.')
      // 0 means "no welcome discount": the offer is switched off (a stored value must be at least 1).
      const off = raw === 0
      if (v.valid_from && v.valid_to && v.valid_to < v.valid_from) throw new Error('The end date must be on or after the start date.')
      const row = {
        name: v.kind === 'percent' ? `Welcome offer: ${off ? q.data?.offer?.value ?? 5 : raw}% off your first stay` : `Welcome offer: KES ${off ? q.data?.offer?.value ?? 500 : raw} off your first stay`,
        description: 'A thank-you for joining as a member.', terms: v.terms.trim() || null, audience: 'welcome', kind: v.kind, value: off ? q.data?.offer?.value ?? (v.kind === 'percent' ? 5 : 500) : raw,
        max_discount: v.max_discount.trim() ? int(v.max_discount, 'Maximum discount', 1) : null, min_total: int(v.min_total, 'Minimum booking amount', 0), min_nights: int(v.min_nights, 'Minimum nights', 1),
        property_ids: v.property_ids, first_booking_only: true, per_customer_limit: 1, valid_from: v.valid_from || null, valid_to: v.valid_to || null,
        valid_days: v.valid_days.trim() ? int(v.valid_days, 'Reward expiry', 1, 730) : null, applies_to: v.applies_to, stackable: v.stackable, active: v.on && !off,
      }
      const { error } = q.data?.offer ? await sb().from('promotional_offers').update(row).eq('id', q.data.offer.id) : await sb().from('promotional_offers').insert(row)
      if (error) throw error
      return off
    },
    onSuccess: (off) => { toast.success(off ? 'Saved. A 0 discount means the welcome offer is switched off.' : 'Welcome offer saved'); qc.invalidateQueries({ queryKey: ['welcome-offer'] }); qc.invalidateQueries({ queryKey: ['offers-admin'] }) },
    onError: (e) => setErr(errMessage(e)),
  })
  const toggleProp = (id: string) => setV((s) => ({ ...s, property_ids: s.property_ids.includes(id) ? s.property_ids.filter((x) => x !== id) : [...s.property_ids, id] }))
  return (
    <Card><CardHeader><CardTitle>Welcome offer</CardTitle></CardHeader><CardContent className="grid gap-4">
      {q.isLoading && <Skeleton className="h-40" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && <>
        <p className="text-sm text-muted-foreground">Given once to each new member after they verify their email. Nothing here is fixed: set any percentage, a fixed amount, or 0 to turn it off. Changes apply to members who join from now on; rewards already issued keep their terms.</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" disabled={!manage} checked={v.on} onChange={(e) => setV((s) => ({ ...s, on: e.target.checked }))} /> Welcome offer is switched on</label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Type" htmlFor="w-kind"><Select id="w-kind" disabled={!manage} value={v.kind} onChange={set('kind')}><option value="percent">Percentage off</option><option value="fixed">Fixed amount off (KES)</option></Select></Field>
          <Field label={v.kind === 'percent' ? 'Percentage (0 to 100)' : 'Amount (KES)'} htmlFor="w-val" hint="For example 0, 5 or 10."><Input id="w-val" inputMode="numeric" disabled={!manage} value={v.value} onChange={set('value')} /></Field>
          <Field label="Minimum booking amount (KES)" htmlFor="w-min"><Input id="w-min" inputMode="numeric" disabled={!manage} value={v.min_total} onChange={set('min_total')} /></Field>
          <Field label="Maximum discount (KES)" htmlFor="w-max" hint="Empty = no cap."><Input id="w-max" inputMode="numeric" disabled={!manage} value={v.max_discount} onChange={set('max_discount')} /></Field>
          <Field label="Minimum nights" htmlFor="w-nights"><Input id="w-nights" inputMode="numeric" disabled={!manage} value={v.min_nights} onChange={set('min_nights')} /></Field>
          <Field label="Reward expires after registration (days)" htmlFor="w-days" hint="Empty = never."><Input id="w-days" inputMode="numeric" disabled={!manage} value={v.valid_days} onChange={set('valid_days')} /></Field>
          <Field label="Offer starts" htmlFor="w-from"><Input id="w-from" type="date" disabled={!manage} value={v.valid_from} onChange={set('valid_from')} /></Field>
          <Field label="Offer ends" htmlFor="w-to"><Input id="w-to" type="date" disabled={!manage} value={v.valid_to} onChange={set('valid_to')} /></Field>
          <Field label="Discount applies to" htmlFor="w-app"><Select id="w-app" disabled={!manage} value={v.applies_to} onChange={set('applies_to')}><option value="room">Accommodation charge only</option><option value="total">Whole total (includes cleaning fee)</option></Select></Field>
          <Field label="Combined with other promotions" htmlFor="w-stack"><Select id="w-stack" disabled={!manage} value={v.stackable ? 'yes' : 'no'} onChange={(e) => setV((s) => ({ ...s, stackable: e.target.value === 'yes' }))}><option value="no">Cannot be combined with a discount code</option><option value="yes">Can be combined with a discount code</option></Select></Field>
        </div>
        <fieldset className="grid gap-2 rounded-lg border p-3 text-sm"><legend className="px-1 text-xs font-medium text-muted-foreground">Eligible accommodation (none ticked = all)</legend>
          {q.data.props.map((p) => <label key={p.id} className="flex items-center gap-2"><input type="checkbox" disabled={!manage} checked={v.property_ids.includes(p.id)} onChange={() => toggleProp(p.id)} /> {p.name}</label>)}</fieldset>
        <Field label="Terms shown to members" htmlFor="w-terms"><Textarea id="w-terms" disabled={!manage} value={v.terms} onChange={set('terms')} maxLength={1000} /></Field>
        <p className="text-xs text-muted-foreground">Each customer can receive and use only one welcome reward, whatever is set here.</p>
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
        {manage && <Button loading={save.isPending} onClick={() => save.mutate()}>Save welcome offer</Button>}
      </>}
    </CardContent></Card>
  )
}
