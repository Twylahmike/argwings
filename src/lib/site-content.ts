/**
 * Marketing content for the public site. The owner edits it in Admin > Settings > Website (stored as settings.site_content);
 * the values below are only the defaults used until something is saved there.
 * Everything is optional: a field left empty hides the part of the page that would show it.
 * Business name, WhatsApp number, brand colour, deposit % and cancellation policy live in the other Settings tabs.
 */
export type Announcement = { id: string; text: string; href?: string; variant?: 'info' | 'promo' }
export type Review = { id: string; guest: string; stay?: string; rating: 1 | 2 | 3 | 4 | 5; quote: string }

export type SiteContent = {
  /** Short line under the logo in the footer and PWA description. */
  tagline: string
  /** Hero headline. Wrap ONE word in *asterisks* to show it in italics with the brand colour, e.g. "Stay *well*." */
  heroHeadline: string
  /** One sentence under the headline. */
  heroSubline: string
  /** Scrolling strip at the bottom of the hero. */
  tickerItems: string[]
  /** Where the properties are, in words (city, neighbourhoods). Shown in the footer and final call to action. */
  location: string
  contactEmail: string
  social: { instagram: string; facebook: string; tiktok: string; x: string }
  /** Optional full-width feature band (e.g. a pool, rooftop or gym). Hidden when `title` is empty. */
  facility: { eyebrow: string; title: string; body: string; image: string }
  announcements: Announcement[]
  reviews: Review[]
  /** Public origin used for canonical and Open Graph URLs, e.g. "https://example.com" (no trailing slash). */
  siteUrl: string
  /** Absolute or root-relative URL of the social share image. */
  ogImage: string
}

export const DEFAULT_SITE_CONTENT: SiteContent = {
  // TODO(owner): tagline for RG Wings Stays.
  tagline: '',
  // TODO(owner): hero headline. This default is generic copy, not a claim about the business.
  heroHeadline: 'Book direct. Stay *well*.',
  heroSubline: 'Pick your dates, pay a deposit by M-Pesa, and you are booked.',
  // TODO(owner): short selling points for the hero strip (facts you can stand behind).
  tickerItems: ['Direct booking', 'Pay by M-Pesa', 'Instant confirmation'],
  // TODO(owner): city / neighbourhoods, e.g. "Nairobi". Left empty so nothing unverified is shown.
  location: '',
  // TODO(owner): public contact email.
  contactEmail: '',
  // TODO(owner): social profile URLs (full https:// links). Empty ones are hidden.
  social: { instagram: '', facebook: '', tiktok: '', x: '' },
  // TODO(owner): optional feature band (pool, rooftop, gym...). Leave title empty to hide it.
  facility: { eyebrow: '', title: '', body: '', image: '' },
  // TODO(owner): announcement text (e.g. a promo). Empty = no bar.
  announcements: [],
  // TODO(owner): real guest reviews, with permission. Empty = the section is hidden.
  reviews: [],
  // TODO(owner): production domain for canonical/OG URLs.
  siteUrl: '',
  // TODO(owner): social share image (1200x630).
  ogImage: '',
}

/** Splits "Stay *well*." into plain and accented parts for rendering. */
export function parseHeadline(h: string): Array<{ text: string; accent: boolean }> {
  return h.split(/(\*[^*]+\*)/g).filter(Boolean).map((t) => (t.startsWith('*') && t.endsWith('*') && t.length > 2 ? { text: t.slice(1, -1), accent: true } : { text: t, accent: false }))
}

/** Only https links the owner typed, never javascript: or data: URLs. */
export function safeUrl(u: string): string | null {
  try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null } catch { return null }
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const httpsOrEmpty = (v: unknown) => { const t = text(v, 500); return t ? (safeUrl(t) ?? '') : '' }
const imageOrEmpty = (v: unknown) => { const t = text(v, 500); return t.startsWith('/') && !t.startsWith('//') ? t : httpsOrEmpty(t) }

/** Validates whatever is stored in settings.site_content. Unknown or malformed parts fall back to the defaults. */
export function sanitizeSiteContent(raw: unknown): SiteContent {
  const d = DEFAULT_SITE_CONTENT
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const obj = (k: string) => (r[k] && typeof r[k] === 'object' && !Array.isArray(r[k]) ? (r[k] as Record<string, unknown>) : {})
  const has = (k: string) => k in r
  const social = obj('social'), fac = obj('facility')
  const siteUrl = httpsOrEmpty(r.siteUrl).replace(/\/+$/, '')
  return {
    tagline: has('tagline') ? text(r.tagline, 120) : d.tagline,
    heroHeadline: text(r.heroHeadline, 80) || d.heroHeadline,
    heroSubline: has('heroSubline') ? text(r.heroSubline, 200) : d.heroSubline,
    tickerItems: Array.isArray(r.tickerItems) ? r.tickerItems.map((t) => text(t, 60)).filter(Boolean).slice(0, 8) : d.tickerItems,
    location: has('location') ? text(r.location, 120) : d.location,
    contactEmail: has('contactEmail') ? (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(r.contactEmail, 120)) ? text(r.contactEmail, 120) : '') : d.contactEmail,
    social: { instagram: httpsOrEmpty(social.instagram), facebook: httpsOrEmpty(social.facebook), tiktok: httpsOrEmpty(social.tiktok), x: httpsOrEmpty(social.x) },
    facility: { eyebrow: text(fac.eyebrow, 60), title: text(fac.title, 80), body: text(fac.body, 300), image: imageOrEmpty(fac.image) },
    announcements: Array.isArray(r.announcements)
      ? r.announcements.flatMap((a, i): Announcement[] => {
          const o = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>
          const t = text(o.text, 160)
          if (!t) return []
          const href = text(o.href, 300)
          return [{ id: text(o.id, 40) || `a${i}`, text: t, href: href.startsWith('/') && !href.startsWith('//') ? href : (safeUrl(href) ?? undefined), variant: o.variant === 'promo' ? 'promo' : 'info' }]
        }).slice(0, 3)
      : d.announcements,
    reviews: Array.isArray(r.reviews)
      ? r.reviews.flatMap((x, i): Review[] => {
          const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
          const quote = text(o.quote, 500), guest = text(o.guest, 60)
          const rating = Math.min(5, Math.max(1, Math.round(Number(o.rating) || 5))) as Review['rating']
          return quote && guest ? [{ id: text(o.id, 40) || `r${i}`, guest, stay: text(o.stay, 80) || undefined, rating, quote }] : []
        }).slice(0, 12)
      : d.reviews,
    siteUrl,
    ogImage: imageOrEmpty(r.ogImage),
  }
}
