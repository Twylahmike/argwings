import { describe, expect, it } from 'vitest'
import { parseHeadline, safeUrl } from '../../src/lib/site-content'

describe('parseHeadline', () => {
  it('marks the *accent* word', () => {
    expect(parseHeadline('Book direct. Stay *well*.')).toEqual([
      { text: 'Book direct. Stay ', accent: false }, { text: 'well', accent: true }, { text: '.', accent: false },
    ])
  })
  it('handles plain text', () => { expect(parseHeadline('Hello')).toEqual([{ text: 'Hello', accent: false }]) })
})

describe('safeUrl', () => {
  it('allows https only', () => {
    expect(safeUrl('https://example.com/x')).toBe('https://example.com/x')
    expect(safeUrl('http://example.com')).toBeNull()
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('')).toBeNull()
  })
})

import { DEFAULT_SITE_CONTENT, sanitizeSiteContent } from '../../src/lib/site-content'

describe('sanitizeSiteContent', () => {
  it('returns the defaults for empty or garbage input', () => {
    expect(sanitizeSiteContent(undefined)).toEqual(DEFAULT_SITE_CONTENT)
    expect(sanitizeSiteContent('nope')).toEqual(DEFAULT_SITE_CONTENT)
    expect(sanitizeSiteContent([1, 2])).toEqual(DEFAULT_SITE_CONTENT)
  })
  it('drops unsafe links and trims the site address', () => {
    const c = sanitizeSiteContent({ social: { instagram: 'javascript:alert(1)', facebook: 'https://facebook.com/x' }, siteUrl: 'https://example.com/', ogImage: '//evil.com/x.png' })
    expect(c.social.instagram).toBe('')
    expect(c.social.facebook).toBe('https://facebook.com/x')
    expect(c.siteUrl).toBe('https://example.com')
    expect(c.ogImage).toBe('')
  })
  it('keeps valid reviews, clamps stars and skips incomplete ones', () => {
    const c = sanitizeSiteContent({ reviews: [{ guest: 'A', quote: 'Great', rating: 9 }, { guest: '', quote: 'x' }, { guest: 'B' }] })
    expect(c.reviews).toHaveLength(1)
    expect(c.reviews[0].rating).toBe(5)
  })
  it('skips empty announcements and validates the link', () => {
    const c = sanitizeSiteContent({ announcements: [{ text: '' }, { text: 'Offer', href: 'javascript:x', variant: 'promo' }] })
    expect(c.announcements).toHaveLength(1)
    expect(c.announcements[0].href).toBeUndefined()
    expect(c.announcements[0].variant).toBe('promo')
  })
  it('an empty heading falls back to the default; an emptied tagline stays empty', () => {
    const c = sanitizeSiteContent({ heroHeadline: '  ', tagline: '' })
    expect(c.heroHeadline).toBe(DEFAULT_SITE_CONTENT.heroHeadline)
    expect(c.tagline).toBe('')
  })
})

import { HOME_SECTIONS } from '../../src/lib/site-content'
describe('home page sections', () => {
  it('defaults to every section in order, none hidden', () => {
    const s = sanitizeSiteContent({}).sections
    expect(s.order).toEqual(HOME_SECTIONS.map((x) => x.id)); expect(s.hidden).toEqual([])
  })
  it('keeps a saved order, drops unknown and repeated ids, and appends sections it does not mention', () => {
    const s = sanitizeSiteContent({ sections: { order: ['faq', 'nope', 'spaces', 'faq'], hidden: ['gallery', 'x'] } }).sections
    expect(s.order.slice(0, 2)).toEqual(['faq', 'spaces'])
    expect(new Set(s.order).size).toBe(HOME_SECTIONS.length)
    expect(s.hidden).toEqual(['gallery'])
  })
})
