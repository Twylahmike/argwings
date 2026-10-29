import { createFileRoute } from '@tanstack/react-router'
import { fetchProperties } from '~/lib/public-api'
import { isSupabaseConfigured } from '~/lib/config'
import { PublicLayout } from '~/components/layout/PublicLayout'
import { SearchBar } from '~/components/booking/SearchBar'
import { PropertyCard } from '~/components/booking/PropertyCard'
import { useBrand } from '~/lib/brand'
import { EmptyState } from '~/components/ui/misc'
import { Building2, CalendarCheck, MessageCircle, ShieldCheck, Smartphone, Sparkles } from 'lucide-react'

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
  const hero = properties.find((p) => p.cover_image)?.cover_image ?? null
  return (
    <PublicLayout>
      <section className="relative overflow-hidden bg-gradient-to-b from-brand/10 to-transparent">
        <div className="mx-auto grid max-w-6xl items-center gap-8 px-4 pb-10 pt-12 md:grid-cols-[1.1fr_0.9fr] md:pt-20">
          <div>
            <p className="mb-3 inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground"><Sparkles className="h-3.5 w-3.5 text-brand" aria-hidden /> Book direct. Pay by M-Pesa.</p>
            <h1 className="max-w-2xl text-3xl font-semibold tracking-tight md:text-5xl">Stay well in Nairobi with {brand.businessName}</h1>
            <p className="mt-3 max-w-xl text-muted-foreground md:text-lg">Clean, comfortable homes in the neighbourhoods you want. Pick your dates, pay a deposit on your phone, and you are booked.</p>
            <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <li className="flex items-center gap-2"><Smartphone className="h-4 w-4 text-brand" aria-hidden /> M-Pesa deposit</li>
              <li className="flex items-center gap-2"><CalendarCheck className="h-4 w-4 text-brand" aria-hidden /> Instant confirmation</li>
              <li className="flex items-center gap-2"><MessageCircle className="h-4 w-4 text-brand" aria-hidden /> Real people on WhatsApp</li>
            </ul>
          </div>
          {hero && <img src={hero} alt="" aria-hidden className="hidden aspect-[4/3] w-full rounded-3xl object-cover shadow-xl md:block" fetchPriority="high" width={800} height={600} />}
        </div>
        <div className="mx-auto max-w-4xl px-4 pb-10"><SearchBar /></div>
      </section>
      <section className="mx-auto max-w-6xl px-4 py-10" aria-labelledby="props">
        <h2 id="props" className="mb-5 text-xl font-semibold">Our properties</h2>
        {properties.length === 0
          ? <EmptyState icon={Building2} title="Properties are coming soon" description="Please check back shortly, or message us on WhatsApp." />
          : <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{properties.map((p, i) => <PropertyCard key={p.id} p={p} priority={i < 2} />)}</div>}
      </section>

      <section className="border-y bg-muted/40" aria-labelledby="how">
        <div className="mx-auto max-w-6xl px-4 py-12">
          <h2 id="how" className="text-xl font-semibold">How booking works</h2>
          <ol className="mt-6 grid gap-6 md:grid-cols-3">
            {[
              [CalendarCheck, 'Choose your dates', 'See what is free and the full price up front. No surprises.'],
              [Smartphone, 'Pay the deposit', `Approve an M-Pesa prompt on your phone. About ${brand.depositPercent}% secures your stay.`],
              [MessageCircle, 'Get your confirmation', 'Instant booking page, receipt and WhatsApp message. Pay the rest before you arrive.'],
            ].map(([Icon, title, text], i) => {
              const I = Icon as typeof CalendarCheck
              return (
                <li key={i} className="flex gap-4">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand text-brand-foreground"><I className="h-5 w-5" aria-hidden /></span>
                  <div><p className="font-medium"><span className="text-muted-foreground">{i + 1}. </span>{title as string}</p><p className="mt-1 text-sm text-muted-foreground">{text as string}</p></div>
                </li>
              )
            })}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-12" aria-labelledby="faq"><div className="max-w-3xl">
        <h2 id="faq" className="text-xl font-semibold">Questions guests ask</h2>
        <div className="mt-4 divide-y rounded-xl border bg-card">
          {[
            ['How do I pay?', 'With M-Pesa. After you choose your dates we send a prompt to your phone; enter your PIN to pay the deposit. You can pay the balance the same way from your booking page, or by Paybill/Till.'],
            ['Is my booking confirmed straight away?', 'Yes. As soon as the deposit arrives your booking turns Confirmed and we message you on WhatsApp. Until then your dates are held for a few minutes.'],
            ['What if I need to cancel?', brand.cancellationPolicy],
            ['Can I book on WhatsApp instead?', 'Of course. Tap "Book on WhatsApp" on any place and we will open a chat with your dates and price filled in.'],
            ['Is my information safe?', 'We only keep what we need to host you (name, phone, email) and never sell it. You can ask us to delete it at any time.'],
          ].map(([q, a]) => (
            <details key={q} className="group px-4 py-3">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-medium">
                {q}<span aria-hidden className="text-xl text-muted-foreground transition-transform group-open:rotate-45">+</span>
              </summary>
              <p className="pb-2 text-sm text-muted-foreground">{a}</p>
            </details>
          ))}
        </div>
        <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><ShieldCheck className="h-4 w-4" aria-hidden /> Payments go through Safaricom M-Pesa. We never see your PIN.</p>
      </div></section>
    </PublicLayout>
  )
}
