import { Link } from '@tanstack/react-router'
import { useBrand } from '~/lib/brand'
import { mapsLink, type PropertyWithUnits } from '~/lib/public-api'

// Deterministic (no Math.random) so server and client render the same markup.
const particles = Array.from({ length: 25 }, (_, i) => ({ left: (i * 37) % 100, dur: 10 + ((i * 7) % 15), delay: (i * 5) % 15 }))
const label = (p: PropertyWithUnits) => [p.address, p.area].filter(Boolean).join(', ') || p.name
const mapQuery = (p: PropertyWithUnits) => (p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : [p.address, p.area, p.city].filter(Boolean).join(', '))

export function FinalCTA({ properties }: { properties: PropertyWithUnits[] }) {
  const { site } = useBrand()
  const places = properties.filter((p) => mapQuery(p)).slice(0, 2)
  return (
    <section className="relative isolate overflow-hidden bg-brand px-6 py-24 text-brand-foreground" aria-labelledby="cta-h">
      {particles.map((p, i) => <span key={i} className="particle" aria-hidden style={{ left: `${p.left}%`, animationDuration: `${p.dur}s`, animationDelay: `${p.delay}s` }} />)}
      <div className="relative mx-auto max-w-4xl text-center">
        <h2 id="cta-h" className="font-display text-5xl font-light md:text-7xl" style={{ animation: 'fade-up 1s both' }}>Ready for Your <em className="italic">Nairobi</em> Retreat?</h2>
        {places.length > 0 && <p className="mx-auto mt-6 max-w-xl opacity-85" style={{ animation: 'fade-in 1s .4s both' }}>{places.map(label).join(' & ')}.</p>}
        <div className="mt-10 flex flex-col flex-wrap justify-center gap-4 sm:flex-row" style={{ animation: 'fade-up 1s .6s both' }}>
          <Link to="/search" className="btn-ivory rounded-full px-8 py-4 text-sm font-medium">Book Direct</Link>
          {places.map((p) => <a key={p.id} href={mapsLink(p)} target="_blank" rel="noreferrer" className="btn-olive rounded-full px-8 py-4 text-sm font-medium">Directions to {p.area || p.name}</a>)}
        </div>
        {places.length > 0 && (
          <div className="mt-14 grid gap-4 md:grid-cols-2">
            {places.map((p) => (
              <div key={p.id}>
                <iframe title={`Map: ${label(p)}`} className="h-64 w-full rounded-xl border-0" loading="lazy" referrerPolicy="no-referrer" src={`https://www.google.com/maps?q=${encodeURIComponent(mapQuery(p))}&output=embed`} />
                <p className="mt-2 text-sm opacity-85">{label(p)}</p>
              </div>
            ))}
          </div>
        )}
        {!places.length && site.location && <p className="mt-8 opacity-85">{site.location}</p>}
      </div>
    </section>
  )
}
