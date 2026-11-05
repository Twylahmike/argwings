/** robots.txt and sitemap.xml builders (pure, so they can be tested). */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

export const PUBLIC_PATHS = ['/', '/spaces', '/gallery', '/search'] as const

export function buildSitemap(origin: string, slugs: string[], pages: string[] = []): string {
  const base = origin.replace(/\/+$/, '')
  const urls = [...PUBLIC_PATHS.map(String), ...slugs.map((s) => `/properties/${encodeURIComponent(s)}`), ...pages.map((s) => `/p/${encodeURIComponent(s)}`)]
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(base + u)}</loc></url>`).join('\n')}\n</urlset>\n`
}

/** Private areas are never indexed; everything public is. */
export function buildRobots(origin: string): string {
  const base = origin.replace(/\/+$/, '')
  return ['User-agent: *', 'Disallow: /admin', 'Disallow: /login', 'Disallow: /booking/', 'Disallow: /request/', 'Disallow: /receipt/', 'Disallow: /book', `Sitemap: ${base}/sitemap.xml`, ''].join('\n')
}
