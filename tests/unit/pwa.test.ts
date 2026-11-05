import { readFileSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const m = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'))

describe('installable app', () => {
  it('manifest meets install criteria', () => {
    expect(m.display).toBe('standalone')
    expect(m.start_url).toBeTruthy()
    const sizes = m.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}:${i.purpose}`)
    expect(sizes).toContain('192x192:any'); expect(sizes).toContain('512x512:any'); expect(sizes).toContain('512x512:maskable')
    for (const i of m.icons) expect(existsSync(`public${i.src}`)).toBe(true)
  })
  it('service worker never touches private pages', () => {
    const sw = readFileSync('public/sw.js', 'utf8')
    for (const p of ['admin', 'booking', 'receipt', 'login']) expect(sw).toContain(p)
    expect(sw).toMatch(/PRIVATE\.test\(url\.pathname\)\) return/)
    expect(sw).toContain('OFFLINE_HTML')
  })
})
