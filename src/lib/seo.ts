import { siteContent } from '~/lib/site-content'

/** Page meta (title, description, Open Graph, canonical when a production domain is configured). */
export function pageMeta(o: { brand: string; title: string; description: string; path?: string }) {
  const full = `${o.title} | ${o.brand}`
  const base = siteContent.siteUrl.replace(/\/$/, '')
  const url = base && o.path ? `${base}${o.path}` : ''
  const img = siteContent.ogImage ? (siteContent.ogImage.startsWith('http') ? siteContent.ogImage : `${base}${siteContent.ogImage}`) : ''
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
