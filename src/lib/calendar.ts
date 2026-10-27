import { addDays, diffDays } from './dates'

export type BarLayout = {
  /** 1-based grid column offset within the day columns (first day = 1). `end` is exclusive. */
  start: number
  end: number
  clippedLeft: boolean
  clippedRight: boolean
}

/**
 * Where a stay [checkIn, checkOut) sits in a window of `days` columns starting at `windowStart`.
 * Each column is one NIGHT, so a stay covers checkIn .. checkOut-1. Returns null if it is outside the window.
 */
export function layoutBar(checkIn: string, checkOut: string, windowStart: string, days: number): BarLayout | null {
  const startIdx = diffDays(windowStart, checkIn)
  const endIdx = diffDays(windowStart, checkOut) // exclusive
  if (endIdx <= 0 || startIdx >= days) return null
  const s = Math.max(startIdx, 0)
  const e = Math.min(endIdx, days)
  return { start: s + 1, end: e + 1, clippedLeft: startIdx < 0, clippedRight: endIdx > days }
}

export function windowDays(start: string, days: number): string[] {
  return Array.from({ length: days }, (_, i) => addDays(start, i))
}

/** Normalises a drag/tap selection (either direction) to a [from, toExclusive) night range. */
export function selectionRange(a: string, b: string): { from: string; to: string; nights: number } {
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return { from: lo, to: addDays(hi, 1), nights: diffDays(lo, hi) + 1 }
}
