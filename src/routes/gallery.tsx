import { createFileRoute } from '@tanstack/react-router'
import { fetchProperties } from '~/lib/public-api'
import { isSupabaseConfigured } from '~/lib/config'
import { pageMeta } from '~/lib/seo'
import { DEFAULT_BRAND, type Brand } from '~/lib/brand'
import { PublicLayout } from '~/components/layout/PublicLayout'
import { Gallery } from '~/components/site/Gallery'

export const Route = createFileRoute('/gallery')({
  loader: async () => ({ properties: isSupabaseConfigured ? await fetchProperties().catch(() => []) : [] }),
  head: ({ matches }) => {
    const brand = (matches[0]?.loaderData as { brand?: Brand } | undefined)?.brand ?? DEFAULT_BRAND
    return pageMeta({ brand: brand.businessName, title: 'Gallery', description: `Photos of the places you can book with ${brand.businessName}.`, path: '/gallery' })
  },
  component: GalleryPage,
})

function GalleryPage() {
  const { properties } = Route.useLoaderData()
  return <PublicLayout><Gallery properties={properties} standalone /></PublicLayout>
}
