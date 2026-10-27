import { sb } from './supabase'
import type { Booking, BookingStatus, Guest, Payment } from './types'

export type BookingRow = Booking & {
  guest: Pick<Guest, 'id' | 'full_name' | 'phone' | 'email'> | null
  unit: { id: string; name: string; code: string | null }
  property: { id: string; name: string }
}

export const BOOKING_SELECT = '*, guest:guests(id, full_name, phone, email), unit:units(id, name, code), property:properties(id, name)'

export type BookingFilters = {
  propertyIds: string[]
  statuses?: BookingStatus[]
  from?: string // check_out >= from
  to?: string // check_in <= to
}

export async function fetchBookings(f: BookingFilters): Promise<BookingRow[]> {
  if (!f.propertyIds.length) return []
  let q = sb().from('bookings').select(BOOKING_SELECT).in('property_id', f.propertyIds).order('check_in', { ascending: false }).limit(1000)
  if (f.statuses?.length) q = q.in('status', f.statuses)
  if (f.from) q = q.gte('check_out', f.from)
  if (f.to) q = q.lte('check_in', f.to)
  const { data, error } = await q
  if (error) throw error
  return data as unknown as BookingRow[]
}

export async function fetchBooking(id: string): Promise<BookingRow> {
  const { data, error } = await sb().from('bookings').select(BOOKING_SELECT).eq('id', id).maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Booking not found, or you do not have access.')
  return data as unknown as BookingRow
}

export async function fetchPayments(bookingId: string): Promise<Payment[]> {
  const { data, error } = await sb().from('payments').select('*').eq('booking_id', bookingId).order('created_at', { ascending: false })
  if (error) throw error
  return data as Payment[]
}

export const balance = (b: Pick<Booking, 'total_amount' | 'amount_paid'>) => Math.max(0, b.total_amount - b.amount_paid)

/** Statuses that block a unit (mirror of the exclusion constraint). */
export const isLive = (s: BookingStatus) => s === 'pending' || s === 'confirmed' || s === 'checked_in' || s === 'blocked'

export type NextAction = { to: BookingStatus; label: string; variant: 'default' | 'outline' | 'danger'; needsReason?: boolean }
export function nextActions(status: BookingStatus): NextAction[] {
  switch (status) {
    case 'pending': return [{ to: 'confirmed', label: 'Confirm booking', variant: 'default' }, { to: 'cancelled', label: 'Cancel', variant: 'outline', needsReason: true }]
    case 'confirmed': return [
      { to: 'checked_in', label: 'Check in', variant: 'default' },
      { to: 'no_show', label: 'Mark no-show', variant: 'outline', needsReason: true },
      { to: 'cancelled', label: 'Cancel', variant: 'outline', needsReason: true },
    ]
    case 'checked_in': return [{ to: 'checked_out', label: 'Check out', variant: 'default' }]
    case 'expired': return [{ to: 'confirmed', label: 'Re-confirm', variant: 'outline' }]
    case 'blocked': return [{ to: 'cancelled', label: 'Unblock dates', variant: 'outline' }]
    default: return []
  }
}
