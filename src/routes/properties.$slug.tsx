import { useState } from 'react'
import { createFileRoute, notFound } from '@tanstack/react-router'
import { Check, ExternalLink, MapPin } from 'lucide-react'
import { fetchPropertyBySlug, mapsLink } from '~/lib/public-api'
import { formatTime } from '~/lib/dates'
import { fromRate } from '~/lib/pricing'
import { useBrand } from '~/lib/brand'
import { PublicLayout } from '~/components/layout/PublicLayout'
import { UnitBooking } from '~/components/booking/UnitBooking'
import { SearchBar } from '~/components/booking/SearchBar'
import { NotFound } from '~/components/layout/ErrorPages'
import { Dialog, DialogContent } from '~/components/ui/dialog'

type Search = { unit?: string; in?: string; out?: string; guests?: number }

export const Route = createFileRoute('/properties/$slug')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(typeof s.unit === 'string' ? { unit: s.unit } : {}),
    ...(typeof s.in === 'string' ? { in: s.in } : {}),
    ...(typeof s.out === 'string' ? { out: s.out } : {}),
    ...(Number(s.guests) >= 1 ? { guests: Number(s.guests) } : {}),
  }),
  loader: async ({ params }) => {
    const property = await fetchPropertyBySlug(params.slug)
    if (!property) throw notFound()
    return { property }
  },
  notFoundComponent: NotFound,
  head: ({ loaderData }) => {
    const p = loaderData?.property
    if (!p) return { meta: [{ title: 'Property not found' }] }
    const from = p.units.length ? Math.min(...p.units.map(fromRate)) : null
    const desc = (p.tagline || p.description || `Stay at ${p.name}, ${p.area || p.city}.`).slice(0, 160)
    const ld = {
      '@context': 'https://schema.org', '@type': 'LodgingBusiness', name: p.name, description: p.description ?? p.tagline ?? undefined,
      image: [p.cover_image, ...p.gallery].filter(Boolean), telephone: p.contact_phone ?? undefined,
      address: { '@type': 'PostalAddress', streetAddress: p.address ?? undefined, addressLocality: p.area || p.city, addressCountry: 'KE' },
      ...(p.lat != null && p.lng != null ? { geo: { '@type': 'GeoCoordinates', latitude: p.lat, longitude: p.lng } } : {}),
      ...(from != null ? { priceRange: `From KES ${from}` } : {}),
      checkinTime: formatTime(p.check_in_time), checkoutTime: formatTime(p.check_out_time),
    }
    return {
      meta: [
        { title: `${p.name} · ${p.area || p.city}` },
        { name: 'description', content: desc },
        { property: 'og:title', content: p.name },
        { property: 'og:description', content: desc },
        { property: 'og:type', content: 'website' },
        ...(p.cover_image ? [{ property: 'og:image', content: p.cover_image }] : []),
      ],
      scripts: [{ type: 'application/ld+json', children: JSON.stringify(ld) }],
    }
  },
  component: PropertyPage,
})

function PropertyPage() {
  const { property: p } = Route.useLoaderData()
  const s = Route.useSearch()
  const brand = useBrand()
  const photos = [p.cover_image, ...p.gallery].filter((x, i, a): x is string => !!x && a.indexOf(x) === i)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const rules = (p.house_rules ?? '').split('\n').map((r) => r.trim()).filter(Boolean)

  return (
    <PublicLayout>
      <div className="mx-auto max-w-6xl px-4 py-6">
        {photos.length > 0 && (
          <div className="grid gap-2 md:grid-cols-4 md:grid-rows-2">
            <button onClick={() => setLightbox(photos[0])} className="overflow-hidden rounded-xl md:col-span-2 md:row-span-2" aria-label="Open photo">
              <img src={photos[0]} alt={p.name} className="h-64 w-full object-cover md:h-full" fetchPriority="high" width={1200} height={800} />
            </button>
            {photos.slice(1, 5).map((u, i) => (
              <button key={u} onClick={() => setLightbox(u)} className="hidden overflow-hidden rounded-xl md:block" aria-label={`Open photo ${i + 2}`}>
                <img src={u} alt="" className="h-full w-full object-cover" loading="lazy" />
              </button>
            ))}
          </div>
        )}
        <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_20rem]">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{p.name}</h1>
            <p className="mt-1 flex items-center gap-1 text-muted-foreground"><MapPin className="h-4 w-4" aria-hidden /> {[p.address, p.area, p.city].filter(Boolean).join(', ')}</p>
            {p.tagline && <p className="mt-3 text-lg">{p.tagline}</p>}
            {p.description && <p className="mt-3 whitespace-pre-line text-muted-foreground">{p.description}</p>}

            {p.amenities.length > 0 && (
              <section className="mt-8" aria-labelledby="amen">
                <h2 id="amen" className="mb-3 text-lg font-semibold">What you get</h2>
                <ul className="grid gap-2 sm:grid-cols-2">{p.amenities.map((a) => <li key={a} className="flex items-center gap-2 text-sm"><Check className="h-4 w-4 text-brand" aria-hidden /> {a}</li>)}</ul>
              </section>
            )}

            <section className="mt-8" aria-labelledby="units">
              <h2 id="units" className="mb-3 text-lg font-semibold">Choose your place</h2>
              {p.units.length === 0 && <p className="text-muted-foreground">No units are available to book online yet.</p>}
              <div className="grid gap-4">
                {p.units.map((u) => <UnitBooking key={u.id} unit={u} property={p} prefill={{ in: s.in, out: s.out, guests: s.guests }} defaultOpen={s.unit === u.id} />)}
              </div>
            </section>

            <section className="mt-8 grid gap-6 sm:grid-cols-2">
              <div>
                <h2 className="mb-2 text-lg font-semibold">House rules</h2>
                <p className="mb-2 text-sm text-muted-foreground">Check-in from {formatTime(p.check_in_time)} · Check-out by {formatTime(p.check_out_time)}</p>
                {rules.length ? <ul className="list-disc space-y-1 pl-5 text-sm">{rules.map((r) => <li key={r}>{r}</li>)}</ul> : <p className="text-sm text-muted-foreground">Please treat the home with care.</p>}
              </div>
              <div>
                <h2 className="mb-2 text-lg font-semibold">Cancellation</h2>
                <p className="text-sm">{brand.cancellationPolicy}</p>
                <a href={mapsLink(p)} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex h-11 items-center gap-1.5 text-sm font-medium text-brand underline-offset-4 hover:underline">
                  <MapPin className="h-4 w-4" aria-hidden /> View on map <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              </div>
            </section>
          </div>
          <aside className="hidden lg:block">
            <div className="sticky top-24 rounded-2xl border bg-card p-4">
              <h2 className="mb-3 font-semibold">Search all dates</h2>
              <p className="mb-3 text-sm text-muted-foreground">See what is free across all our properties.</p>
              <SearchBar propertyId={p.id} initial={{ checkIn: s.in, checkOut: s.out, guests: s.guests }} />
            </div>
          </aside>
        </div>
      </div>
      <Dialog open={!!lightbox} onOpenChange={(o) => !o && setLightbox(null)}>
        <DialogContent title={p.name} className="max-w-3xl">{lightbox && <img src={lightbox} alt={p.name} className="w-full rounded-md" />}</DialogContent>
      </Dialog>
    </PublicLayout>
  )
}
