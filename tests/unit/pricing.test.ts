import { describe, expect, it } from 'vitest'
import { calcDeposit, fromRate, quoteStay, rangesOverlap } from '../../src/lib/pricing'

const unit = { base_rate: 5000, weekend_rate: 6000, cleaning_fee: 500, min_nights: 1 }

describe('quoteStay (mirror of SQL quote_stay)', () => {
  it('charges weekend rate on Fri and Sat nights only, plus cleaning once', () => {
    // 2026-11-05 is a Thursday: Thu 5000, Fri 6000, Sat 6000, Sun 5000
    const q = quoteStay(unit, [], '2026-11-05', '2026-11-09')
    expect(q.nights).toBe(4)
    expect(q.nightlyTotal).toBe(22000)
    expect(q.total).toBe(22500)
    expect(q.perNight.map((n) => n.kind)).toEqual(['base', 'weekend', 'weekend', 'base'])
  })
  it('uses base rate when there is no weekend rate', () => {
    const q = quoteStay({ ...unit, weekend_rate: null }, [], '2026-11-06', '2026-11-08')
    expect(q.nightlyTotal).toBe(10000)
  })
  it('seasonal override beats weekend and base; newest override wins on overlap', () => {
    const o = [
      { start_date: '2026-11-06', end_date: '2026-11-07', nightly_rate: 9000 },
      { start_date: '2026-11-06', end_date: '2026-11-06', nightly_rate: 1000 },
    ]
    const q = quoteStay(unit, o, '2026-11-05', '2026-11-09')
    expect(q.perNight.map((n) => n.rate)).toEqual([5000, 1000, 9000, 5000])
    expect(q.perNight[1].kind).toBe('override')
  })
  it('override end date is inclusive', () => {
    const q = quoteStay(unit, [{ start_date: '2026-11-02', end_date: '2026-11-03', nightly_rate: 7000 }], '2026-11-02', '2026-11-05')
    expect(q.perNight.map((n) => n.rate)).toEqual([7000, 7000, 5000])
  })
  it('enforces min nights and handles empty or inverted ranges', () => {
    expect(quoteStay({ ...unit, min_nights: 3 }, [], '2026-11-02', '2026-11-04').meetsMinNights).toBe(false)
    expect(quoteStay({ ...unit, min_nights: 3 }, [], '2026-11-02', '2026-11-05').meetsMinNights).toBe(true)
    expect(quoteStay(unit, [], '2026-11-05', '2026-11-05').total).toBe(0)
    expect(quoteStay(unit, [], '2026-11-06', '2026-11-05').nights).toBe(0)
  })
})

describe('calcDeposit', () => {
  it('rounds to a whole KES then up to the next KES 10', () => {
    expect(calcDeposit(22500, 50)).toBe(11250)
    expect(calcDeposit(10001, 50)).toBe(5010)
    expect(calcDeposit(12345, 30)).toBe(3710)
    expect(calcDeposit(12000, 50)).toBe(6000)
  })
  it('never exceeds the total', () => {
    expect(calcDeposit(5, 50)).toBe(5)
    expect(calcDeposit(0, 50)).toBe(0)
    expect(calcDeposit(1000, 100)).toBe(1000)
  })
})

describe('misc', () => {
  it('fromRate picks the cheaper of base and weekend', () => {
    expect(fromRate({ base_rate: 4500, weekend_rate: 5500 })).toBe(4500)
    expect(fromRate({ base_rate: 4500, weekend_rate: null })).toBe(4500)
    expect(fromRate({ base_rate: 6000, weekend_rate: 5000 })).toBe(5000)
  })
  it('half-open overlap: back-to-back is allowed', () => {
    expect(rangesOverlap('2026-11-01', '2026-11-05', '2026-11-05', '2026-11-07')).toBe(false)
    expect(rangesOverlap('2026-11-01', '2026-11-05', '2026-11-04', '2026-11-07')).toBe(true)
    expect(rangesOverlap('2026-11-04', '2026-11-07', '2026-11-01', '2026-11-05')).toBe(true)
  })
})
