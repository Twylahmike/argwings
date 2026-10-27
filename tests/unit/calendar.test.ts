import { describe, expect, it } from 'vitest'
import { layoutBar, selectionRange, windowDays } from '../../src/lib/calendar'

describe('calendar layout', () => {
  const start = '2026-11-02'
  it('places a stay on its nights (check-out day is free)', () => {
    expect(layoutBar('2026-11-04', '2026-11-07', start, 14)).toEqual({ start: 3, end: 6, clippedLeft: false, clippedRight: false })
  })
  it('back-to-back stays sit side by side without overlapping', () => {
    const a = layoutBar('2026-11-04', '2026-11-06', start, 14)!
    const b = layoutBar('2026-11-06', '2026-11-08', start, 14)!
    expect(a.end).toBe(b.start)
  })
  it('clips stays that start before or end after the window', () => {
    expect(layoutBar('2026-10-30', '2026-11-04', start, 14)).toEqual({ start: 1, end: 3, clippedLeft: true, clippedRight: false })
    expect(layoutBar('2026-11-14', '2026-11-20', start, 14)).toEqual({ start: 13, end: 15, clippedLeft: false, clippedRight: true })
  })
  it('ignores stays fully outside', () => {
    expect(layoutBar('2026-10-28', '2026-11-02', start, 14)).toBeNull()
    expect(layoutBar('2026-11-16', '2026-11-18', start, 14)).toBeNull()
  })
  it('selection works in both directions', () => {
    expect(selectionRange('2026-11-05', '2026-11-03')).toEqual({ from: '2026-11-03', to: '2026-11-06', nights: 3 })
    expect(selectionRange('2026-11-05', '2026-11-05')).toEqual({ from: '2026-11-05', to: '2026-11-06', nights: 1 })
  })
  it('windowDays lists consecutive days', () => {
    expect(windowDays('2026-11-30', 3)).toEqual(['2026-11-30', '2026-12-01', '2026-12-02'])
  })
})
