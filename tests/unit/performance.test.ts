import { describe, expect, it } from 'vitest'
import { changePct, rangeFor } from '../../src/components/dashboard/Performance'

describe('dashboard period helpers', () => {
  const today = '2026-11-04'
  it('builds preset ranges', () => {
    expect(rangeFor('today', today, { from: '', to: '' })).toEqual({ from: today, to: today })
    expect(rangeFor('7d', today, { from: '', to: '' })).toEqual({ from: '2026-10-29', to: today })
    expect(rangeFor('30d', today, { from: '', to: '' })).toEqual({ from: '2026-10-06', to: today })
    expect(rangeFor('month', today, { from: '', to: '' })).toEqual({ from: '2026-11-01', to: today })
    expect(rangeFor('year', today, { from: '', to: '' })).toEqual({ from: '2026-01-01', to: today })
    expect(rangeFor('custom', today, { from: '2026-01-01', to: '2026-01-31' })).toEqual({ from: '2026-01-01', to: '2026-01-31' })
  })
  it('computes change without dividing by zero', () => {
    expect(changePct(150, 100)).toBe(50)
    expect(changePct(50, 100)).toBe(-50)
    expect(changePct(0, 0)).toBe(0)
    expect(changePct(10, 0)).toBeNull()
  })
})
