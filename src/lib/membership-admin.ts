// Admin-side helpers for customers and membership. Everything is read through permission-checked database functions.
import { sb } from './supabase'

export async function adminRpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb().rpc(name, args)
  if (error) throw error
  return data as T
}

export type CustomerRow = {
  user_id: string; full_name: string; email: string; phone: string | null; status: 'active' | 'suspended'; tier: string; tier_key: string
  created_at: string; verified_at: string; bookings: number; spend: number; points: number; rewards_available: number
}
export type Overview = {
  registered: number; verified: number; new_registrations: number; active_members: number; suspended: number
  welcome_issued: number; offers_issued: number; offers_redeemed: number; discount_value: number; member_bookings: number; member_revenue: number
  guest_bookings: number; returning_customers: number; booked_customers: number; returning_rate: number
  registration_enabled: boolean; guest_checkout_enabled: boolean
  by_tier: { key: string; name: string; members: number }[]
}
export type Tier = {
  key: string; name: string; rank: number; min_completed_stays: number; min_spend: number; expiry_months: number | null; benefits: string[]; active: boolean
}
export type Offer = {
  id: string; name: string; description: string | null; terms: string | null; audience: 'welcome' | 'birthday' | 'member'; kind: 'percent' | 'fixed'; value: number
  max_discount: number | null; min_total: number; property_ids: string[]; min_tier_key: string | null; first_booking_only: boolean; returning_only: boolean
  min_nights: number; applies_to: 'room' | 'total'
  valid_from: string | null; valid_to: string | null; valid_days: number | null; max_redemptions: number | null; per_customer_limit: number; stackable: boolean; active: boolean
}
export const AUDIENCE_LABEL: Record<Offer['audience'], string> = { welcome: 'Welcome offer', birthday: 'Birthday reward', member: 'Member offer' }
