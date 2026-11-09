import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useBrand } from '~/lib/brand'
import { formatDate } from '~/lib/dates'
import { formatKES } from '~/lib/money'
import { Skeleton } from '~/components/ui/misc'
import { useCustomer } from './account'

export const Route = createFileRoute('/account/rewards')({ component: Rewards })

type Tx = { id: string; kind: string; points: number; note: string | null; created_at: string }

function Rewards() {
  const c = useCustomer()
  const brand = useBrand()
  const tx = useQuery({
    queryKey: ['my-loyalty'],
    queryFn: async () => { const { sb } = await import('~/lib/supabase'); const { data, error } = await sb().from('loyalty_transactions').select('id, kind, points, note, created_at').order('created_at', { ascending: false }).limit(50); if (error) throw error; return data as Tx[] },
  })
  if (!c) return <Skeleton className="h-64" />
  const mine = brand.tiers.find((t) => t.key === c.tier.key)
  return (
    <div className="grid gap-6">
      <h1 className="font-display text-4xl">Rewards</h1>
      <div className="rounded-2xl bg-ink p-6 text-ink-foreground">
        <p className="eyebrow text-brand">Your tier</p>
        <p className="font-display mt-2 text-4xl">{c.tier.name}</p>
        {c.tier.expires_at && <p className="mt-1 text-xs text-ink-foreground/70">Current term runs to {formatDate(c.tier.expires_at.slice(0, 10))}</p>}
        <ul className="mt-4 grid gap-2 text-sm">{(mine?.benefits ?? c.tier.benefits).map((b) => <li key={b} className="flex items-center gap-2"><Check className="h-4 w-4 text-brand" aria-hidden />{b}</li>)}</ul>
        <p className="mt-5 border-t border-white/10 pt-4 text-sm text-ink-foreground/80">
          {c.next_tier ? `Next: ${c.next_tier.name}. ${c.next_tier.stays_needed > 0 ? `${c.next_tier.stays_needed} more completed stay(s)` : 'Stays requirement met'}${c.next_tier.spend_needed > 0 ? `, ${formatKES(c.next_tier.spend_needed)} more spend` : ''}.` : 'You are at the highest tier.'}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border bg-card p-5"><p className="text-xs uppercase tracking-wider text-muted-foreground">Points</p><p className="font-display mt-1 text-3xl">{c.points.toLocaleString('en-KE')}</p>{c.points_redeem?.enabled ? <p className="mt-1 text-xs text-muted-foreground">Worth {formatKES(c.points * c.points_redeem.kes_per_point)} off your next stay (up to {c.points_redeem.max_percent}% of the accommodation charge). Use them when you book.</p> : <p className="mt-1 text-xs text-muted-foreground">Earned on every completed stay.</p>}</div>
        <div className="rounded-xl border bg-card p-5"><p className="text-xs uppercase tracking-wider text-muted-foreground">Completed stays</p><p className="font-display mt-1 text-3xl">{c.completed_stays}</p></div>
        <div className="rounded-xl border bg-card p-5"><p className="text-xs uppercase tracking-wider text-muted-foreground">Total spent</p><p className="font-display mt-1 text-3xl">{formatKES(c.total_spend)}</p></div>
      </div>
      <section aria-labelledby="hist"><h2 id="hist" className="font-display text-2xl">Points history</h2>
        {tx.isLoading && <Skeleton className="mt-3 h-24" />}
        {tx.data && !tx.data.length && <p className="mt-3 rounded-lg border bg-card p-4 text-sm text-muted-foreground">Points are earned when a stay is completed.</p>}
        <ul className="mt-3 grid gap-2 text-sm">{(tx.data ?? []).map((t) => <li key={t.id} className="flex items-center justify-between rounded-lg border bg-card p-3"><span>{t.note ?? t.kind}<span className="text-muted-foreground"> · {formatDate(t.created_at.slice(0, 10))}</span></span><b className={t.points < 0 ? 'text-danger' : ''}>{t.points > 0 ? '+' : ''}{t.points}</b></li>)}</ul>
      </section>
    </div>
  )
}
