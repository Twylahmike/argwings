import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { SearchX } from 'lucide-react'
import { fetchAvailability, fetchProperties } from '~/lib/public-api'
import { formatKES } from '~/lib/money'
import { formatDate } from '~/lib/dates'
import { PublicLayout } from '~/components/layout/PublicLayout'
import { SearchBar } from '~/components/booking/SearchBar'
import { Select } from '~/components/ui/form'
import { Card } from '~/components/ui/card'
import { EmptyState, ErrorState, Skeleton } from '~/components/ui/misc'

type Search = { in?: string; out?: string; guests?: number; property?: string }

export const Route = createFileRoute('/search')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(typeof s.in === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.in) ? { in: s.in } : {}),
    ...(typeof s.out === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.out) ? { out: s.out } : {}),
    ...(Number(s.guests) >= 1 ? { guests: Math.min(Number(s.guests), 20) } : {}),
    ...(typeof s.property === 'string' ? { property: s.property } : {}),
  }),
  head: () => ({ meta: [{ title: 'Search availability' }, { name: 'robots', content: 'noindex' }] }),
  component: SearchPage,
})

function SearchPage() {
  const s = Route.useSearch()
  const guests = s.guests ?? 2
  const ready = !!s.in && !!s.out && s.out > s.in
  const [sort, setSort] = useState<'price_asc' | 'price_desc'>('price_asc')
  const q = useQuery({
    queryKey: ['search', s.in, s.out, guests, s.property],
    enabled: ready,
    queryFn: async () => {
      const [avail, props] = await Promise.all([fetchAvailability(s.in!, s.out!, guests, s.property), fetchProperties()])
      return avail.map((a) => {
        const p = props.find((x) => x.id === a.property_id)
        const unit = p?.units.find((u) => u.id === a.unit_id)
        return p && unit ? { ...a, property: p, unit } : null
      }).filter((x): x is NonNullable<typeof x> => x !== null)
    },
  })
  const rows = [...(q.data ?? [])].sort((a, b) => (sort === 'price_asc' ? a.total - b.total : b.total - a.total))

  return (
    <PublicLayout>
      <div className="mx-auto max-w-6xl px-4 py-8">
        <SearchBar initial={{ checkIn: s.in, checkOut: s.out, guests }} propertyId={s.property} />
        {!ready && <div className="mt-8"><EmptyState icon={SearchX} title="Choose your dates" description="Pick a check-in and check-out date to see what is free." /></div>}
        {ready && (
          <div className="mt-8">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h1 className="text-lg font-semibold">{formatDate(s.in)} to {formatDate(s.out)} · {guests} guest{guests > 1 ? 's' : ''}</h1>
              <label className="flex items-center gap-2 text-sm">Sort by
                <Select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="h-11 w-44"><option value="price_asc">Price: low to high</option><option value="price_desc">Price: high to low</option></Select>
              </label>
            </div>
            {q.isLoading && <div className="grid gap-4 sm:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-40" />)}</div>}
            {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
            {q.data && rows.length === 0 && <EmptyState icon={SearchX} title="Nothing free for those dates" description="Try different dates, fewer guests, or message us on WhatsApp and we will help." />}
            <div className="grid gap-4 md:grid-cols-2">
              {rows.map((r) => (
                <Card key={r.unit_id} className="flex overflow-hidden">
                  <img src={r.unit.images[0] ?? r.property.cover_image ?? ''} alt="" className="hidden w-40 object-cover sm:block" loading="lazy" />
                  <div className="flex flex-1 flex-col p-4">
                    <p className="text-xs text-muted-foreground">{r.property.name} · {r.property.area || r.property.city}</p>
                    <h2 className="font-semibold">{r.unit.name}</h2>
                    <p className="text-sm text-muted-foreground">Sleeps {r.unit.max_guests} · {r.unit.bedrooms} bedroom{r.unit.bedrooms === 1 ? '' : 's'}</p>
                    <div className="mt-auto flex flex-wrap items-end justify-between gap-2 pt-3">
                      <div><p className="text-lg font-semibold">{formatKES(r.total)}</p><p className="text-xs text-muted-foreground">{r.nights} night{r.nights > 1 ? 's' : ''} · {formatKES(Math.round(r.total / r.nights))} avg per night</p></div>
                      <div className="flex gap-2">
                        <Link to="/properties/$slug" params={{ slug: r.property.slug }} search={{ unit: r.unit_id, in: s.in, out: s.out, guests }} className="inline-flex h-11 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted">Details</Link>
                        <Link to="/book" search={{ unit: r.unit_id, in: s.in!, out: s.out!, guests }} className="inline-flex h-11 items-center rounded-md bg-brand px-4 text-sm font-medium text-brand-foreground">Book</Link>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}
      </div>
    </PublicLayout>
  )
}
