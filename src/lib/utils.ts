import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function errMessage(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message || fallback
  }
  return fallback
}

/** Postgres exclusion-constraint violation = someone else got those dates first. */
export function isDatesTaken(e: unknown): boolean {
  const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : ''
  return code === '23P01' || /dates_taken|23P01|no_overlapping_bookings/.test(errMessage(e, ''))
}
export const DATES_TAKEN_MESSAGE = 'Those dates were just taken. Please choose other dates.'
