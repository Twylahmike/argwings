import { createContext, useContext } from 'react'
import { sb, isSupabaseConfigured } from './supabase'

export type Brand = {
  businessName: string
  logoUrl: string
  supportWhatsapp: string
  cancellationPolicy: string
  depositPercent: number
  holdMinutes: number
  manualInstructions: string
  mpesaPaybillDisplay: string
}

export const DEFAULT_BRAND: Brand = {
  businessName: 'Your BNB Brand',
  logoUrl: '',
  supportWhatsapp: '',
  cancellationPolicy: 'Free cancellation up to 48 hours before check-in. The deposit is non-refundable after that.',
  depositPercent: 50,
  holdMinutes: 15,
  manualInstructions: 'Pay to the Paybill/Till shown below, using your booking reference as the account number.',
  mpesaPaybillDisplay: (import.meta.env.VITE_MPESA_PAYBILL_DISPLAY as string | undefined) ?? '',
}

/** Public settings (business name, logo, policy...). Falls back to defaults so pages still render if the DB is unreachable. */
export async function fetchBrand(): Promise<Brand> {
  if (!isSupabaseConfigured) return DEFAULT_BRAND
  try {
    const { data } = await sb().from('settings').select('key, value')
    const m = Object.fromEntries((data ?? []).map((r) => [r.key as string, r.value]))
    const str = (k: string, d: string) => (typeof m[k] === 'string' && m[k] ? (m[k] as string) : d)
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
