import type { SiteContent } from '~/lib/site-content'

/** Page meta (title, description, Open Graph, canonical when a production domain is configured). */
export function pageMeta(o: { brand: string; site: SiteContent; title: string; description: string; path?: string }) {
  const full = `${o.title} | ${o.brand}`
  const base = o.site.siteUrl.replace(/\/$/, '')
  const url = base && o.path ? `${base}${o.path}` : ''
  const img = o.site.ogImage ? (o.site.ogImage.startsWith('http') ? o.site.ogImage : `${base}${o.site.ogImage}`) : ''
  return {
    meta: [
      { title: full },
      { name: 'description', content: o.description },
      { property: 'og:title', content: full },
      { property: 'og:description', content: o.description },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: o.brand },
      ...(url ? [{ property: 'og:url', content: url }] : []),
      ...(img ? [{ property: 'og:image', content: img }, { name: 'twitter:card', content: 'summary_large_image' }] : []),
    ],
    links: url ? [{ rel: 'canonical', href: url }] : [],
  }
}
