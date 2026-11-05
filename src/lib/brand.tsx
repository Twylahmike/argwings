import { createContext, useContext } from 'react'
import { pub } from './public-client'
import { isSupabaseConfigured } from './config'
import { DEFAULT_SITE_CONTENT, sanitizeSiteContent, type SiteContent } from './site-content'

export type ManagedPhoto = { src: string; alt: string; caption: string; group: string; kind: 'image' | 'video' }
export type PublicBanner = { id: string; src: string; title: string; subtitle: string; href: string; label: string }

export type BarMenuSection = { name: string; items: { id: string; name: string; description: string; price: number; image: string }[] }
export type FooterPage = { slug: string; title: string }
export type PublicContact = { id: string; label: string; kind: string; phone: string; note: string }

export type Brand = {
  businessName: string
  logoUrl: string
  supportWhatsapp: string
  cancellationPolicy: string
  depositPercent: number
  holdMinutes: number
  manualInstructions: string
  mpesaPaybillDisplay: string
  brandColor: string
  /** 'instant' = pay a deposit straight away; 'request' = guest asks, staff approve first. */
  bookingMode: 'instant' | 'request'
  /** Marketing copy edited in Admin > Settings > Website. */
  site: SiteContent
  /** Names of the active properties, for the footer. */
  spaces: { id: string; name: string; slug: string }[]
  /** Photos managed in Admin > Gallery. Empty = fall back to the property photos. */
  gallery: ManagedPhoto[]
  heroBanners: PublicBanner[]
  promoBanners: PublicBanner[]
  contacts: PublicContact[]
  /** Published policy pages linked from the footer. */
  pages: FooterPage[]
  /** The public drinks menu. Empty unless the owner switched the bar menu module on. */
  barMenu: BarMenuSection[]
  businessEmail: string
  businessAddress: string
  currency: string
  /** When true the public pages show a "back soon" notice (guests with a booking link still reach their booking). */
  maintenanceMode: boolean
  /** When false, visitors must sign in to book. */
  guestCheckout: boolean
  /** When false the "Join for free" invitations are hidden and no new memberships are created. */
  registrationEnabled: boolean
  /** Membership tiers shown on the join page. */
  tiers: { key: string; name: string; benefits: string[] }[]
}

export const DEFAULT_BRAND: Brand = {
  businessName: 'RG Wings Stays',
  logoUrl: '',
  supportWhatsapp: '',
  cancellationPolicy: 'Free cancellation up to 48 hours before check-in. The deposit is non-refundable after that.',
  depositPercent: 50,
  holdMinutes: 15,
  manualInstructions: 'Pay to the Paybill/Till shown below, using your booking reference as the account number.',
  mpesaPaybillDisplay: (import.meta.env.VITE_MPESA_PAYBILL_DISPLAY as string | undefined) ?? '',
  brandColor: '',
  bookingMode: 'instant',
  site: DEFAULT_SITE_CONTENT,
  spaces: [],
  gallery: [],
  heroBanners: [],
  promoBanners: [],
  contacts: [],
  pages: [],
  barMenu: [],
  businessEmail: '',
  businessAddress: '',
  currency: 'KES',
  maintenanceMode: false,
  guestCheckout: true,
  registrationEnabled: true,
  tiers: [],
}

type CatRow = { id: string; name: string; sort: number }
type ItemRow = { category_id: string; url: string; kind: 'image' | 'video'; alt_text: string | null; caption: string | null }
/** Published gallery items in category order (RLS already hides unpublished ones). */
function managedGallery(cats: CatRow[] | null, items: ItemRow[] | null): ManagedPhoto[] {
  const names = new Map((cats ?? []).map((c) => [c.id, c.name]))
  return (cats ?? []).flatMap((c) => (items ?? []).filter((i) => i.category_id === c.id).map((i) => ({
    src: i.url, kind: i.kind, alt: i.alt_text || i.caption || names.get(c.id) || 'Photo', caption: i.caption || names.get(c.id) || '', group: names.get(c.id) ?? '',
  })))
}
type BCat = { id: string; name: string }
type BProd = { id: string; category_id: string | null; name: string; description: string | null; price: number; image_url: string | null }
function buildBarMenu(cats: BCat[] | null, prods: BProd[] | null): BarMenuSection[] {
  const conv = (p: BProd) => ({ id: p.id, name: p.name, description: p.description ?? '', price: p.price, image: p.image_url ?? '' })
  const sections = (cats ?? []).map((c) => ({ name: c.name, items: (prods ?? []).filter((p) => p.category_id === c.id).map(conv) })).filter((s) => s.items.length)
  const loose = (prods ?? []).filter((p) => !p.category_id || !(cats ?? []).some((c) => c.id === p.category_id)).map(conv)
  return loose.length ? [...sections, { name: 'More', items: loose }] : sections
}
type BannerRow = { id: string; placement: 'hero' | 'promo'; title: string | null; subtitle: string | null; image_url: string; link_url: string | null; link_label: string | null }
function splitBanners(rows: BannerRow[] | null): { heroBanners: PublicBanner[]; promoBanners: PublicBanner[] } {
  const conv = (b: BannerRow): PublicBanner => ({ id: b.id, src: b.image_url, title: b.title ?? '', subtitle: b.subtitle ?? '', href: b.link_url ?? '', label: b.link_label ?? '' })
  return { heroBanners: (rows ?? []).filter((b) => b.placement === 'hero').map(conv), promoBanners: (rows ?? []).filter((b) => b.placement === 'promo').map(conv) }
}

