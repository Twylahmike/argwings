import { createFileRoute } from '@tanstack/react-router'
import { fetchProperties } from '~/lib/public-api'
import { isSupabaseConfigured } from '~/lib/config'
import { pageMeta } from '~/lib/seo'
import { DEFAULT_BRAND, type Brand } from '~/lib/brand'
import { PublicLayout } from '~/components/layout/PublicLayout'
import { Spaces } from '~/components/site/Spaces'
import { MembershipNudge } from '~/components/site/MembershipPromo'

export const Route = createFileRoute('/spaces')({
  loader: async () => ({ properties: isSupabaseConfigured ? await fetchProperties().catch(() => []) : [] }),
  head: ({ matches }) => {
    const brand = (matches[0]?.loaderData as { brand?: Brand } | undefined)?.brand ?? DEFAULT_BRAND
    return pageMeta({ brand: brand.businessName, site: brand.site, title: 'Our spaces', description: `Browse the places you can book with ${brand.businessName}.`, path: '/spaces' })
  },
  component: SpacesPage,
})

function SpacesPage() {
  const { properties } = Route.useLoaderData()
  return <PublicLayout><Spaces properties={properties} page /><div className="mx-auto max-w-6xl px-4 pb-12 sm:px-6"><MembershipNudge /></div></PublicLayout>
}
