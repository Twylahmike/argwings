import { describe, expect, it } from 'vitest'
import { buildRobots, buildSitemap } from '../../src/lib/sitemap'

describe('sitemap and robots', () => {
  it('lists public pages and properties on the given origin', () => {
    const x = buildSitemap('https://example.com/', ['lavington-1-bedroom', 'a&b'])
    expect(x).toContain('<loc>https://example.com/</loc>')
    expect(x).toContain('<loc>https://example.com/properties/lavington-1-bedroom</loc>')
    expect(x).toContain('properties/a%26b')
    expect(x).not.toContain('/admin')
  })
  it('keeps private areas out of search and points to the sitemap', () => {
    const r = buildRobots('https://example.com')
    for (const p of ['/admin', '/login', '/booking/', '/request/', '/receipt/']) expect(r).toContain(`Disallow: ${p}`)
    expect(r).toContain('Sitemap: https://example.com/sitemap.xml')
  })
})
