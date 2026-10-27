import { createFileRoute } from '@tanstack/react-router'
import { fetchProperties } from '~/lib/public-api'
import { isSupabaseConfigured } from '~/lib/config'
import { PublicLayout } from '~/components/layout/PublicLayout'
import { SearchBar } from '~/components/booking/SearchBar'
import { PropertyCard } from '~/components/booking/PropertyCard'
import { useBrand } from '~/lib/brand'
import { EmptyState } from '~/components/ui/misc'
import { Building2 } from 'lucide-react'

export const Route = createFileRoute('/')({
  loader: async () => ({ properties: isSupabaseConfigured ? await fetchProperties().catch(() => []) : [] }),
  head: () => ({
    meta: [
      { title: 'Book your stay in Nairobi' },
      { name: 'description', content: 'Comfortable BNB stays across Nairobi. Check availability and pay your deposit by M-Pesa.' },
      { property: 'og:title', content: 'Book your stay in Nairobi' },
      { property: 'og:type', content: 'website' },
    ],
  }),
  component: Home,
})

function Home() {
  const { properties } = Route.useLoaderData()
  const brand = useBrand()
  return (
    <PublicLayout>
      <section className="bg-gradient-to-b from-brand/10 to-transparent">
        <div className="mx-auto max-w-6xl px-4 pb-10 pt-12 md:pt-20">
          <h1 className="max-w-2xl text-3xl font-semibold tracking-tight md:text-5xl">Stay well in Nairobi with {brand.businessName}</h1>
          <p className="mt-3 max-w-xl text-muted-foreground md:text-lg">Clean, comfortable homes in the neighbourhoods you want. Book online and pay your deposit with M-Pesa.</p>
          <div className="mt-8 max-w-4xl"><SearchBar /></div>
        </div>
      </section>
      <section className="mx-auto max-w-6xl px-4 py-10" aria-labelledby="props">
        <h2 id="props" className="mb-5 text-xl font-semibold">Our properties</h2>
        {properties.length === 0
          ? <EmptyState icon={Building2} title="Properties are coming soon" description="Please check back shortly, or message us on WhatsApp." />
          : <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{properties.map((p, i) => <PropertyCard key={p.id} p={p} priority={i < 2} />)}</div>}
      </section>
    </PublicLayout>
  )
}
