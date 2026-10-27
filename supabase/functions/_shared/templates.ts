// WhatsApp message templates (English, short). Each includes the booking reference and a link to /booking/<token>.
// Plain TS (no Deno APIs) so Vitest can import it.
import { formatDate, formatKES, formatTime } from './format.ts'

export type TemplateName = 'booking_confirmed' | 'payment_receipt' | 'balance_reminder' | 'checkin_reminder' | 'thank_you' | 'custom'

export type TemplateContext = {
  business: string
  guestName: string
  reference: string
  link: string
  property: string
  unit: string
  address?: string | null
  checkIn: string
  checkOut: string
  nights: number
  checkInTime?: string | null
  checkOutTime?: string | null
  total: number
  paid: number
  balance: number
  /** amount of the payment being acknowledged (payment_receipt) */
  amount?: number
  receiptNo?: string | null
  paybill?: string | null
  contactPhone?: string | null
}

const first = (name: string) => (name || 'there').trim().split(/\s+/)[0]

export function renderTemplate(name: Exclude<TemplateName, 'custom'>, c: TemplateContext): { text: string; params: string[] } {
  switch (name) {
    case 'booking_confirmed':
      return {
        text: [
          `Hi ${first(c.guestName)}, your booking at ${c.property} is confirmed. ✅`,
          `Ref: ${c.reference}`,
          `${c.unit} · ${formatDate(c.checkIn)} to ${formatDate(c.checkOut)} (${c.nights} night${c.nights === 1 ? '' : 's'})`,
          `Total ${formatKES(c.total)} · Paid ${formatKES(c.paid)} · Balance ${formatKES(c.balance)}`,
          `Check-in from ${formatTime(c.checkInTime) || '14:00'}. Details & receipts: ${c.link}`,
          `— ${c.business}`,
        ].join('\n'),
        params: [first(c.guestName), c.property, c.reference, `${formatDate(c.checkIn)} to ${formatDate(c.checkOut)}`, c.link],
      }
    case 'payment_receipt':
      return {
        text: [
          `Hi ${first(c.guestName)}, we received ${formatKES(c.amount ?? 0)}${c.receiptNo ? ` (M-Pesa ${c.receiptNo})` : ''} for booking ${c.reference}. Thank you!`,
          c.balance > 0 ? `Balance remaining: ${formatKES(c.balance)}, due by check-in.` : 'Your booking is fully paid.',
          `Receipt: ${c.link}`,
          `— ${c.business}`,
        ].join('\n'),
        params: [first(c.guestName), formatKES(c.amount ?? 0), c.reference, formatKES(c.balance), c.link],
      }
    case 'balance_reminder':
      return {
        text: [
          `Hi ${first(c.guestName)}, a friendly reminder: ${formatKES(c.balance)} is still due for booking ${c.reference} at ${c.property} (check-in ${formatDate(c.checkIn)}).`,
          `Pay by M-Pesa here: ${c.link}${c.paybill ? `\nOr Paybill/Till ${c.paybill}, account ${c.reference}.` : ''}`,
          `— ${c.business}`,
        ].join('\n'),
        params: [first(c.guestName), formatKES(c.balance), c.reference, formatDate(c.checkIn), c.link],
      }
    case 'checkin_reminder':
      return {
        text: [
          `Hi ${first(c.guestName)}, see you tomorrow at ${c.property}! 🏡`,
          `Check-in from ${formatTime(c.checkInTime) || '14:00'} on ${formatDate(c.checkIn)}. ${c.unit}.`,
          c.address ? `Address: ${c.address}` : '',
          c.balance > 0 ? `Balance due: ${formatKES(c.balance)}.` : '',
          `Your booking (${c.reference}): ${c.link}`,
          c.contactPhone ? `Questions? Call ${c.contactPhone}.` : '',
          `— ${c.business}`,
        ].filter(Boolean).join('\n'),
        params: [first(c.guestName), c.property, formatDate(c.checkIn), formatTime(c.checkInTime) || '14:00', c.link],
      }
    case 'thank_you':
      return {
        text: [
          `Hi ${first(c.guestName)}, thank you for staying at ${c.property}! We hope you enjoyed it. 🙏`,
          `We would love to host you again: ${c.link.replace(/\/booking\/.*/, '')}`,
          `— ${c.business}`,
        ].join('\n'),
        params: [first(c.guestName), c.property],
      }
  }
}
