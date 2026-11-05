import { createFileRoute, notFound } from '@tanstack/react-router'
import { pub } from '~/lib/public-client'
import { isSupabaseConfigured } from '~/lib/config'
import { parseDoc } from '~/lib/plain-doc'
import { pageMeta } from '~/lib/seo'
import { DEFAULT_BRAND, type Brand } from '~/lib/brand'
import { PublicLayout } from '~/components/layout/PublicLayout'
import { NotFound } from '~/components/layout/ErrorPages'

export const Route = createFileRoute('/p/$slug')({
  loader: async ({ params }) => {
    if (!isSupabaseConfigured) throw notFound()
    const { data } = await pub().from('site_pages').select('slug, title, body, updated_at').eq('slug', params.slug).maybeSingle()
    if (!data) throw notFound()
    return { page: data as { slug: string; title: string; body: string; updated_at: string } }
  },
  notFoundComponent: NotFound,
  head: ({ matches, loaderData }) => {
    const brand = (matches[0]?.loaderData as { brand?: Brand } | undefined)?.brand ?? DEFAULT_BRAND
    const p = loaderData?.page
    return pageMeta({ brand: brand.businessName, site: brand.site, title: p?.title ?? 'Page', description: (p?.body ?? '').replace(/[#*-]/g, '').slice(0, 150), path: p ? `/p/${p.slug}` : undefined })
  },
  component: PolicyPage,
})

function PolicyPage() {
  const { page } = Route.useLoaderData()
  return (
    <PublicLayout>
      <article className="mx-auto max-w-2xl px-4 py-14">
        <h1 className="font-display text-4xl">{page.title}</h1>
        <p className="mt-1 text-xs text-muted-foreground">Last updated {new Date(page.updated_at).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
        <div className="mt-8 space-y-4 leading-relaxed">
          {parseDoc(page.body).map((b, i) => b.type === 'h' ? <h2 key={i} className="pt-4 font-display text-2xl">{b.text}</h2>
            : b.type === 'ul' ? <ul key={i} className="list-disc space-y-1 pl-6">{b.items.map((it, j) => <li key={j}>{it}</li>)}</ul>
            : <p key={i}>{b.text}</p>)}
        </div>
      </article>
    </PublicLayout>
  )
}
