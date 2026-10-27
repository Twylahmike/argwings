// CORS for browser callers. Only SITE_URL (and any ALLOWED_ORIGINS) may call from a browser.
// Server-to-server callers (Safaricom, Meta, pg_cron) send no Origin header and are unaffected.
declare const Deno: { env: { get(k: string): string | undefined } }

function allowedOrigins(): string[] {
  const list = [Deno.env.get('SITE_URL') ?? '', ...(Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',')]
  return list.map((s) => s.trim().replace(/\/$/, '')).filter(Boolean)
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  const ok = origin && allowedOrigins().includes(origin.replace(/\/$/, ''))
  return {
    'Access-Control-Allow-Origin': ok ? origin : (allowedOrigins()[0] ?? ''),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    Vary: 'Origin',
  }
}
