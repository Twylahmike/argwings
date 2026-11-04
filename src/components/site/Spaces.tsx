import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Building2, CalendarDays, ChefHat, Car, Dumbbell, MapPin, ShieldCheck, Waves, Wifi, type LucideIcon } from 'lucide-react'
import { formatKES } from '~/lib/money'
import { fromRate } from '~/lib/pricing'
import { mapsLink, type PropertyWithUnits } from '~/lib/public-api'
import { photoSet } from '~/lib/stay-photos'
import { propertyImages } from '~/lib/gallery'
import { useWhatsApp } from '~/lib/contact'
import { useBrand } from '~/lib/brand'
import { EmptyState } from '~/components/ui/misc'
import { useReveal } from '~/lib/use-reveal'
import { cn } from '~/lib/utils'

const ICONS: Array<[RegExp, LucideIcon]> = [[/wi-?fi/i, Wifi], [/kitchen/i, ChefHat], [/secur/i, ShieldCheck], [/park/i, Car], [/pool/i, Waves], [/gym/i, Dumbbell]]

function Showcase({ p, idx }: { p: PropertyWithUnits; idx: number }) {
  const ref = useReveal<HTMLDivElement>()
  const wa = useWhatsApp()
  const real = propertyImages(p)
  const images = real.length ? real.map((src) => ({ src, alt: p.name })) : photoSet(idx, 4, p.slug).map((x) => ({ src: x.src, alt: x.alt }))
  const [i, setI] = useState(0)
  useEffect(() => {
    if (images.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = setInterval(() => setI((v) => (v + 1) % images.length), 4000)
    return () => clearInterval(t)
  }, [images.length])
  const from = p.units.length ? Math.min(...p.units.map(fromRate)) : null
  const featured = idx === 0
  const amenities = [...new Set([...(p.amenities ?? []), ...p.units.flatMap((u) => u.amenities ?? [])])].slice(0, 8)
  const mapQuery = p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : [p.address, p.area, p.city].filter(Boolean).join(', ')
  const hasMap = !!mapQuery
  const longStay = wa(`Hi, I'm interested in long stay discounts at ${p.name}.`)
  return (
    <div ref={ref} className="reveal">
      {featured && <div className="mb-6 text-center"><span className="inline-block rounded-full bg-brand/10 px-4 py-1.5 text-xs uppercase tracking-widest text-brand">&#9733; Featured stay</span></div>}
      <div className={cn('grid items-center gap-10 md:grid-cols-2', idx % 2 === 1 && 'md:[&>div:first-child]:order-2')}>
        <div className={cn('group relative overflow-hidden rounded-2xl shadow-2xl', featured ? 'aspect-[4/3] ring-2 ring-brand/20 md:aspect-[5/4]' : 'aspect-[4/3]')}>
          {images.length === 0 && <div className="absolute inset-0 grid place-items-center bg-muted text-muted-foreground">No images yet</div>}
          {images.map((im, k) => <img key={im.src} src={im.src} alt={im.alt} loading={idx === 0 && k === 0 ? 'eager' : 'lazy'} className={cn('absolute inset-0 h-full w-full object-cover transition-opacity duration-1000', i === k ? 'opacity-100' : 'opacity-0')} />)}
          <div className="absolute left-4 top-4 flex items-center gap-2 rounded-full bg-ink/60 px-3 py-1.5 text-xs text-ink-foreground backdrop-blur">
            <span className="animate-pulse-dot h-2 w-2 rounded-full bg-brand-glow" aria-hidden /> Live view
          </div>
          {images.length > 1 && (
            <div className="absolute bottom-4 right-4 flex gap-1.5">
              {images.map((_, k) => <button key={k} type="button" onClick={() => setI(k)} aria-label={`Show photo ${k + 1}`} className={cn('h-2 rounded-full transition-all', i === k ? 'w-6 bg-white' : 'w-2 bg-white/50')} />)}
            </div>
          )}
        </div>
        <div>
          {p.tagline && <span className={cn('mb-4 inline-block rounded-full px-4 py-1.5 text-xs font-medium', /luxury/i.test(p.tagline) ? 'bg-brand text-brand-foreground' : 'bg-olive text-white')}>{p.tagline}</span>}
          <h3 className={cn('mb-4 font-display font-medium', featured ? 'text-5xl md:text-6xl' : 'text-4xl md:text-5xl')}>{p.name}</h3>
          <p className="mb-2 flex items-center gap-1.5 text-sm text-muted-foreground"><MapPin className="h-4 w-4 text-brand" aria-hidden /> {p.area || p.city}</p>
          {p.description && <p className="mb-6 leading-relaxed text-muted-foreground">{p.description}</p>}
          {amenities.length > 0 && (
            <ul className="mb-6 flex flex-wrap gap-3">
              {amenities.map((a, k) => {
                const Icon = ICONS.find(([re]) => re.test(a))?.[1]
                return <li key={a} className="hover-lift animate-fade-up flex items-center gap-2 rounded-full border bg-card px-3 py-2 text-sm" style={{ animationDelay: `${k * 0.08}s` }}>{Icon ? <Icon className="h-4 w-4 text-brand" aria-hidden /> : <span aria-hidden>&bull;</span>}{a}</li>
              })}
            </ul>
          )}
          {from != null && (
            <div className="mb-6">
              <div className="flex flex-wrap items-baseline gap-3"><span className="font-display text-5xl font-bold text-brand">{formatKES(from)}</span><span className="text-muted-foreground">/ night</span></div>
              {longStay && <a href={longStay} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-muted-foreground transition hover:text-brand">&#128172; Ask about long stay discounts &rarr;</a>}
            </div>
          )}
          <Link to="/properties/$slug" params={{ slug: p.slug }} className="btn-brand inline-flex items-center justify-center gap-2 rounded-full px-7 py-3.5 text-sm font-medium"><CalendarDays className="h-4 w-4" aria-hidden /> Book direct</Link>
          {hasMap && (
            <div className="mt-6">
              <p className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-widest text-muted-foreground"><MapPin className="h-3.5 w-3.5 text-brand" aria-hidden /> {p.area || p.city}</p>
              <iframe title={`Map: ${p.name}`} src={`https://www.google.com/maps?q=${encodeURIComponent(mapQuery)}&output=embed`} loading="lazy" className="h-48 w-full rounded-xl border-0" referrerPolicy="no-referrer" />
              <a href={mapsLink(p)} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-brand hover:underline">Get directions &rarr;</a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function Spaces({ properties, page = false }: { properties: PropertyWithUnits[]; page?: boolean }) {
  const H = page ? 'h1' : 'h2'
  const { site } = useBrand()
  return (
    <section id="properties" className="scroll-mt-16 bg-background px-4 py-24 sm:px-6" aria-labelledby="props-h">
      <div className="mx-auto max-w-7xl">
        <div className="mb-16 text-center">
          <p className="eyebrow mb-3 text-muted-foreground">Our spaces</p>
          <H id="props-h" className="section-title draw-underline text-brand">Short &amp; long-term stays</H>
          <p className="mx-auto mt-8 max-w-xl text-muted-foreground">{site.location ? `In ${site.location}, d` : 'D'}esigned to feel like home, the moment you arrive.</p>
        </div>
        {properties.length === 0
          ? <EmptyState icon={Building2} title="Properties are coming soon" description="Please check back shortly." />
          : <div className="space-y-28">{properties.map((p, idx) => <Showcase key={p.id} p={p} idx={idx} />)}</div>}
      </div>
    </section>
  )
}
