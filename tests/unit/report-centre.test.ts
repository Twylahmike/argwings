import { describe, expect, it } from 'vitest'
import { buildReport, type ReportData, type RBook, type RPay } from '../../src/lib/report-centre'

const b = (o: Partial<RBook>): RBook => ({ id: 'b', reference: 'R', property_id: 'p1', unit_id: 'u1', guest_id: 'g1', check_in: '2026-03-01', check_out: '2026-03-04', nights: 3, status: 'confirmed', source: 'website', nightly_total: 15000, total_amount: 15000, amount_paid: 5000, cancel_reason: null, cancelled_at: null, created_at: '2026-02-20T10:00:00Z', ...o })
const p = (o: Partial<RPay>): RPay => ({ booking_id: 'b', reference: 'R', property_id: 'p1', kind: 'deposit', method: 'cash', amount: 5000, verified: true, confirmed_at: '2026-03-02T09:00:00Z', mpesa_receipt: null, ...o })
const data = (o: Partial<ReportData> = {}): ReportData => ({
  bookings: [b({}), b({ id: 'c', reference: 'C', status: 'cancelled', cancel_reason: 'Guest asked', total_amount: 9000 }), b({ id: 'x', status: 'blocked' })],
  payments: [p({}), p({ amount: 1000, kind: 'refund' }), p({ amount: 7000, verified: false })],
  expenses: [{ property_id: 'p1', category: 'utilities', amount: 1200, expense_date: '2026-03-03', description: null, status: 'approved', voided: false }, { property_id: 'p1', category: 'rent', amount: 9999, expense_date: '2026-03-03', description: null, status: 'pending', voided: false }],
  properties: new Map([['p1', 'Lavington']]), units: new Map([['u1', { name: 'A1', property_id: 'p1' }]]), guests: new Map([['g1', 'Amina']]), ...o,
})

describe('report centre', () => {
  it('sales reports count verified money only and subtract refunds', () => {
    const r = buildReport('daily', data(), '2026-03-01', '2026-03-31')
    expect(r.rows).toEqual([['2026-03-02', 1, 5000, 1000, 4000]])
    expect(r.totals?.[4]).toBe(4000)
    expect(buildReport('monthly', data(), '2026-03-01', '2026-03-31').rows[0][0]).toBe('2026-03')
    expect(buildReport('annual', data(), '2026-01-01', '2026-12-31').rows[0][0]).toBe('2026')
    expect(buildReport('weekly', data(), '2026-03-01', '2026-03-31').rows[0][0]).toBe('2026-03-02') // Monday
  })
  it('occupancy: nights sold / (rooms x days), blocked and cancelled excluded', () => {
    const r = buildReport('occupancy', data(), '2026-03-01', '2026-03-10')
    expect(r.rows[0]).toEqual(['Lavington', 1, 10, 3, 30])
  })
  it('clips nights to the report window', () => {
    const r = buildReport('occupancy', data(), '2026-03-02', '2026-03-10')
    expect(r.rows[0][3]).toBe(2)
  })
  it('cancellations, outstanding, expenses (approved only), profitability', () => {
    expect(buildReport('cancellations', data(), '2026-03-01', '2026-03-31').rows).toHaveLength(1)
    expect(buildReport('outstanding', data(), '2026-03-01', '2026-03-31').totals?.[7]).toBe(10000)
    expect(buildReport('expenses', data(), '2026-03-01', '2026-03-31').totals?.[4]).toBe(1200)
    const pr = buildReport('profitability', data(), '2026-03-01', '2026-03-31')
    expect(pr.rows[0]).toEqual(['Lavington', 4000, 1200, 2800, 70])
  })
  it('all 14 reports build on empty data without throwing', () => {
    const empty = data({ bookings: [], payments: [], expenses: [] })
    for (const k of ['daily', 'weekly', 'monthly', 'annual', 'occupancy', 'bookings', 'cancellations', 'guests', 'payments', 'outstanding', 'expenses', 'profitability', 'accommodation', 'sources'] as const) {
      const r = buildReport(k, empty, '2026-03-01', '2026-03-31')
      expect(r.columns.length).toBeGreaterThan(0)
      if (r.totals) expect(r.totals.length).toBe(r.columns.length)
    }
  })
})
