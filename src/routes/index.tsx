import { createFileRoute } from '@tanstack/react-router'
import { fetchProperties } from '~/lib/public-api'
import { isSupabaseConfigured } from '~/lib/config'
import { pageMeta } from '~/lib/seo'
import { DEFAULT_BRAND, type Brand } from '~/lib/brand'
import { PublicLayout } from '~/components/layout/PublicLayout'
import { Hero } from '~/components/site/Hero'
import { TrustBar } from '~/components/site/TrustBar'
import { Spaces } from '~/components/site/Spaces'
import { Facilities } from '~/components/site/Facilities'
import { Amenities } from '~/components/site/Amenities'
import { HowToBook } from '~/components/site/HowToBook'
import { PaymentExplainer } from '~/components/site/PaymentExplainer'
import { Reviews } from '~/components/site/Reviews'
import { Gallery } from '~/components/site/Gallery'
import { FinalCTA } from '~/components/site/FinalCTA'
import { Faq } from '~/components/site/Faq'
import { PromoStrip } from '~/components/site/PromoStrip'
import { InquiryForm } from '~/components/site/InquiryForm'

export const Route = createFileRoute('/')({
  loader: async () => ({ properties: isSupabaseConfigured ? await fetchProperties().catch(() => []) : [] }),
  head: ({ matches }) => {
    const brand = (matches[0]?.loaderData as { brand?: Brand } | undefined)?.brand ?? DEFAULT_BRAND
    return pageMeta({ brand: brand.businessName, site: brand.site, title: 'Book your stay', description: `Book direct with ${brand.businessName}. Check availability and pay your deposit by M-Pesa.`, path: '/' })
  },
  component: Home,
})

function Home() {
  const { properties } = Route.useLoaderData()
  return (
    <PublicLayout overlay>
      <Hero properties={properties} />
      <PromoStrip />
      <TrustBar />
      <Spaces properties={properties} />
      <Facilities />
      <Amenities />
      <HowToBook />
      <PaymentExplainer />
      <Reviews />
      <Gallery properties={properties} limit={8} />
      <Faq />
      <InquiryForm />
      <FinalCTA properties={properties} />
    </PublicLayout>
  )
}
