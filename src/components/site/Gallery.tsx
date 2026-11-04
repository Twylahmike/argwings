import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { buttonVariants } from '~/components/ui/button'
import { galleryItems } from '~/lib/gallery'
import type { PropertyWithUnits } from '~/lib/public-api'
import { cn } from '~/lib/utils'

/** Masonry photo wall. `limit` makes it the home-page teaser; without it, it is the full /gallery. */
export function Gallery({ properties, limit, standalone = false }: { properties: PropertyWithUnits[]; limit?: number; standalone?: boolean }) {
  const all = galleryItems(properties)
  const groups = [...new Set(all.map((i) => i.group))]
  const [group, setGroup] = useState('all')
  const shown = (group === 'all' ? all : all.filter((i) => i.group === group)).slice(0, limit)
  return (
    <section className="bg-ink px-4 py-20 text-ink-foreground sm:px-6 md:py-28" aria-labelledby="gal-h">
      <div className="mx-auto max-w-7xl">
        <div className="mb-10 text-center">
          {standalone ? <h1 id="gal-h" className="section-title">Gallery</h1> : <h2 id="gal-h" className="section-title">A peek inside.</h2>}
          <p className="mt-4 opacity-70">Take a look around before you book.</p>
        </div>
        {!limit && groups.length > 1 && (
          <div className="mb-10 flex flex-wrap justify-center gap-2" role="group" aria-label="Filter photos">
            {['all', ...groups].map((g) => (
              <button key={g} type="button" onClick={() => setGroup(g)} aria-pressed={group === g}
                className={cn('min-h-11 rounded-full px-5 text-sm capitalize transition-colors', group === g ? 'bg-brand text-brand-foreground' : 'bg-white/10 text-ink-foreground/80 hover:bg-white/20')}>{g}</button>
            ))}
          </div>
        )}
        <div className="columns-2 gap-4 md:columns-3 lg:columns-4">
          {shown.map((it, i) => (
            <figure key={`${it.src}-${i}`} className="group relative mb-4 break-inside-avoid overflow-hidden rounded-xl">
              <img src={it.src} alt={it.alt} loading="lazy" className="w-full object-cover transition-transform duration-700 group-hover:scale-105" />
              <figcaption className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/80 to-transparent p-4 font-display text-lg opacity-0 transition-opacity duration-500 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100">{it.caption}</figcaption>
            </figure>
          ))}
        </div>
        {limit && all.length > limit && (
          <div className="mt-12 text-center"><Link to="/gallery" className={cn(buttonVariants({ size: 'lg' }), 'rounded-full px-8')}>View full gallery</Link></div>
        )}
      </div>
    </section>
  )
}
