import { readFileSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildManifest } from '../../src/lib/manifest'
import { DEFAULT_APP_INSTALL } from '../../src/lib/pwa'

const m = buildManifest('https://example.com', { businessName: 'RG Wings Stays', brandColor: '#a9761f', app: DEFAULT_APP_INSTALL })

describe('installable app', () => {
  it('manifest meets install criteria', () => {
    expect(m.display).toBe('standalone'); expect(m.start_url).toBe('/'); expect(m.id).toBe('/'); expect(m.orientation).toBe('portrait')
    expect(m.name).toBe('RG Wings Stays'); expect(m.short_name).toBe('RG Wings'); expect(m.description).toContain('RG Wings Stays')
    const sizes = m.icons.map((i) => `${i.sizes}:${i.purpose}`)
    for (const want of ['192x192:any', '512x512:any', '192x192:maskable', '512x512:maskable']) expect(sizes).toContain(want)
    for (const i of m.icons) expect(existsSync(`public${i.src}`)).toBe(true)
    expect(m.related_applications[0].url).toBe('https://example.com/manifest.webmanifest')
  })
  it('owner branding overrides the defaults, bad colours do not', () => {
    const b = buildManifest('https://x.co', { businessName: 'Big Hotel Name Here', brandColor: 'nope', app: { ...DEFAULT_APP_INSTALL, themeColor: '#112233', backgroundColor: '#ffffff', appName: 'Wings', shortName: 'W' } })
    expect([b.name, b.short_name, b.theme_color, b.background_color]).toEqual(['Wings', 'W', '#112233', '#ffffff'])
    const c = buildManifest('https://x.co', { businessName: 'Big Hotel Name Here', brandColor: 'nope', app: DEFAULT_APP_INSTALL })
    expect(c.theme_color).toBe('#a9761f'); expect(c.short_name.length).toBeLessThanOrEqual(12)
  })
  it('service worker never touches private pages and keeps an offline page', () => {
    const sw = readFileSync('public/sw.js', 'utf8')
    for (const p of ['admin', 'booking', 'receipt', 'login', 'account', 'auth', 'reset-password']) expect(sw).toContain(p)
    expect(sw).toMatch(/PRIVATE\.test\(url\.pathname\)\) return/)
    expect(sw).toContain('OFFLINE_HTML'); expect(sw).toContain('MAX_STATIC')
  })
})
