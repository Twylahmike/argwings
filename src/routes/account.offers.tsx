import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { rpc, describeOffer, type MyReward, type OpenOffer } from '~/lib/customer'
import { formatDate } from '~/lib/dates'
import { formatKES } from '~/lib/money'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { EmptyState, ErrorState, Skeleton } from '~/components/ui/misc'

export const Route = createFileRoute('/account/offers')({ component: Offers })

export const rewardStatus: Record<MyReward['status'], string> = { available: 'Available', redeemed: 'Used', expired: 'Expired', void: 'Withdrawn' }

function Offers() {
  const rewards = useQuery({ queryKey: ['my-rewards'], queryFn: () => rpc<MyReward[]>('my_rewards') })
  const open = useQuery({ queryKey: ['my-open-offers'], queryFn: () => rpc<OpenOffer[]>('my_open_offers') })
  const mine = rewards.data ?? []
  const live = mine.filter((r) => r.status === 'available')
  const past = mine.filter((r) => r.status !== 'available')
  return (
    <div className="grid gap-6">
      <div><h1 className="font-display text-4xl">My offers</h1><p className="mt-1 text-sm text-muted-foreground">Offers are applied at checkout when you book while signed in. Each one is checked against its conditions at that moment.</p></div>
      {(rewards.isLoading || open.isLoading) && <Skeleton className="h-40" />}
      {(rewards.error || open.error) && <ErrorState error={rewards.error ?? open.error} retry={() => { void rewards.refetch(); void open.refetch() }} />}
      {rewards.data && !live.length && !(open.data?.length) && <EmptyState title="No offers right now" description="New member offers appear here as soon as they are available." action={<Button asChild><Link to="/search">Find a place</Link></Button>} />}
      <div className="grid gap-4 sm:grid-cols-2">
        {live.map((r) => (
          <article key={r.id} className="rounded-xl border-2 border-brand/50 bg-card p-5">
            <div className="flex items-center justify-between gap-2"><Badge className="border-brand/50 text-brand">{r.audience === 'welcome' ? 'Welcome offer' : r.audience === 'birthday' ? 'Birthday reward' : 'Member offer'}</Badge><span className="text-xs text-muted-foreground">Code {r.code}</span></div>
            <h2 className="font-display mt-3 text-2xl">{r.name}</h2>
            <p className="text-sm">{describeOffer(r)}{r.min_total ? ` · stays from ${formatKES(r.min_total)}` : ''}</p>
            {r.description && <p className="mt-1 text-sm text-muted-foreground">{r.description}</p>}
            <p className="mt-3 text-xs text-muted-foreground">{r.expires_at ? `Expires ${formatDate(r.expires_at.slice(0, 10))}` : 'No expiry date'}{r.terms ? ` · ${r.terms}` : ''}</p>
          </article>
        ))}
        {(open.data ?? []).map((o) => (
          <article key={o.id} className="rounded-xl border bg-card p-5">
            <Badge>Member offer{o.min_tier ? ` · ${o.min_tier}+` : ''}</Badge>
            <h2 className="font-display mt-3 text-2xl">{o.name}</h2>
            <p className="text-sm">{describeOffer(o)}{o.min_total ? ` · stays from ${formatKES(o.min_total)}` : ''}</p>
            {o.description && <p className="mt-1 text-sm text-muted-foreground">{o.description}</p>}
            <p className="mt-3 text-xs text-muted-foreground">{o.valid_to ? `Until ${formatDate(o.valid_to)}` : 'Ongoing'}{o.used > 0 ? ` · used ${o.used}×` : ''}{o.terms ? ` · ${o.terms}` : ''}</p>
          </article>
        ))}
      </div>
      {past.length > 0 && (
        <section aria-labelledby="past"><h2 id="past" className="font-display text-2xl">Used and expired</h2>
          <ul className="mt-3 grid gap-2 text-sm">{past.map((r) => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3"><span>{r.name} <span className="text-muted-foreground">· {r.code}</span></span><span className="text-muted-foreground">{rewardStatus[r.status]}{r.redeemed_for ? ` on ${r.redeemed_for}` : ''}</span></li>)}</ul>
        </section>
      )}
    </div>
  )
}
