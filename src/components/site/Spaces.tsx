import { Link } from '@tanstack/react-router'
import { Building2, MapPin } from 'lucide-react'
import { formatKES } from '~/lib/money'
import { fromRate } from '~/lib/pricing'
import type { PropertyWithUnits } from '~/lib/public-api'
import { coverOrPlaceholder } from '~/lib/placeholder-images'
import { buttonVariants } from '~/components/ui/button'
import { EmptyState } from '~/components/ui/misc'
import { useReveal } from '~/lib/use-reveal'
import { cn } from '~/lib/utils'

function Row({ p, idx }: { p: PropertyWithUnits; idx: number }) {
  const ref = useReveal<HTMLDivElement>()
  const img = coverOrPlaceholder(p.cover_image, idx)
  const from = p.units.length ? Math.min(...p.units.map(fromRate)) : null
  const featured = idx === 0
  return (
    <div ref={ref} className="reveal grid items-center gap-6 md:grid-cols-2 md:gap-12">
      <Link to="/properties/$slug" params={{ slug: p.slug }} className={cn('group relative block overflow-hidden rounded-2xl shadow-lg', idx % 2 === 1 && 'md:order-2')} aria-label={`${p.name}: view and book`}>
        {img
          ? <img src={img.src} alt={img.placeholder ? (img.alt ?? '') : p.name} className="aspect-[4/3] w-full object-cover transition-transform duration-700 group-hover:scale-105" loading={idx < 1 ? 'eager' : 'lazy'} width={1200} height={900} />
          : <div className="aspect-[4/3] w-full bg-muted" />}
        {featured && <span className="eyebrow absolute left-4 top-4 rounded-full bg-background/90 px-3 py-1.5 text-brand">Featured stay</span>}
      </Link>
      <div>
        <h3 className="font-display text-4xl font-medium md:text-5xl">{p.name}</h3>
        <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground"><MapPin className="h-4 w-4" aria-hidden /> {p.area || p.city}</p>
        {(p.tagline || p.description) && <p className="mt-4 line-clamp-4 text-muted-foreground">{p.tagline || p.description}</p>}
        {p.amenities?.length > 0 && (
          <ul className="mt-5 flex flex-wrap gap-2">
            {p.amenities.slice(0, 6).map((a) => <li key={a} className="rounded-full border bg-card px-3 py-1 text-xs">{a}</li>)}
          </ul>
        )}
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
          {from != null && <p><span className="text-sm text-muted-foreground">from </span><b className="font-display text-2xl">{formatKES(from)}</b><span className="text-sm text-muted-foreground"> / night</span></p>}
          <Link to="/properties/$slug" params={{ slug: p.slug }} className={cn(buttonVariants({ size: 'lg' }), 'rounded-full px-7')}>View &amp; book</Link>
        </div>
      </div>
    </div>
  )
}

export function Spaces({ properties }: { properties: PropertyWithUnits[] }) {
  return (
    <section id="properties" className="scroll-mt-16 bg-background px-4 py-20 sm:px-6 md:py-28" aria-labelledby="props-h">
      <div className="mx-auto max-w-7xl">
        <div className="mb-14 text-center md:mb-20">
          <p className="eyebrow mb-3 text-brand">Our properties</p>
          <h2 id="props-h" className="section-title draw-underline text-brand">Find your place</h2>
          <p className="mx-auto mt-8 max-w-xl text-muted-foreground">Pick a place, check your dates and see the full price up front.</p>
        </div>
        {properties.length === 0
          ? <EmptyState icon={Building2} title="Properties are coming soon" description="Please check back shortly." />
          : <div className="space-y-20 md:space-y-28">{properties.map((p, idx) => <Row key={p.id} p={p} idx={idx} />)}</div>}
      </div>
    </section>
  )
}
