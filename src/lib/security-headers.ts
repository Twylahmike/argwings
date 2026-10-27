/**
 * Security headers added by the Worker (src/server.ts). Pure so it can be unit tested.
 * script-src needs 'unsafe-inline' because TanStack Start streams inline hydration scripts; everything else is locked down.
 */
export function securityHeaders(opts: { supabaseUrl?: string; functionsUrl?: string; production: boolean }): Record<string, string> {
  const origins = [opts.supabaseUrl, opts.functionsUrl].filter(Boolean).map((u) => new URL(u!).origin)
  const ws = origins.filter((o) => o.startsWith('https:')).map((o) => o.replace('https:', 'wss:'))
  const wsLocal = origins.filter((o) => o.startsWith('http:')).map((o) => o.replace('http:', 'ws:'))
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    `connect-src 'self' ${[...new Set([...origins, ...ws, ...wsLocal])].join(' ')}`.trim(),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://wa.me",
    "object-src 'none'",
  ].join('; ')
  return {
    // The dev server needs eval/websockets, so CSP is enforced in production builds only.
    ...(opts.production ? { 'Content-Security-Policy': csp, 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    // Booking and receipt links carry a secret token: never leak it to other sites.
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  }
}
