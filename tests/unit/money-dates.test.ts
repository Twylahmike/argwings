import { describe, expect, it } from 'vitest'
import { balanceOf, formatKES, parseKES } from '../../src/lib/money'
import {
  addDays, addMonths, diffDays, eachDay, formatDate, formatDateTime, formatTime, isoWeekday, todayNairobi,
} from '../../src/lib/dates'

describe('money', () => {
  it('formats integer KES', () => {
    expect(formatKES(12500)).toBe('KES 12,500')
    expect(formatKES(0)).toBe('KES 0')
    expect(formatKES(null)).toBe('KES 0')
    expect(formatKES(1234567)).toBe('KES 1,234,567')
  })
  it('parses user input', () => {
    expect(parseKES('12,500')).toBe(12500)
    expect(parseKES('KES 12500')).toBe(12500)
    expect(parseKES('12.5')).toBeNull()
    expect(parseKES('abc')).toBeNull()
    expect(parseKES('')).toBeNull()
  })
  it('balance is never negative', () => {
    expect(balanceOf(10000, 4000)).toBe(6000)
    expect(balanceOf(10000, 12000)).toBe(0)
  })
})

describe('dates', () => {
  it('formats like Tue 3 Nov 2026 without timezone drift', () => {
    expect(formatDate('2026-11-03')).toBe('Tue 3 Nov 2026')
    expect(formatDate('2026-01-01')).toBe('Thu 1 Jan 2026')
    expect(formatDate(null)).toBe('')
  })
  it('formats instants in Nairobi 24h, never UTC', () => {
    // 21:30 UTC is 00:30 the next day in Nairobi (UTC+3)
    expect(formatDateTime('2026-11-03T21:30:00Z')).toBe('Wed 4 Nov 2026, 00:30')
    expect(formatDateTime('2026-11-03T05:05:00Z')).toBe('Tue 3 Nov 2026, 08:05')
  })
  it('todayNairobi follows Nairobi, not UTC', () => {
    expect(todayNairobi(new Date('2026-11-03T21:30:00Z'))).toBe('2026-11-04')
    expect(todayNairobi(new Date('2026-11-03T20:59:00Z'))).toBe('2026-11-03')
  })
  it('date arithmetic', () => {
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(diffDays('2026-11-03', '2026-11-08')).toBe(5)
    expect(eachDay('2026-11-03', '2026-11-06')).toEqual(['2026-11-03', '2026-11-04', '2026-11-05'])
    expect(eachDay('2026-11-03', '2026-11-03')).toEqual([])
    expect(addMonths('2026-11-17', 1)).toBe('2026-12-01')
    expect(addMonths('2026-01-31', -1)).toBe('2025-12-01')
  })
  it('iso weekday matches Postgres isodow (Mon=1 .. Sun=7)', () => {
    expect(isoWeekday('2026-11-02')).toBe(1)
    expect(isoWeekday('2026-11-06')).toBe(5)
    expect(isoWeekday('2026-11-07')).toBe(6)
    expect(isoWeekday('2026-11-08')).toBe(7)
  })
  it('formats times as 24h', () => {
    expect(formatTime('14:00:00')).toBe('14:00')
    expect(formatTime(null)).toBe('')
  })
})