/** The stored marketing content value out of the settings rows. */
function m_content(rows: { key: string; value: unknown }[] | null): unknown {
  return (rows ?? []).find((r) => r.key === 'site_content')?.value
}

/** Public settings (business name, logo, policy...). Falls back to defaults so pages still render if the DB is unreachable. */
export async function fetchBrand(): Promise<Brand> {
  if (!isSupabaseConfigured) return DEFAULT_BRAND
  try {
    const [{ data }, props, anns, revs, gcats, gitems, banners, contacts, bcats, bprods, pagesRes, tiersRes] = await Promise.all([
      pub().from('settings').select('key, value'),
      pub().from('properties').select('id, name, slug').eq('active', true).order('sort').order('name'),
      pub().from('announcements').select('id, text, link, variant').order('created_at', { ascending: false }).limit(3),
      pub().from('reviews').select('id, guest_name, stay_label, rating, body, response').order('created_at', { ascending: false }).limit(12),
      pub().from('gallery_categories').select('id, name, sort').order('sort').order('name'),
      pub().from('gallery_items').select('category_id, url, kind, alt_text, caption, sort').order('sort').order('created_at'),
      pub().from('homepage_banners').select('id, placement, title, subtitle, image_url, link_url, link_label, sort').order('sort').order('created_at'),
      pub().from('contact_numbers').select('id, label, kind, phone, note').order('sort').order('label'),
      pub().from('bar_categories').select('id, name').order('sort').order('name'),
      pub().from('bar_products').select('id, category_id, name, description, price, image_url').order('sort').order('name'),
      pub().from('site_pages').select('slug, title').eq('show_in_footer', true).order('sort'),
      pub().from('membership_tiers').select('key, name, benefits, rank').order('rank'),
    ])
    const content = sanitizeSiteContent(m_content(data))
    const m = Object.fromEntries((data ?? []).map((r) => [r.key as string, r.value]))
    // The migration seeds a placeholder name; treat it as "not set yet" so the public site shows the default brand.
    const str = (k: string, d: string) => (typeof m[k] === 'string' && m[k] && m[k] !== 'Your BNB Brand' ? (m[k] as string) : d)
    const num = (k: string, d: number) => (Number.isFinite(Number(m[k])) && m[k] != null ? Number(m[k]) : d)
    return {
      businessName: str('business_name', DEFAULT_BRAND.businessName),
      logoUrl: str('logo_url', ''),
      supportWhatsapp: str('support_whatsapp', ''),
      cancellationPolicy: str('cancellation_policy', DEFAULT_BRAND.cancellationPolicy),
      depositPercent: num('deposit_percent', 50),
      holdMinutes: num('hold_minutes', 15),
      manualInstructions: str('mpesa_manual_instructions', DEFAULT_BRAND.manualInstructions),
      mpesaPaybillDisplay: str('mpesa_paybill_display', DEFAULT_BRAND.mpesaPaybillDisplay),
      brandColor: str('brand_color', ''),
      bookingMode: m.booking_mode === 'request' ? 'request' : 'instant',
      site: {
        ...content,
        // Announcements and reviews are managed in Admin (Announcements, Reviews); the Website tab text is only a fallback.
        announcements: anns.data?.length ? anns.data.map((a) => ({ id: a.id as string, text: a.text as string, href: (a.link as string | null) ?? undefined, variant: a.variant as 'info' | 'promo' })) : content.announcements,
        reviews: revs.data?.length ? revs.data.map((r) => ({ id: r.id as string, guest: r.guest_name as string, stay: (r.stay_label as string | null) ?? undefined, rating: r.rating as 1 | 2 | 3 | 4 | 5, quote: r.body as string, response: (r.response as string | null) ?? undefined })) : content.reviews,
      },
      contacts: ((contacts.data ?? []) as { id: string; label: string; kind: string; phone: string; note: string | null }[]).map((c) => ({ ...c, note: c.note ?? '' })),
      pages: ((pagesRes.data ?? []) as FooterPage[]),
      barMenu: buildBarMenu(bcats.data, bprods.data),
      businessEmail: str('business_email', ''),
      businessAddress: str('business_address', ''),
      currency: str('currency', 'KES'),
      maintenanceMode: m.maintenance_mode === true,
      guestCheckout: m.guest_checkout_enabled !== false,
      registrationEnabled: m.registration_enabled !== false,
      tiers: ((tiersRes.data ?? []) as { key: string; name: string; benefits: string[] | null }[]).map((t) => ({ key: t.key, name: t.name, benefits: t.benefits ?? [] })),
      gallery: managedGallery(gcats.data, gitems.data),
      ...splitBanners(banners.data),
      spaces: ((props.data ?? []) as { id: string; name: string; slug: string }[]).slice(0, 6),
    }
  } catch {
    return DEFAULT_BRAND
  }
}

export const BrandContext = createContext<Brand>(DEFAULT_BRAND)
export const useBrand = () => useContext(BrandContext)

/** wa.me link. `phone` must be normalised (2547XXXXXXXX). */
export function waLink(phone: string, text?: string): string {
  const base = `https://wa.me/${phone.replace(/\D/g, '')}`
  return text ? `${base}?text=${encodeURIComponent(text)}` : base
}
