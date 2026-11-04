import { createServerEntry, createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { securityHeaders } from '~/lib/security-headers'
import { buildRobots, buildSitemap } from '~/lib/sitemap'
import { isSupabaseConfigured } from '~/lib/config'
import { pub } from '~/lib/public-client'
import { sanitizeSiteContent } from '~/lib/site-content'

const handler = createStartHandler(defaultStreamHandler)

const headers = securityHeaders({
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  functionsUrl: import.meta.env.VITE_FUNCTIONS_URL as string | undefined,
  production: import.meta.env.PROD,
})

export default createServerEntry({
  async fetch(request, opts) {
    const url = new URL(request.url)
    if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') {
      let origin = url.origin
      let slugs: string[] = []
      if (isSupabaseConfigured) {
        try {
          const [{ data: settings }, { data: props }] = await Promise.all([
            pub().from('settings').select('key, value').eq('key', 'site_content'),
            pub().from('properties').select('slug').eq('active', true).order('sort'),
          ])
          const configured = sanitizeSiteContent(settings?.[0]?.value).siteUrl
          if (configured) origin = configured
          slugs = (props ?? []).map((p) => p.slug as string)
        } catch { /* fall back to the request origin and static pages */ }
      }
      const isRobots = url.pathname === '/robots.txt'
      return new Response(isRobots ? buildRobots(origin) : buildSitemap(origin, slugs), {
        headers: { 'Content-Type': isRobots ? 'text/plain; charset=utf-8' : 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      })
    }
    const res = await handler(request, opts)
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(headers)) out.headers.set(k, v)
    // Private pages (booking, receipt, admin) must never be cached by shared caches.
    const path = new URL(request.url).pathname
    if (/^\/(booking|receipt|admin|login)/.test(path)) out.headers.set('Cache-Control', 'private, no-store')
    return out
  },
})
