/**
 * Editable marketing content for the public site: the ONE place to fill in what the database does not hold.
 * Everything here is optional. A field left empty hides the part of the page that would show it.
 * Business name, WhatsApp number, brand colour, deposit % and cancellation policy are NOT here: they come from
 * Admin > Settings (see ~/lib/brand.tsx).
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

export const siteContent: SiteContent = {
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
