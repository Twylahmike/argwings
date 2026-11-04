import { createContext, useContext } from 'react'
import { pub } from './public-client'
import { isSupabaseConfigured } from './config'
import { DEFAULT_SITE_CONTENT, sanitizeSiteContent, type SiteContent } from './site-content'

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
  /** Marketing copy edited in Admin > Settings > Website. */
  site: SiteContent
  /** Names of the active properties, for the footer. */
  spaces: { id: string; name: string; slug: string }[]
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
  site: DEFAULT_SITE_CONTENT,
  spaces: [],
}

/** The stored marketing content value out of the settings rows. */
function m_content(rows: { key: string; value: unknown }[] | null): unknown {
  return (rows ?? []).find((r) => r.key === 'site_content')?.value
}

/** Public settings (business name, logo, policy...). Falls back to defaults so pages still render if the DB is unreachable. */
export async function fetchBrand(): Promise<Brand> {
  if (!isSupabaseConfigured) return DEFAULT_BRAND
  try {
    const [{ data }, props, anns, revs] = await Promise.all([
      pub().from('settings').select('key, value'),
      pub().from('properties').select('id, name, slug').eq('active', true).order('sort').order('name'),
      pub().from('announcements').select('id, text, link, variant').order('created_at', { ascending: false }).limit(3),
      pub().from('reviews').select('id, guest_name, stay_label, rating, body, response').order('created_at', { ascending: false }).limit(12),
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
      site: {
        ...content,
        // Announcements and reviews are managed in Admin (Announcements, Reviews); the Website tab text is only a fallback.
        announcements: anns.data?.length ? anns.data.map((a) => ({ id: a.id as string, text: a.text as string, href: (a.link as string | null) ?? undefined, variant: a.variant as 'info' | 'promo' })) : content.announcements,
        reviews: revs.data?.length ? revs.data.map((r) => ({ id: r.id as string, guest: r.guest_name as string, stay: (r.stay_label as string | null) ?? undefined, rating: r.rating as 1 | 2 | 3 | 4 | 5, quote: r.body as string, response: (r.response as string | null) ?? undefined })) : content.reviews,
      },
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
