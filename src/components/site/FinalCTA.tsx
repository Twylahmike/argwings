import { Link } from '@tanstack/react-router'
import { useBrand } from '~/lib/brand'
import { useWhatsApp } from '~/lib/contact'
import { mapsLink, type PropertyWithUnits } from '~/lib/public-api'

import { buttonVariants } from '~/components/ui/button'
import { cn } from '~/lib/utils'

// Deterministic (no Math.random) so server and client render the same markup.
const particles = Array.from({ length: 18 }, (_, i) => ({ left: (i * 37) % 100, dur: 10 + ((i * 7) % 12), delay: (i * 5) % 14 }))

export function FinalCTA({ properties }: { properties: PropertyWithUnits[] }) {
  const { businessName, site } = useBrand()
  const wa = useWhatsApp()
  const waHref = wa('Hi, I would like to book a stay.')
  const places = properties.filter((p) => p.lat != null || p.address).slice(0, 2)
  return (
    <section className="relative isolate overflow-hidden bg-brand px-4 py-20 text-brand-foreground sm:px-6 md:py-28" aria-labelledby="cta-h">
      {particles.map((p, i) => <span key={i} className="particle" aria-hidden style={{ left: `${p.left}%`, animationDuration: `${p.dur}s`, animationDelay: `${p.delay}s` }} />)}
      <div className="relative mx-auto max-w-4xl text-center">
        <h2 id="cta-h" className="font-display text-5xl font-medium md:text-7xl">Ready for your stay?</h2>
        <p className="mx-auto mt-6 max-w-xl opacity-85">{site.location ? `${businessName} in ${site.location}. ` : ''}Check your dates and book in minutes.</p>
        <div className="mt-10 flex flex-col flex-wrap justify-center gap-3 sm:flex-row">
          <Link to="/search" className={cn(buttonVariants({ size: 'lg' }), 'rounded-full bg-white px-8 text-ink hover:bg-white/90')}>Book direct</Link>
          {waHref && <a href={waHref} target="_blank" rel="noreferrer" className={cn(buttonVariants({ size: 'lg', variant: 'outline' }), 'rounded-full border-white/40 bg-transparent px-8 text-brand-foreground hover:bg-white/10')}>Ask on WhatsApp</a>}
          {places.map((p) => <a key={p.id} href={mapsLink(p)} target="_blank" rel="noreferrer" className={cn(buttonVariants({ size: 'lg', variant: 'outline' }), 'rounded-full border-white/40 bg-transparent px-8 text-brand-foreground hover:bg-white/10')}>Directions to {p.name}</a>)}
        </div>
      </div>
    </section>
  )
}
