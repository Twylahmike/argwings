import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Check, Gift, Sparkles, Star } from 'lucide-react'
import { useBrand } from '~/lib/brand'
import { hasStoredSession } from '~/lib/customer'

/** Visitors who are already signed in do not need the invitation. Checked after mount so the server and browser render the same HTML. */
export function useShowInvitation(): boolean {
  const brand = useBrand()
  const [member, setMember] = useState(false)
  useEffect(() => setMember(hasStoredSession()), [])
  return brand.registrationEnabled && !member
}

const BENEFITS = [
  'Exclusive member-only accommodation offers',
  'Welcome discount on eligible first bookings',
  'Special seasonal promotions',
  'Birthday rewards',
  'Returning guest offers',
  'Easier reservation management',
  'Personal booking history',
  'Priority offers and selected VIP privileges',
]

/** "STAY MORE. ENJOY MORE." Full invitation for the home page. Membership is free and never required to book. */
export function MembershipPromo() {
  const brand = useBrand()
  if (!brand.registrationEnabled) return null
  const perks = [
    { icon: Gift, title: 'A welcome gift', text: 'A discount on your first eligible booking, added to your account when you verify your email.' },
    { icon: Star, title: 'Member-only rates', text: 'Exclusive offers and seasonal promotions you will not find on the public site.' },
    { icon: Sparkles, title: 'Rewards that grow', text: 'Birthday rewards, returning-guest offers and better benefits as you stay with us.' },
  ]
  return (
    <section className="bg-ink py-20 text-ink-foreground sm:py-28" aria-labelledby="join-title">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <p className="eyebrow text-brand">{brand.businessName} Members</p>
        <h2 id="join-title" className="section-title mt-4 uppercase">Stay More. <em className="text-brand">Enjoy More.</em></h2>
        <p className="mt-5 max-w-2xl text-ink-foreground/80">Join {brand.businessName} for free and unlock exclusive accommodation offers, special member discounts and rewards designed to make every stay more rewarding.</p>
        <div className="mt-10 grid gap-5 sm:grid-cols-3">
          {perks.map((p) => (
            <div key={p.title} className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-brand/15 text-brand"><p.icon className="h-5 w-5" aria-hidden /></span>
              <h3 className="mt-4 text-xl">{p.title}</h3>
              <p className="mt-2 text-sm text-ink-foreground/70">{p.text}</p>
            </div>
          ))}
        </div>
        <ul className="mt-8 grid gap-x-8 gap-y-2 text-sm text-ink-foreground/80 sm:grid-cols-2">
          {BENEFITS.map((b) => <li key={b} className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />{b}</li>)}
        </ul>
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link to="/join" className="btn-brand inline-flex h-12 items-center rounded-full px-8 text-sm font-semibold uppercase tracking-wider">Join for free</Link>
          <Link to="/login" search={{}} className="text-sm underline underline-offset-4 hover:opacity-80">Already a member? Sign in</Link>
        </div>
        <p className="mt-6 text-xs text-ink-foreground/50">Membership is free and optional. You can always book as a guest.</p>
      </div>
    </section>
  )
}

/** A slim, quiet invitation for listing, booking and footer areas. Never blocks the booking flow. */
export function MembershipNudge({ className = '', tone = 'light' }: { className?: string; tone?: 'light' | 'dark' }) {
  const show = useShowInvitation()
  if (!show) return null
  const dark = tone === 'dark'
  return (
    <aside aria-label="Free membership" className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-xl border px-4 py-3 text-sm ${dark ? 'border-white/10 bg-white/[0.04] text-ink-foreground' : 'border-brand/30 bg-brand/5'} ${className}`}>
      <p><span className="font-display text-lg text-brand">Stay More. Enjoy More.</span> <span className={dark ? 'opacity-80' : 'text-muted-foreground'}>Join free for member offers and a welcome discount. No account needed to book.</span></p>
      <p className="flex items-center gap-4 whitespace-nowrap">
        <Link to="/join" className="font-semibold uppercase tracking-wider text-brand hover:underline">Join for free</Link>
        <Link to="/login" search={{}} className="underline underline-offset-4 opacity-80 hover:opacity-100">Already a member? Sign in</Link>
      </p>
    </aside>
  )
}
