import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, Users } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { adminRpc, type CustomerRow, type Offer, type Tier } from '~/lib/membership-admin'
import { usePermissions } from '~/lib/permissions'
import { requireRole } from '~/lib/auth'
import { errMessage } from '~/lib/utils'
import { formatDate, formatDateTime } from '~/lib/dates'
import { formatKES } from '~/lib/money'
import { Badge, StatusBadge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { Field, Input, Select } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, TableWrap, td, th } from '~/components/ui/misc'
import type { BookingStatus } from '~/lib/types'

export const Route = createFileRoute('/admin/customers')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: Customers,
})

function Customers() {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const q = useQuery({ queryKey: ['admin-customers', search], queryFn: () => adminRpc<CustomerRow[]>('admin_customer_list', { p_search: search || null }) })
  return (
    <div>
      <PageHeader title="Customer accounts" description="People who joined with an email address. Figures are counted from their bookings and rewards." />
      <div className="relative mb-4 max-w-sm"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
        <Input aria-label="Search customers" className="pl-9" placeholder="Search name, email or phone" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      {q.isLoading && <Skeleton className="h-48" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && !q.data.length && <EmptyState icon={Users} title={search ? 'No customers match' : 'No customers yet'} description="Accounts appear here once people verify their email." />}
      {!!q.data?.length && (
        <TableWrap>
          <thead><tr>{['Customer', 'Joined', 'Tier', 'Bookings', 'Spend', 'Points', 'Offers', 'Status'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">{q.data.map((c) => (
            <tr key={c.user_id} className="cursor-pointer hover:bg-muted/40" onClick={() => setOpen(c.user_id)}>
              <td className={td}><button className="text-left font-medium text-brand hover:underline" onClick={() => setOpen(c.user_id)}>{c.full_name}</button><p className="text-xs text-muted-foreground">{c.email}{c.phone ? ` · +${c.phone}` : ''}</p></td>
              <td className={`${td} whitespace-nowrap`}>{formatDate(c.created_at.slice(0, 10))}<p className="text-xs text-muted-foreground">Verified</p></td>
              <td className={td}>{c.tier}</td><td className={td}>{c.bookings}</td><td className={td}>{formatKES(c.spend)}</td><td className={td}>{c.points}</td><td className={td}>{c.rewards_available}</td>
              <td className={td}>{c.status === 'active' ? <Badge className="border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300">Active</Badge> : <Badge className="border-danger/40 text-danger">Suspended</Badge>}</td>
            </tr>))}</tbody>
        </TableWrap>
      )}
      {open && <Detail id={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

type Detail = {
  profile: { user_id: string; full_name: string; email: string; phone: string | null; country: string | null; birthday: string | null; anonymised_at: string | null; status: string; suspended_reason: string | null; tier_key: string; tier_override: boolean; created_at: string; marketing_opt_in: boolean }
  tier: { name: string } | null; points: number
  bookings: { id: string; reference: string; status: string; check_in: string; check_out: string; total: number; paid: number; discount: number }[]
  rewards: { id: string; code: string; name: string; status: string; issued_at: string; expires_at: string | null }[]
  activity: { kind: string; detail: string | null; created_at: string }[]
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const { can } = usePermissions()
  const q = useQuery({ queryKey: ['admin-customer', id], queryFn: () => adminRpc<Detail>('admin_customer_detail', { p_user: id }) })
  const tiers = useQuery({ queryKey: ['tiers-admin'], queryFn: async () => { const { data, error } = await sb().from('membership_tiers').select('*').order('rank'); if (error) throw error; return data as Tier[] } })
  const offers = useQuery({ queryKey: ['offers-admin'], queryFn: async () => { const { data, error } = await sb().from('promotional_offers').select('id, name, active').order('name'); if (error) throw error; return data as Pick<Offer, 'id' | 'name' | 'active'>[] } })
  const [pts, setPts] = useState(''); const [ptsNote, setPtsNote] = useState(''); const [reason, setReason] = useState(''); const [offer, setOffer] = useState('')
  const refresh = () => { qc.invalidateQueries({ queryKey: ['admin-customer', id] }); qc.invalidateQueries({ queryKey: ['admin-customers'] }) }
  const run = (fn: () => Promise<unknown>, ok: string) => ({ mutationFn: fn, onSuccess: () => { toast.success(ok); refresh() }, onError: (e: unknown) => toast.error(errMessage(e)) })
  const status = useMutation(run(() => adminRpc('set_customer_status', { p_user: id, p_status: q.data!.profile.status === 'active' ? 'suspended' : 'active', p_reason: reason }), 'Saved'))
  const tier = useMutation({ ...run(() => Promise.resolve(), 'Tier saved'), mutationFn: (key: string) => adminRpc('set_customer_tier', { p_user: id, p_tier: key || null }) })
  const points = useMutation(run(() => adminRpc('adjust_loyalty_points', { p_user: id, p_points: Number(pts), p_note: ptsNote }).then(() => { setPts(''); setPtsNote('') }), 'Points adjusted'))
  const anon = useMutation(run(() => adminRpc('anonymise_customer', { p_user: id }), 'Personal details removed'))
  const issue = useMutation(run(() => adminRpc('admin_issue_reward', { p_user: id, p_offer: offer, p_note: 'Issued by staff' }).then(() => setOffer('')), 'Reward issued'))
  const d = q.data
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={d?.profile.full_name ?? 'Customer'} description={d ? `${d.profile.email} · joined ${formatDate(d.profile.created_at.slice(0, 10))}` : undefined}>
        {q.isLoading && <Skeleton className="h-48" />}
        {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
        {d && (
          <div className="grid gap-5 text-sm">
            <dl className="grid grid-cols-2 gap-3">
              <div><dt className="text-muted-foreground">Tier</dt><dd>{d.tier?.name}{d.profile.tier_override && <span className="text-xs text-muted-foreground"> (set by staff)</span>}</dd></div>
              <div><dt className="text-muted-foreground">Points</dt><dd>{d.points}</dd></div>
              <div><dt className="text-muted-foreground">Phone</dt><dd>{d.profile.phone ? `+${d.profile.phone}` : '—'}</dd></div>
              <div><dt className="text-muted-foreground">Country</dt><dd>{d.profile.country || '—'}</dd></div>
              <div><dt className="text-muted-foreground">Status</dt><dd>{d.profile.status}{d.profile.suspended_reason ? `: ${d.profile.suspended_reason}` : ''}</dd></div>
              <div><dt className="text-muted-foreground">Total spend</dt><dd>{formatKES(d.bookings.reduce((s, b) => s + b.paid, 0))}</dd></div>
            </dl>
            {can('customers.manage') && (
              <section className="grid gap-3 rounded-lg border p-3" aria-label="Manage">
                <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                  <Field label="Membership tier" htmlFor="ct-tier"><Select id="ct-tier" value={d.profile.tier_override ? d.profile.tier_key : ''} disabled={tier.isPending} onChange={(e) => tier.mutate(e.target.value)}>
                    <option value="">Automatic (from stays and spend)</option>{(tiers.data ?? []).filter((t) => t.active).map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</Select></Field>
                </div>
                <div className="grid gap-2 sm:grid-cols-[6rem_1fr_auto] sm:items-end">
                  <Field label="Points (+/−)" htmlFor="ct-pts"><Input id="ct-pts" inputMode="numeric" value={pts} onChange={(e) => setPts(e.target.value)} /></Field>
                  <Field label="Reason" htmlFor="ct-note"><Input id="ct-note" value={ptsNote} onChange={(e) => setPtsNote(e.target.value)} /></Field>
                  <Button variant="outline" loading={points.isPending} disabled={!Number(pts) || ptsNote.trim().length < 3} onClick={() => points.mutate()}>Adjust</Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                  <Field label={d.profile.status === 'active' ? 'Suspend account: reason' : 'Reactivate account'} htmlFor="ct-reason">
                    {d.profile.status === 'active' ? <Input id="ct-reason" value={reason} onChange={(e) => setReason(e.target.value)} /> : <p className="py-2 text-muted-foreground">Offers and member booking are paused.</p>}</Field>
                  <Button variant={d.profile.status === 'active' ? 'danger' : 'default'} loading={status.isPending} disabled={d.profile.status === 'active' && reason.trim().length < 3} onClick={() => status.mutate()}>{d.profile.status === 'active' ? 'Suspend' : 'Reactivate'}</Button>
                </div>
              </section>
            )}
            {can('customers.manage') && !d.profile.anonymised_at && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger/30 p-3">
                <p className="max-w-md text-xs text-muted-foreground">Remove this member's personal details at their request. Bookings, payments and points stay in the records. The sign-in itself is removed separately in Supabase, Authentication, Users.</p>
                <Button size="sm" variant="danger" loading={anon.isPending} onClick={() => { if (window.confirm(`Remove all personal details for ${d.profile.full_name}? This cannot be undone.`)) anon.mutate() }}>Remove personal details</Button>
              </div>
            )}
            {can('offers.manage') && (
              <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                <Field label="Issue a reward" htmlFor="ct-offer"><Select id="ct-offer" value={offer} onChange={(e) => setOffer(e.target.value)}><option value="">Choose an offer</option>{(offers.data ?? []).filter((o) => o.active).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
                <Button variant="outline" loading={issue.isPending} disabled={!offer} onClick={() => issue.mutate()}>Issue</Button>
              </div>
            )}
            <section><h3 className="font-semibold">Bookings</h3>{d.bookings.length ? <ul className="mt-2 grid gap-1">{d.bookings.map((b) => <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2"><span>{b.reference} · {formatDate(b.check_in)} to {formatDate(b.check_out)}</span><span className="flex items-center gap-2">{formatKES(b.total)}{b.discount > 0 && <span className="text-xs text-muted-foreground">(−{formatKES(b.discount)})</span>}<StatusBadge status={b.status as BookingStatus} /></span></li>)}</ul> : <p className="mt-1 text-muted-foreground">None yet.</p>}</section>
            <section><h3 className="font-semibold">Rewards and offers</h3>{d.rewards.length ? <ul className="mt-2 grid gap-1">{d.rewards.map((r) => <li key={r.id} className="flex justify-between rounded border p-2"><span>{r.name} <span className="text-muted-foreground">· {r.code}</span></span><span className="capitalize text-muted-foreground">{r.status}{r.expires_at ? ` · to ${formatDate(r.expires_at.slice(0, 10))}` : ''}</span></li>)}</ul> : <p className="mt-1 text-muted-foreground">None.</p>}</section>
            <section><h3 className="font-semibold">Activity</h3><ul className="mt-2 grid gap-1">{d.activity.map((a, i) => <li key={i} className="flex justify-between gap-3 text-xs"><span>{a.kind.replace(/_/g, ' ')}{a.detail ? ` · ${a.detail}` : ''}</span><span className="shrink-0 text-muted-foreground">{formatDateTime(a.created_at)}</span></li>)}</ul></section>
          </div>
        )}
      </SheetContent>
    </Dialog>
  )
}
