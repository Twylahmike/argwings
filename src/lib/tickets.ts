export const TICKET_STATUSES = [
  { value: 'open', label: 'Open' }, { value: 'in_progress', label: 'In progress' }, { value: 'waiting', label: 'Waiting' },
  { value: 'resolved', label: 'Resolved' }, { value: 'closed', label: 'Closed' },
] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]['value']
export const TICKET_CATEGORIES = ['general', 'complaint', 'maintenance', 'billing', 'booking', 'other'] as const
export type TicketCategory = (typeof TICKET_CATEGORIES)[number]
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]
export const ticketLabel = (s: TicketStatus) => TICKET_STATUSES.find((x) => x.value === s)?.label ?? s
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export type Ticket = {
  id: string; ticket_no: number; subject: string; description: string; category: TicketCategory; priority: TicketPriority; status: TicketStatus
  property_id: string | null; booking_id: string | null; guest_id: string | null; assigned_to: string | null; created_by: string | null
  resolved_at: string | null; created_at: string; updated_at: string
}
export type TicketMessage = { id: string; ticket_id: string; user_id: string; body: string; internal: boolean; created_at: string }
