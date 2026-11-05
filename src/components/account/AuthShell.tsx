import { Link } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { PublicLayout } from '~/components/layout/PublicLayout'
import { useBrand } from '~/lib/brand'

const FALLBACK = ['Welcome discount on your first stay', 'Member-only offers and rates', 'Your bookings and receipts in one place', 'Rewards for every completed stay']

/** Two-panel layout for sign up and sign in: a dark promotional panel and an ivory form card. Stacks on mobile. */
export function AuthShell({ title, subtitle, children, promo = true }: { title: string; subtitle?: string; children: React.ReactNode; promo?: boolean }) {
  const brand = useBrand()
  const benefits = brand.tiers.find((t) => t.key === 'standard')?.benefits.length ? brand.tiers.find((t) => t.key === 'standard')!.benefits : FALLBACK
  return (
    <PublicLayout>
      <section className={promo ? 'mx-auto grid max-w-6xl gap-0 px-4 py-8 sm:px-6 sm:py-14 lg:grid-cols-[1.05fr_1fr]' : 'mx-auto max-w-md px-4 py-10 sm:py-16'}>
        {promo && (
          <div className="relative overflow-hidden rounded-t-2xl bg-ink p-8 text-ink-foreground sm:p-12 lg:rounded-l-2xl lg:rounded-tr-none">
            <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-brand/20 blur-3xl" />
            <p className="eyebrow text-brand">Members</p>
            <h2 className="font-display mt-4 text-4xl leading-[1.05] sm:text-5xl">Stay More.<br /><em className="text-brand">Enjoy More.</em></h2>
            <p className="mt-5 max-w-md text-sm text-ink-foreground/80 sm:text-base">Create your free {brand.businessName} account and unlock exclusive accommodation offers, member-only rates and special rewards.</p>
            <ul className="mt-8 grid gap-3 text-sm">
              {benefits.map((b) => (
                <li key={b} className="flex items-start gap-3"><span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand/20 text-brand"><Check className="h-3 w-3" aria-hidden /></span>{b}</li>
              ))}
            </ul>
            {brand.tiers.length > 1 && (
              <p className="mt-8 border-t border-white/10 pt-5 text-xs uppercase tracking-[0.18em] text-ink-foreground/60">{brand.tiers.map((t) => t.name.replace(' Member', '')).join('  ·  ')}</p>
            )}
          </div>
        )}
        <div className={promo ? 'rounded-b-2xl border bg-card p-6 shadow-sm sm:p-10 lg:rounded-r-2xl lg:rounded-bl-none' : 'rounded-2xl border bg-card p-6 shadow-sm sm:p-8'}>
          <h1 className="font-display text-3xl font-medium sm:text-4xl">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p>}
          <div className="mt-6">{children}</div>
          <p className="mt-6 text-center text-xs text-muted-foreground"><Link to="/" className="hover:underline">Back to {brand.businessName}</Link></p>
        </div>
      </section>
    </PublicLayout>
  )
}
