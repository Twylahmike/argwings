import { describe, expect, it } from 'vitest'
import { averageDailyRate, cancellationRate, occupancyByMonth, overlapNights, revenueBy, statusCounts, topGuests, type RBooking, type RPayment } from '../../src/lib/reports'

const b = (o: Partial<RBooking> & { id: string }): RBooking => ({
  property_id: 'p1', guest_id: 'g1', check_in: '2026-11-01', check_out: '2026-11-04', nights: 3, status: 'checked_out', source: 'website', nightly_total: 9000, total_amount: 9500, ...o,
})

describe('reports', () => {
  it('counts only the nights inside the window', () => {
    expect(overlapNights('2026-10-30', '2026-11-03', '2026-11-01', '2026-12-01')).toBe(2)
    expect(overlapNights('2026-11-29', '2026-12-03', '2026-11-01', '2026-12-01')).toBe(2)
    expect(overlapNights('2026-12-05', '2026-12-07', '2026-11-01', '2026-12-01')).toBe(0)
  })
  it('occupancy per property per month', () => {
    const rows = occupancyByMonth([b({ id: '1' }), b({ id: '2', check_in: '2026-11-10', check_out: '2026-11-20', nights: 10 }), b({ id: '3', status: 'cancelled' })], new Map([['p1', 2]]), '2026-11-01', '2026-12-01')
    expect(rows).toEqual([{ propertyId: 'p1', month: '2026-11-01', bookedNights: 13, availableNights: 60, pct: 21.7 }])
  })
  it('average daily rate ignores cancelled stays and cleaning fees', () => {
    expect(averageDailyRate([b({ id: '1' }), b({ id: '2', nightly_total: 6000, nights: 2 }), b({ id: '3', status: 'cancelled' })], '2026-11-01', '2026-12-01')).toBe(3000)
    expect(averageDailyRate([], '2026-11-01', '2026-12-01')).toBe(0)
  })
  const pay = (booking_id: string, amount: number, kind = 'deposit', at = '2026-11-02T10:00:00Z'): RPayment => ({ booking_id, kind, status: 'succeeded', amount, confirmed_at: at })
  it('revenue nets refunds, skips unsuccessful payments and uses Nairobi dates', () => {
    const bookings = [b({ id: '1' }), b({ id: '2', property_id: 'p2', source: 'walk_in' })]
    const payments = [pay('1', 5000), pay('1', 1000, 'refund'), pay('2', 3000), { ...pay('2', 999), status: 'failed' }, pay('1', 700, 'balance', '2026-10-31T22:00:00Z')]
    // 22:00 UTC on 31 Oct is 01:00 on 1 Nov in Nairobi, so it counts for November
    expect(revenueBy(payments, bookings, (x) => x.property_id, '2026-11-01', '2026-12-01')).toEqual(new Map([['p1', 4700], ['p2', 3000]]))
    expect(revenueBy(payments, bookings, (x) => x.source, '2026-11-01', '2026-12-01').get('walk_in')).toBe(3000)
    expect(revenueBy(payments, bookings, (x) => x.property_id, '2026-12-01', '2027-01-01').size).toBe(0)
  })
  it('status counts, cancellation rate and top guests', () => {
    const list = [b({ id: '1' }), b({ id: '2', status: 'cancelled' }), b({ id: '3', status: 'blocked', guest_id: null }), b({ id: '4', guest_id: 'g2' })]
    expect(statusCounts(list).get('checked_out')).toBe(2)
    expect(statusCounts(list).has('blocked')).toBe(false)
    expect(cancellationRate(list)).toBe(33.3)
    expect(cancellationRate([])).toBe(0)
    const top = topGuests(list, [pay('1', 5000), pay('4', 8000)], new Map([['g1', 'Ann'], ['g2', 'Bob']]))
    expect(top.map((t) => [t.name, t.paid])).toEqual([['Bob', 8000], ['Ann', 5000]])
  })
})
