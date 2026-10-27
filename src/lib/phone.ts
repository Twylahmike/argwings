/**
 * Kenyan phone normalisation: everything becomes 2547XXXXXXXX or 2541XXXXXXXX.
 * Accepts 07.., 01.., +254.., 254.. with spaces, dashes, dots or brackets.
 * KEEP IN SYNC with supabase/functions/_shared/phone.ts (a unit test compares the two).
 */
export type PhoneResult = { ok: true; phone: string } | { ok: false; error: string }

export const PHONE_ERROR =
  'Enter a valid Kenyan phone number, for example 0712 345 678 or +254 712 345 678.'

export function normalizePhone(input: string): PhoneResult {
  const raw = (input ?? '').trim()
  if (!raw) return { ok: false, error: 'Phone number is required.' }
  if (/[^\d\s\-+().]/.test(raw)) return { ok: false, error: PHONE_ERROR }
  let digits = raw.replace(/[\s\-().]/g, '')
  if (digits.startsWith('+')) {
    if (!digits.startsWith('+254')) return { ok: false, error: PHONE_ERROR }
    digits = digits.slice(1)
  }
  if (digits.includes('+')) return { ok: false, error: PHONE_ERROR }
  if (digits.startsWith('0')) digits = '254' + digits.slice(1)
  if (!/^254[71]\d{8}$/.test(digits)) return { ok: false, error: PHONE_ERROR }
  return { ok: true, phone: digits }
}

/** Returns the normalised number or throws. For code paths that validated earlier. */
export function mustNormalizePhone(input: string): string {
  const r = normalizePhone(input)
  if (!r.ok) throw new Error(r.error)
  return r.phone
}

/** 254712345678 -> 0712 345 678 (display only). */
export function formatPhoneLocal(phone: string): string {
  if (!/^254[71]\d{8}$/.test(phone)) return phone
  const l = '0' + phone.slice(3)
  return `${l.slice(0, 4)} ${l.slice(4, 7)} ${l.slice(7)}`
}

/** Masks all but the last three digits, for logs and lists. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return ''
  return phone.length <= 3 ? phone : '*'.repeat(phone.length - 3) + phone.slice(-3)
}
