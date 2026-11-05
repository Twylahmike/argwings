import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { adminRpc, type Overview } from '~/lib/membership-admin'
import { requireRole } from '~/lib/auth'
import { formatKES } from '~/lib/money'
import { ErrorState, PageHeader, Skeleton, Stat } from '~/components/ui/misc'
import { Select } from '~/components/ui/form'

export const Route = createFileRoute('/admin/membership')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: MembershipOverview,
})

function MembershipOverview() {
  const [days, setDays] = useState('30')
  const q = useQuery({ queryKey: ['membership-overview', days], queryFn: () => adminRpc<Overview>('membership_overview', { p_days: Number(days) }) })
  const o = q.data
  const max = Math.max(1, ...(o?.by_tier.map((t) => t.members) ?? [1]))
  return (
    <div>
      <PageHeader title="Membership overview" description="Every number here is counted from real accounts, offers and bookings."
        actions={<Select aria-label="New registrations period" className="w-44" value={days} onChange={(e) => setDays(e.target.value)}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 12 months</option></Select>} />
      {q.isLoading && <Skeleton className="h-48" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {o && <>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Registered customers" value={o.registered} hint="Everyone who signed up" />
          <Stat label="Verified accounts" value={o.verified} hint={`${o.registered ? Math.round((o.verified / o.registered) * 100) : 0}% of registered`} />
          <Stat label="New registrations" value={o.new_registrations} hint={`Verified in the last ${days} days`} />
          <Stat label="Active members" value={o.active_members} hint={o.suspended ? `${o.suspended} suspended` : undefined} />
          <Stat label="Welcome offers issued" value={o.welcome_issued} />
          <Stat label="Offers redeemed" value={o.offers_redeemed} hint={`of ${o.offers_issued} issued`} />
          <Stat label="Discount value granted" value={formatKES(o.discount_value)} hint="Live bookings only" />
          <Stat label="Member bookings" value={o.member_bookings} hint={`${formatKES(o.member_revenue)} paid`} />
          <Stat label="Guest bookings" value={o.guest_bookings} hint="Booked without an account" />
          <Stat label="Returning customers" value={`${o.returning_rate}%`} hint={`${o.returning_customers} of ${o.booked_customers} customers booked more than once`} />
        </div>
        <section className="mt-8" aria-labelledby="bt"><h2 id="bt" className="font-display text-2xl">Members by tier</h2>
          <ul className="mt-3 grid max-w-xl gap-2">{o.by_tier.map((t) => (
            <li key={t.key} className="grid grid-cols-[8rem_1fr_3rem] items-center gap-3 text-sm"><span>{t.name}</span><span className="h-3 rounded bg-muted"><span className="block h-3 rounded bg-brand" style={{ width: `${(t.members / max) * 100}%` }} /></span><b className="text-right">{t.members}</b></li>))}</ul>
        </section>
      </>}
    </div>
  )
}
