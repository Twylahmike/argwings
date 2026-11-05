import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Gift, Sparkles } from 'lucide-react'
import { rpc, describeOffer, type MyBooking, type MyReward, type OpenOffer } from '~/lib/customer'
import { formatDate } from '~/lib/dates'
import { formatKES } from '~/lib/money'
import { todayNairobi } from '~/lib/dates'
import { StatusBadge } from '~/components/ui/badge'
import { Skeleton } from '~/components/ui/misc'
import { Button } from '~/components/ui/button'
import { useCustomer } from './account'
import type { BookingStatus } from '~/lib/types'

export const Route = createFileRoute('/account/')({ component: Overview })

export const isLive = (b: MyBooking) => ['pending', 'confirmed', 'checked_in'].includes(b.status)

function Overview() {
  const c = useCustomer()
  const search = Route.useSearch() as { welcome?: string }
  const bookings = useQuery({ queryKey: ['my-bookings'], queryFn: () => rpc<MyBooking[]>('my_bookings') })
  const rewards = useQuery({ queryKey: ['my-rewards'], queryFn: () => rpc<MyReward[]>('my_rewards') })
  const open = useQuery({ queryKey: ['my-open-offers'], queryFn: () => rpc<OpenOffer[]>('my_open_offers') })
  const today = todayNairobi()
  const all = bookings.data ?? []
  const upcoming = all.filter((b) => isLive(b) && b.check_out >= today).sort((a, b) => a.check_in.localeCompare(b.check_in))
  const recent = all.slice(0, 3)
  const available = (rewards.data ?? []).filter((r) => r.status === 'available')
  if (!c) return <Skeleton className="h-64" />
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="font-display text-4xl">Welcome, {c.full_name.split(' ')[0]}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{c.tier.name} · member since {formatDate(c.member_since.slice(0, 10))}</p>
      </div>
      {(search.welcome === '1' || (available.length > 0 && c.completed_stays === 0 && all.length === 0)) && available[0] && (
        <div className="rounded-2xl bg-ink p-6 text-ink-foreground">
          <p className="eyebrow text-brand">Your welcome offer is ready</p>
          <p className="font-display mt-2 text-3xl">{available[0].name}</p>
          <p className="mt-2 text-sm text-ink-foreground/80">{describeOffer(available[0])}. Code <b className="tracking-wider">{available[0].code}</b>{available[0].expires_at ? ` · use by ${formatDate(available[0].expires_at.slice(0, 10))}` : ''}. It is applied for you at checkout.</p>
          <Button asChild className="mt-4"><Link to="/search">Find a place to stay</Link></Button>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Tile label="Membership" value={c.tier.name.replace(' Member', '')} hint={c.next_tier ? `${c.next_tier.stays_needed} more stay(s) or ${formatKES(c.next_tier.spend_needed)} to ${c.next_tier.name.replace(' Member', '')}` : 'Top tier'} />
        <Tile label="Available offers" value={String(available.length + (open.data?.length ?? 0))} hint="Applied at checkout" />
        <Tile label="Points" value={c.points.toLocaleString('en-KE')} hint={`${c.completed_stays} completed stay${c.completed_stays === 1 ? '' : 's'}`} />
      </div>
      <section aria-labelledby="up">
        <h2 id="up" className="font-display text-2xl">Upcoming reservation</h2>
        {bookings.isLoading ? <Skeleton className="mt-3 h-24" /> : upcoming[0] ? <BookingLine b={upcoming[0]} className="mt-3" /> : (
          <p className="mt-3 rounded-lg border bg-card p-4 text-sm text-muted-foreground">No upcoming stays yet. <Link to="/search" className="font-medium text-foreground underline">Find your next stay</Link>.</p>
        )}
      </section>
      <section aria-labelledby="rec">
        <div className="flex items-end justify-between"><h2 id="rec" className="font-display text-2xl">Recent bookings</h2><Link to="/account/bookings" search={{ tab: 'all' }} className="text-sm underline">All bookings</Link></div>
        <div className="mt-3 grid gap-3">{recent.length ? recent.map((b) => <BookingLine key={b.id} b={b} />) : <p className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">Your bookings will appear here.</p>}</div>
      </section>
      <section aria-labelledby="acc" className="rounded-xl border bg-card p-5 text-sm">
        <h2 id="acc" className="font-display text-2xl">Account information</h2>
        <dl className="mt-3 grid gap-2 sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Name</dt><dd>{c.full_name}</dd></div>
          <div><dt className="text-muted-foreground">Email</dt><dd>{c.email}</dd></div>
          <div><dt className="text-muted-foreground">Phone</dt><dd>{c.phone ? `+${c.phone}` : 'Not added yet'}</dd></div>
          <div><dt className="text-muted-foreground">Country</dt><dd>{c.country || 'Not added yet'}</dd></div>
        </dl>
        <Link to="/account/profile" className="mt-3 inline-block underline">Edit profile</Link>
      </section>
      <p className="flex items-center gap-2 text-xs text-muted-foreground"><Gift className="h-3.5 w-3.5" aria-hidden /><Sparkles className="h-3.5 w-3.5" aria-hidden />Offers and points are recorded against your account and shown here exactly as we hold them.</p>
    </div>
  )
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="rounded-xl border bg-card p-5"><p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p><p className="font-display mt-1 text-3xl">{value}</p>{hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}</div>
}

export function paymentLabel(b: MyBooking): string {
  if (['cancelled', 'expired', 'no_show'].includes(b.status)) return 'No payment due'
  if (b.balance === 0 && b.total > 0) return 'Paid in full'
  if (b.paid > 0) return `Balance ${formatKES(b.balance)}`
  return `Unpaid · ${formatKES(b.total)}`
}

export function BookingLine({ b, className = '' }: { b: MyBooking; className?: string }) {
  return (
    <Link to="/booking/$token" params={{ token: b.public_token }} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 transition-colors hover:bg-muted/50 ${className}`}>
      <div className="min-w-0"><p className="font-medium">{b.property} · {b.unit}</p><p className="text-sm text-muted-foreground">{formatDate(b.check_in)} to {formatDate(b.check_out)} · {b.reference}</p></div>
      <div className="flex items-center gap-3 text-sm"><span className="text-muted-foreground">{paymentLabel(b)}</span><StatusBadge status={b.status as BookingStatus} /></div>
    </Link>
  )
}
