export type InquiryStatus = 'new' | 'contacted' | 'awaiting_response' | 'converted' | 'closed'
export const INQUIRY_STATUSES: { value: InquiryStatus; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'awaiting_response', label: 'Awaiting response' },
  { value: 'converted', label: 'Converted' },
  { value: 'closed', label: 'Closed' },
]
export const inquiryLabel = (s: string) => INQUIRY_STATUSES.find((x) => x.value === s)?.label ?? s

export type Inquiry = {
  id: string; name: string; phone: string; email: string | null; message: string
  property_id: string | null; check_in: string | null; check_out: string | null; guests: number | null
  source: string; status: InquiryStatus; assigned_to: string | null; follow_up_on: string | null
  booking_id: string | null; created_at: string; updated_at: string
}
export type InquiryNote = { id: string; inquiry_id: string; user_id: string | null; body: string; created_at: string }
