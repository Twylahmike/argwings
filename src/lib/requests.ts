export type RequestStatus = 'new' | 'approved' | 'rejected' | 'alternative_offered' | 'expired' | 'withdrawn'
export const REQUEST_LABEL: Record<RequestStatus, string> = {
  new: 'New', approved: 'Approved', rejected: 'Declined', alternative_offered: 'Other dates offered', expired: 'Expired', withdrawn: 'Withdrawn',
}
export type BookingRequest = {
  id: string; public_token: string; property_id: string; unit_id: string; name: string; phone: string; email: string | null
  check_in: string; check_out: string; guests: number; message: string | null; status: RequestStatus
  decision_note: string | null; alt_check_in: string | null; alt_check_out: string | null; booking_id: string | null
  decided_at: string | null; created_at: string
}
/** What the guest sees on /request/$token (safe fields only). */
export type PublicRequest = {
  status: RequestStatus; name: string; check_in: string; check_out: string; guests: number
  decision_note: string | null; alt_check_in: string | null; alt_check_out: string | null; created_at: string
  unit_name: string; property_name: string; property_slug: string; booking_token: string | null; booking_status: string | null
}
