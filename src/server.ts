import { createServerEntry, createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { securityHeaders } from '~/lib/security-headers'

const handler = createStartHandler(defaultStreamHandler)

const headers = securityHeaders({
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  functionsUrl: import.meta.env.VITE_FUNCTIONS_URL as string | undefined,
  production: import.meta.env.PROD,
})

export default createServerEntry({
  async fetch(request, opts) {
    const res = await handler(request, opts)
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(headers)) out.headers.set(k, v)
    // Private pages (booking, receipt, admin) must never be cached by shared caches.
    const path = new URL(request.url).pathname
    if (/^\/(booking|receipt|admin|login)/.test(path)) out.headers.set('Cache-Control', 'private, no-store')
    return out
  },
})
