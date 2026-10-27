export type AppRole = 'owner' | 'manager' | 'cleaner'
export type BookingStatus = 'pending' | 'confirmed' | 'checked_in' | 'checked_out' | 'cancelled' | 'expired' | 'no_show' | 'blocked'
export type BookingSource = 'website' | 'whatsapp' | 'walk_in' | 'phone' | 'manual'
export type PaymentKind = 'deposit' | 'balance' | 'full' | 'refund' | 'adjustment'
export type PaymentMethod = 'mpesa_stk' | 'mpesa_manual' | 'cash' | 'bank' | 'other'
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled'
export type TaskStatus = 'dirty' | 'in_progress' | 'clean' | 'inspected'

export type Property = {
  id: string; slug: string; name: string; tagline: string | null; description: string | null
  address: string | null; area: string | null; city: string; lat: number | null; lng: number | null
  contact_phone: string | null; whatsapp_number: string | null
  check_in_time: string; check_out_time: string; house_rules: string | null
  amenities: string[]; cover_image: string | null; gallery: string[]; active: boolean; sort: number
}
export type Unit = {
  id: string; property_id: string; name: string; code: string | null; unit_type: string; description: string | null
  max_guests: number; bedrooms: number; beds: number; base_rate: number; weekend_rate: number | null
  cleaning_fee: number; min_nights: number; amenities: string[]; images: string[]; active: boolean; sort: number
}
export type RateOverrideRow = { id: string; unit_id: string; label: string | null; start_date: string; end_date: string; nightly_rate: number; created_at: string }
export type Guest = {
  id: string; full_name: string; phone: string; email: string | null; id_number: string | null
  notes: string | null; anonymised_at: string | null; created_at: string
}
export type Booking = {
  id: string; reference: string; public_token: string; property_id: string; unit_id: string; guest_id: string | null
  check_in: string; check_out: string; nights: number; num_guests: number; status: BookingStatus; source: BookingSource
  nightly_total: number; cleaning_fee: number; discount: number; total_amount: number; deposit_required: number
  amount_paid: number; hold_expires_at: string | null; payment_review: boolean; review_reason: string | null
  notes: string | null; cancelled_at: string | null; cancel_reason: string | null; created_at: string
}
export type Payment = {
  id: string; booking_id: string; kind: PaymentKind; method: PaymentMethod; status: PaymentStatus; amount: number
  phone: string | null; mpesa_receipt: string | null; checkout_request_id: string | null
  result_code: number | null; result_desc: string | null; recorded_by: string | null; created_at: string; confirmed_at: string | null
}
export type HousekeepingTask = {
  id: string; property_id: string; unit_id: string; booking_id: string | null; status: TaskStatus; priority: boolean
  assigned_to: string | null; due_date: string; notes: string | null; completed_at: string | null; created_at: string
}
export type Expense = {
  id: string; property_id: string; category: string; amount: number; expense_date: string; description: string | null
  paid_via: PaymentMethod | null; receipt_url: string | null; voided: boolean; created_at: string
}
export type MessageLog = {
  id: string; booking_id: string | null; guest_id: string | null; property_id: string | null; channel: string
  template: string; to_phone: string; body: string | null; status: string; provider_id: string | null; error: string | null; created_at: string
}
export type Profile = { id: string; full_name: string; phone: string | null; active: boolean; created_at: string }

/** Shape returned by the get_booking_by_token RPC (safe fields only). */
export type PublicBooking = {
  id: string; reference: string; public_token: string; status: BookingStatus
  check_in: string; check_out: string; nights: number; num_guests: number
  nightly_total: number; cleaning_fee: number; discount: number; total_amount: number
  deposit_required: number; amount_paid: number; balance: number; hold_expires_at: string | null
  guest_name: string | null; guest_phone: string | null
  unit: { id: string; name: string }
  property: {
    id: string; slug: string; name: string; address: string | null; area: string | null; city: string
    contact_phone: string | null; whatsapp_number: string | null; check_in_time: string; check_out_time: string
    house_rules: string | null; lat: number | null; lng: number | null
  }
  cancellation_policy: string | null
  payments: { id: string; kind: PaymentKind; method: PaymentMethod; status: PaymentStatus; amount: number
    mpesa_receipt: string | null; result_code: number | null; result_desc: string | null; created_at: string; confirmed_at: string | null }[]
}

export const STATUS_LABEL: Record<BookingStatus, string> = {
  pending: 'Pending', confirmed: 'Confirmed', checked_in: 'Checked in', checked_out: 'Checked out',
  cancelled: 'Cancelled', expired: 'Expired', no_show: 'No show', blocked: 'Blocked',
}
export const SOURCE_LABEL: Record<BookingSource, string> = {
  website: 'Website', whatsapp: 'WhatsApp', walk_in: 'Walk-in', phone: 'Phone', manual: 'Manual',
}
export const METHOD_LABEL: Record<PaymentMethod, string> = {
  mpesa_stk: 'M-Pesa (STK)', mpesa_manual: 'M-Pesa (manual)', cash: 'Cash', bank: 'Bank', other: 'Other',
}
export const EXPENSE_CATEGORIES = ['utilities', 'cleaning', 'repairs', 'staff', 'internet', 'supplies', 'marketing', 'other'] as const
/** Statuses that occupy a unit (mirror of the exclusion constraint). */
export const LIVE_STATUSES: BookingStatus[] = ['pending', 'confirmed', 'checked_in', 'blocked']
