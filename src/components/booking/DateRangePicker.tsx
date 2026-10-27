import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { addDays, addMonths, eachDay, formatMonth, isoWeekday, monthStart, parseYmd, todayNairobi } from '~/lib/dates'
import type { DateRange } from '~/lib/public-api'
import { cn } from '~/lib/utils'

type Props = {
  checkIn?: string
  checkOut?: string
  onChange: (v: { checkIn?: string; checkOut?: string }) => void
  /** Occupied [start, end) ranges. Nights inside are not selectable; the end day itself can be a check-out day. */
  blocked?: DateRange[]
  minNights?: number
}

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Mobile-first range picker that greys out occupied nights (native date inputs cannot do this). */
export function DateRangePicker({ checkIn, checkOut, onChange, blocked = [], minNights = 1 }: Props) {
  const today = todayNairobi()
  const [month, setMonth] = useState(monthStart(checkIn ?? today))
  const [hover, setHover] = useState<string | undefined>()

  const occupied = useMemo(() => {
    const s = new Set<string>()
    for (const r of blocked) for (const d of eachDay(r.start_date, r.end_date)) s.add(d)
    return s
  }, [blocked])

  const rangeFree = (from: string, toExclusive: string) => eachDay(from, toExclusive).every((d) => !occupied.has(d))

  function pick(day: string) {
    if (!checkIn || checkOut || day <= checkIn) {
      onChange({ checkIn: day, checkOut: undefined })
      return
    }
    if (!rangeFree(checkIn, day)) {
      // Crossing a booked night: start again from this day if it is free.
      onChange({ checkIn: occupied.has(day) ? undefined : day, checkOut: undefined })
      return
    }
    onChange({ checkIn, checkOut: day })
  }

  const first = parseYmd(month)
  const lead = isoWeekday(month) - 1
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => addDays(month, i))]
  const previewEnd = checkIn && !checkOut ? hover : checkOut

  return (
    <div className="w-full max-w-sm select-none" role="group" aria-label="Choose your dates">
      <div className="mb-2 flex items-center justify-between">
        <button type="button" className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-muted disabled:opacity-40" aria-label="Previous month"
          disabled={month <= monthStart(today)} onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft className="h-5 w-5" /></button>
        <p className="font-medium" aria-live="polite">{formatMonth(month)}</p>
        <button type="button" className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-muted disabled:opacity-40" aria-label="Next month"
          disabled={month >= addMonths(today, 17)} onClick={() => setMonth(addMonths(month, 1))}><ChevronRight className="h-5 w-5" /></button>
      </div>
      <div className="grid grid-cols-7 text-center text-xs text-muted-foreground">{WEEK.map((w) => <div key={w} className="py-1">{w}</div>)}</div>
      <div className="grid grid-cols-7 gap-y-1">
        {cells.map((day, i) => {
          if (!day) return <div key={`b${i}`} />
          const past = day < today
          const taken = occupied.has(day)
          // A day can end a stay if we already have a check-in and the nights in between are free.
          const canCheckOut = !!checkIn && !checkOut && day > checkIn && rangeFree(checkIn, day) && !past
          const disabled = past || (taken && !canCheckOut)
          const isStart = day === checkIn
          const isEnd = day === checkOut
          const inRange = !!checkIn && !!previewEnd && day > checkIn && day < previewEnd
          return (
            <button
              key={day} type="button" disabled={disabled}
              onClick={() => pick(day)} onMouseEnter={() => setHover(day)} onFocus={() => setHover(day)}
              aria-label={`${day}${taken ? ', booked' : ''}${isStart ? ', check-in' : ''}${isEnd ? ', check-out' : ''}`}
              aria-pressed={isStart || isEnd}
              className={cn(
                'relative h-11 text-sm tabular-nums transition-colors',
                inRange && 'bg-brand/15',
                (isStart || isEnd) && 'rounded-md bg-brand font-semibold text-brand-foreground',
                !isStart && !isEnd && !disabled && 'rounded-md hover:bg-muted',
                disabled && 'cursor-not-allowed text-muted-foreground/50',
                taken && !isStart && !isEnd && 'line-through',
              )}
            >
              {Number(day.slice(8))}
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {!checkIn ? 'Pick your check-in day.' : !checkOut ? 'Now pick your check-out day.' : 'Tap a day to change your dates.'}
        {minNights > 1 && ` Minimum stay: ${minNights} nights.`}
      </p>
    </div>
  )
}
