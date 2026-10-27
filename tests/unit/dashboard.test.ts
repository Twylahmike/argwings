import { describe, expect, it } from 'vitest'
import { occupancyPct } from '../../src/lib/dashboard'

describe('occupancyPct', () => {
  const b = (check_in: string, check_out: string, status = 'confirmed') => ({ check_in, check_out, status })
  it('today: units occupied tonight / units', () => {
    expect(occupancyPct([b('2026-11-01', '2026-11-04'), b('2026-11-04', '2026-11-06'), b('2026-11-02', '2026-11-03', 'blocked')], 4, '2026-11-03', 1)).toBe(25)
  })
  it('next 7 days', () => {
    expect(occupancyPct([b('2026-11-03', '2026-11-10')], 2, '2026-11-03', 7)).toBe(50)
  })
  it('handles no units and caps at 100', () => {
    expect(occupancyPct([], 0, '2026-11-03', 7)).toBe(0)
    expect(occupancyPct([b('2026-11-03', '2026-11-04'), b('2026-11-03', '2026-11-04')], 1, '2026-11-03', 1)).toBe(100)
  })
})
