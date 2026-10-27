import { describe, expect, it } from 'vitest'
import { renderTemplate, type TemplateContext } from '../../supabase/functions/_shared/templates'
import * as shared from '../../supabase/functions/_shared/format'
import { formatKES } from '../../src/lib/money'
import { formatDate } from '../../src/lib/dates'
import { buildWhatsAppBookingMessage } from '../../src/lib/whatsapp'

const ctx: TemplateContext = {
  business: 'Nest BNB', guestName: 'Wanjiru Kamau', reference: 'BNB-2611-0007', link: 'https://nest.example/booking/abc-123',
  property: 'Kilimani Nest', unit: 'Studio A', address: 'Argwings Kodhek Rd, Kilimani, Nairobi', checkIn: '2026-11-06', checkOut: '2026-11-09', nights: 3,
  checkInTime: '14:00:00', checkOutTime: '10:00:00', total: 15500, paid: 7750, balance: 7750, amount: 7750, receiptNo: 'SHK4T7XYZ1', contactPhone: '0700 000 000',
}

describe('WhatsApp templates', () => {
  it.each(['booking_confirmed', 'payment_receipt', 'balance_reminder', 'checkin_reminder', 'thank_you'] as const)('%s mentions the guest and links to the booking', (name) => {
    const { text, params } = renderTemplate(name, ctx)
    expect(text).toContain('Wanjiru')
    expect(text).not.toContain('Kamau')
    expect(params.length).toBeGreaterThan(1)
    if (name !== 'thank_you') expect(text).toContain('https://nest.example/booking/abc-123')
    if (name !== 'thank_you' && name !== 'checkin_reminder') expect(text).toContain('BNB-2611-0007')
  })
  it('confirmation shows dates and money', () => {
    const t = renderTemplate('booking_confirmed', ctx).text
    expect(t).toContain('Fri 6 Nov 2026 to Mon 9 Nov 2026 (3 nights)')
    expect(t).toContain('KES 15,500')
    expect(t).toContain('Balance KES 7,750')
    expect(t).toContain('14:00')
  })
  it('receipt says fully paid when nothing is owed', () => {
    expect(renderTemplate('payment_receipt', { ...ctx, balance: 0 }).text).toContain('fully paid')
    expect(renderTemplate('payment_receipt', ctx).text).toContain('Balance remaining: KES 7,750')
    expect(renderTemplate('payment_receipt', ctx).text).toContain('M-Pesa SHK4T7XYZ1')
  })
  it('balance reminder includes manual paybill instructions only when configured', () => {
    expect(renderTemplate('balance_reminder', ctx).text).not.toContain('Paybill')
    expect(renderTemplate('balance_reminder', { ...ctx, paybill: '123456' }).text).toContain('Paybill/Till 123456')
  })
  it('check-in reminder carries address and time', () => {
    const t = renderTemplate('checkin_reminder', ctx).text
    expect(t).toContain('Argwings Kodhek Rd')
    expect(t).toContain('14:00')
  })
})

describe('shared formatting stays in sync with the app', () => {
  it('money and dates match', () => {
    for (const n of [0, 5, 1250, 1234567]) expect(shared.formatKES(n)).toBe(formatKES(n))
    for (const d of ['2026-11-03', '2026-02-28', '2027-01-01']) expect(shared.formatDate(d)).toBe(formatDate(d))
    expect(shared.addDays('2026-02-27', 2)).toBe('2026-03-01')
    expect(shared.todayNairobi(new Date('2026-11-03T21:30:00Z'))).toBe('2026-11-04')
  })
})

describe('Book on WhatsApp message', () => {
  it('contains property, unit, dates, guests and the quoted price', () => {
    const m = buildWhatsAppBookingMessage({ property: 'Kilimani Nest', unit: 'Studio A', checkIn: '2026-11-06', checkOut: '2026-11-09', nights: 3, guests: 2, total: 15500 })
    expect(m).toContain('Property: Kilimani Nest')
    expect(m).toContain('Unit: Studio A')
    expect(m).toContain('Check-in: Fri 6 Nov 2026')
    expect(m).toContain('Check-out: Mon 9 Nov 2026 (3 nights)')
    expect(m).toContain('Guests: 2')
    expect(m).toContain('Quoted price: KES 15,500')
    expect(encodeURIComponent(m)).toContain('Quoted%20price')
  })
  it('adds the booking reference and name when a hold was created', () => {
    const m = buildWhatsAppBookingMessage({ property: 'P', unit: 'U', checkIn: '2026-11-06', checkOut: '2026-11-07', nights: 1, guests: 1, reference: 'BNB-2611-0001', name: 'Jane' })
    expect(m).toContain('Booking reference: BNB-2611-0001')
    expect(m).toContain('Name: Jane')
    expect(m).toContain('1 night)')
    expect(m).not.toContain('Quoted price')
  })
})
