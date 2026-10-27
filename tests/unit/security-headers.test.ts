import { describe, expect, it } from 'vitest'
import { securityHeaders } from '../../src/lib/security-headers'

describe('securityHeaders', () => {
  const prod = securityHeaders({ supabaseUrl: 'https://abc.supabase.co', production: true })
  it('sets the baseline headers', () => {
    expect(prod['X-Frame-Options']).toBe('DENY')
    expect(prod['X-Content-Type-Options']).toBe('nosniff')
    expect(prod['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
  })
  it('CSP allows only self + the Supabase project', () => {
    const csp = prod['Content-Security-Policy']
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain('connect-src \'self\' https://abc.supabase.co wss://abc.supabase.co')
    expect(csp).not.toContain('*')
  })
  it('does not enforce CSP/HSTS in dev', () => {
    const dev = securityHeaders({ supabaseUrl: 'http://127.0.0.1:54321', production: false })
    expect(dev['Content-Security-Policy']).toBeUndefined()
    expect(dev['X-Frame-Options']).toBe('DENY')
  })
})
