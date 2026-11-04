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
  tagline: 'Where Luxury Meets Home',
  heroHeadline: 'Where *Luxury* Meets Home.',
  heroSubline: 'Short & long-term stays in Lavington & Fedha, Nairobi.',
  tickerItems: ['Lavington', 'Luxury BnB', 'Indoor Pool Access', '24/7 Check-in', 'Direct Booking'],
  location: 'Lavington & Fedha, Nairobi',
  // Personal email intentionally left out. Add a business email in Admin > Settings > Website.
  contactEmail: '',
  social: { instagram: '', facebook: 'https://www.facebook.com/share/1CLcYs5jtu/', tiktok: 'https://www.tiktok.com/@everlett.living.h', x: '' },
  facility: { eyebrow: 'Lavington Exclusive', title: 'Dive Into *Luxury*', body: 'Exclusive indoor pool access, only at our Lavington location.', image: '' },
  announcements: [],
  reviews: [],
  siteUrl: '',
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
  const social = has('social') ? obj('social') : d.social
  const fac = has('facility') ? obj('facility') : d.facility
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
