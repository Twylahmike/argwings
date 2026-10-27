import { formatKES } from './money'
import { formatDate } from './dates'

/** Prefilled message for the "Book on WhatsApp" button. Pure, so it is unit tested. */
export function buildWhatsAppBookingMessage(a: {
  property: string; unit: string; checkIn: string; checkOut: string; nights: number; guests: number
  total?: number | null; name?: string; reference?: string
}): string {
  const lines = [
    `Hi! I'd like to book a stay.`,
    '',
    `Property: ${a.property}`,
    `Unit: ${a.unit}`,
    `Check-in: ${formatDate(a.checkIn)}`,
    `Check-out: ${formatDate(a.checkOut)} (${a.nights} night${a.nights === 1 ? '' : 's'})`,
    `Guests: ${a.guests}`,
  ]
  if (a.total != null) lines.push(`Quoted price: ${formatKES(a.total)}`)
  if (a.reference) lines.push(`Booking reference: ${a.reference}`)
  if (a.name) lines.push('', `Name: ${a.name}`)
  return lines.join('\n')
}
