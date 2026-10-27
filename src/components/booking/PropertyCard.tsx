import { Link } from '@tanstack/react-router'
import { MapPin } from 'lucide-react'
import { formatKES } from '~/lib/money'
import { fromRate } from '~/lib/pricing'
import type { PropertyWithUnits } from '~/lib/public-api'

export function PropertyCard({ p, priority = false }: { p: PropertyWithUnits; priority?: boolean }) {
  const from = p.units.length ? Math.min(...p.units.map(fromRate)) : null
  return (
    <Link to="/properties/$slug" params={{ slug: p.slug }} className="group block overflow-hidden rounded-2xl border bg-card shadow-sm transition-shadow hover:shadow-md">
      {p.cover_image
        ? <img src={p.cover_image} alt={`${p.name}`} className="aspect-[4/3] w-full object-cover" loading={priority ? 'eager' : 'lazy'} fetchPriority={priority ? 'high' : undefined} width={800} height={600} />
        : <div className="aspect-[4/3] bg-muted" />}
      <div className="p-4">
        <h3 className="text-lg font-semibold group-hover:text-brand">{p.name}</h3>
        <p className="mt-0.5 flex items-center gap-1 text-sm text-muted-foreground"><MapPin className="h-3.5 w-3.5" aria-hidden /> {p.area || p.city}</p>
        {p.tagline && <p className="mt-2 line-clamp-2 text-sm">{p.tagline}</p>}
        {from != null && <p className="mt-3 text-sm"><span className="text-muted-foreground">from</span> <b>{formatKES(from)}</b> <span className="text-muted-foreground">/ night</span></p>}
      </div>
    </Link>
  )
}
