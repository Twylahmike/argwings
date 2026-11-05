import { Link } from '@tanstack/react-router'
import { Gift, Sparkles, Star } from 'lucide-react'
import { useBrand } from '~/lib/brand'

/** "Stay More. Enjoy More." Invitation to join the free membership programme. */
export function MembershipPromo() {
  const brand = useBrand()
  const perks = [
    { icon: Gift, title: 'Welcome offer', text: 'A discount on your first eligible booking, added to your account the moment you verify your email.' },
    { icon: Star, title: 'Member-only rates', text: 'Exclusive accommodation offers and seasonal promotions you will not find on the public site.' },
    { icon: Sparkles, title: 'Rewards that grow', text: 'Earn points on every stay and move up through the tiers for better benefits.' },
  ]
  return (
    <section className="bg-ink py-20 text-ink-foreground sm:py-28" aria-labelledby="join-title">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <p className="eyebrow text-brand">{brand.businessName} Members</p>
        <h2 id="join-title" className="section-title mt-4">Stay More. <em className="text-brand">Enjoy More.</em></h2>
        <p className="mt-5 max-w-2xl text-ink-foreground/80">Create your free {brand.businessName} account and unlock exclusive accommodation offers, member-only rates and special rewards.</p>
        <div className="mt-10 grid gap-5 sm:grid-cols-3">
          {perks.map((p) => (
            <div key={p.title} className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-brand/15 text-brand"><p.icon className="h-5 w-5" aria-hidden /></span>
              <h3 className="mt-4 text-xl">{p.title}</h3>
              <p className="mt-2 text-sm text-ink-foreground/70">{p.text}</p>
            </div>
          ))}
        </div>
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link to="/join" className="btn-brand inline-flex h-12 items-center rounded-full px-8 text-sm font-semibold uppercase tracking-wider">Join for free</Link>
          <Link to="/login" search={{}} className="text-sm underline underline-offset-4 hover:opacity-80">Already a member? Sign in</Link>
        </div>
      </div>
    </section>
  )
}
