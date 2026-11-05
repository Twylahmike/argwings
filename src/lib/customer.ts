// Customer accounts (members). Separate from staff auth in ./auth.ts: a customer has no staff profile and can never reach /admin.
// Public pages must not load the auth client unless the visitor actually has a session, so everything here imports it lazily.
import { supabaseUrl } from './config'

export type CustomerTier = { key: string; name: string; benefits: string[]; expires_at: string | null }
export type Customer = {
  user_id: string
  full_name: string
  email: string
  phone: string | null
  country: string | null
  birthday: string | null
  status: 'active' | 'suspended'
  marketing_opt_in: boolean
  member_since: string
  tier: CustomerTier
  points: number
  points_redeem?: { enabled: boolean; kes_per_point: number; max_percent: number }
  completed_stays: number
  total_spend: number
  next_tier: { key: string; name: string; stays_needed: number; spend_needed: number } | null
}

export type MyBooking = {
  id: string; reference: string; public_token: string; status: string; check_in: string; check_out: string; nights: number; guests: number
  property: string; property_slug: string; unit: string; total: number; discount: number; paid: number; balance: number
  cancelled_at: string | null; offer: string | null; open_request: 'cancellation' | 'modification' | null
}

export type MyReward = {
  id: string; code: string; name: string; description: string | null; terms: string | null; audience: 'welcome' | 'birthday' | 'member'
  kind: 'percent' | 'fixed'; value: number; max_discount: number | null; min_total: number
  status: 'available' | 'redeemed' | 'expired' | 'void'; issued_at: string; expires_at: string | null; booking_id: string | null; redeemed_for: string | null
}

export type OpenOffer = {
  id: string; name: string; description: string | null; terms: string | null; kind: 'percent' | 'fixed'; value: number
  max_discount: number | null; min_total: number; valid_to: string | null; min_tier: string | null; used: number
}

export type StayPoints = { enabled: boolean; balance?: number; kes_per_point?: number; max_percent?: number; max_points?: number; max_discount?: number }

export type StayOffer = {
  reward_id: string | null; offer_id: string; name: string; audience: string; ok: boolean; message: string; amount: number
  code: string | null; expires_at: string | null; terms: string | null
}

/** Cheap check (no network, no auth client): is there a stored Supabase session in this browser? */
export function hasStoredSession(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const ref = supabaseUrl ? new URL(supabaseUrl).hostname.split('.')[0] : ''
    return !!ref && !!window.localStorage.getItem(`sb-${ref}-auth-token`)
  } catch { return false }
}

async function client() {
  const { sb } = await import('./supabase')
  return sb()
}

/**
 * Loads the signed-in customer. Verifies the email, creates the profile on first verified visit (which also issues the welcome
 * reward), then returns the profile. Returns { state } describing why there is no customer when there is none.
 */
export type CustomerState = { state: 'anonymous' | 'unverified' | 'staff' | 'closed' | 'ready'; customer?: Customer; newlyJoined?: boolean; email?: string }
export async function fetchCustomer(): Promise<CustomerState> {
  const c = await client()
  const { data } = await c.auth.getSession()
  const user = data.session?.user
  if (!user) return { state: 'anonymous' }
  const { data: ensured, error } = await c.rpc('ensure_customer_profile')
  if (error) return { state: 'anonymous' }
  const e = ensured as { status: string; new?: boolean; welcome_emailed?: boolean }
  if (e.status === 'unverified') return { state: 'unverified', email: user.email ?? '' }
  if (e.status === 'staff') return { state: 'staff' }
  if (e.status === 'closed') return { state: 'closed' }
  const { data: me } = await c.rpc('my_customer')
  if (!me) return { state: 'anonymous' }
  // First visit after verifying: send the welcome emails. Fire and forget; the server checks it is only done once.
  if (e.welcome_emailed === false) {
    void import('./functions').then((f) => f.callFunction('member-emails', { action: 'welcome' })).catch(() => undefined)
  }
  return { state: 'ready', customer: me as Customer, newlyJoined: e.new === true }
}

export async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const c = await client()
  const { data, error } = await c.rpc(name, args)
  if (error) throw new Error(error.message)
  return data as T
}

export const passwordProblem = (p: string): string | null => {
  if (p.length < 8) return 'Use at least 8 characters.'
  if (!/[a-z]/.test(p) || !/[A-Z]/.test(p)) return 'Include both upper and lower case letters.'
  if (!/[0-9]/.test(p)) return 'Include at least one number.'
  return null
}

/** Describe a reward's value for display. */
export const describeOffer = (o: { kind: 'percent' | 'fixed'; value: number; max_discount?: number | null }): string =>
  o.kind === 'percent' ? `${o.value}% off${o.max_discount ? ` (up to KES ${o.max_discount.toLocaleString('en-KE')})` : ''}` : `KES ${o.value.toLocaleString('en-KE')} off`

/** Where the Supabase email links (verify, reset) should send people back to. */
/** Where to send a signed-in member who has only a booking link: adds the booking to their account. */
export async function claimBookingByToken(token: string): Promise<{ reference: string; status: string }> {
  return rpc('claim_booking_by_token', { p_token: token })
}

export const authRedirect = (path: string): string => (typeof window === 'undefined' ? path : `${window.location.origin}${path}`)

export async function signUp(v: { name: string; email: string; password: string }): Promise<{ error?: string; needsVerification: boolean }> {
  const c = await client()
  const { data, error } = await c.auth.signUp({
    email: v.email.trim().toLowerCase(), password: v.password,
    options: { data: { full_name: v.name.trim() }, emailRedirectTo: authRedirect('/auth/callback') },
  })
  if (error) {
    if (/registered|already/i.test(error.message)) return { error: 'An account with this email already exists. Try signing in, or reset your password.', needsVerification: false }
    if (/password/i.test(error.message)) return { error: error.message, needsVerification: false }
    if (/rate|limit|too many/i.test(error.message)) return { error: 'Too many attempts. Please wait a few minutes and try again.', needsVerification: false }
    return { error: 'We could not create your account. Please try again.', needsVerification: false }
  }
  // With "confirm email" on, Supabase returns a user with no identities when the address is already registered (it hides the fact).
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return { error: 'An account with this email already exists. Try signing in, or reset your password.', needsVerification: false }
  }
  return { needsVerification: !data.session }
}
