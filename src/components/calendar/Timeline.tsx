import { memo, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react'
import { layoutBar, selectionRange, windowDays } from '~/lib/calendar'
import { formatDayMonth, isoWeekday, todayNairobi } from '~/lib/dates'
import { cn } from '~/lib/utils'
import type { BookingStatus } from '~/lib/types'

export type TimelineUnit = { id: string; name: string; code: string | null; property_id: string }
export type TimelineProperty = { id: string; name: string }
export type TimelineBooking = {
  id: string; unit_id: string; check_in: string; check_out: string; status: BookingStatus
  guestName: string | null; reference: string; balance: number; payment_review: boolean
}

type Sel = { unitId: string; a: string; b: string }

const DAY_W = 'var(--day-w)'

type Props = {
  start: string
  days: number
  properties: TimelineProperty[]
  units: TimelineUnit[]
  bookings: TimelineBooking[]
  /** unit_id -> { priority } for units with an open (dirty / in progress) housekeeping task */
  cleaning: Map<string, { priority: boolean }>
  onSelectRange: (unitId: string, from: string, to: string) => void
  onOpenBooking: (id: string) => void
}

export const Timeline = memo(function Timeline({ start, days, properties, units, bookings, cleaning, onSelectRange, onOpenBooking }: Props) {
  const today = todayNairobi()
  const cols = windowDays(start, days)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState<Sel | null>(null)
  const dragging = useRef(false)
  const touchAnchor = useRef(false)

  function finish(s: Sel) {
    const r = selectionRange(s.a, s.b)
    setSel(null)
    dragging.current = false
    touchAnchor.current = false
    onSelectRange(s.unitId, r.from, r.to)
  }

  // Mouse released outside the grid: finish with what was selected so far.
  const latest = useRef<Sel | null>(null)
  latest.current = sel
  useEffect(() => {
    const up = () => { if (dragging.current && latest.current) finish(latest.current) }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  })

  const busy = (unitId: string, day: string) => bookings.some((b) => b.unit_id === unitId && day >= b.check_in && day < b.check_out)

  return (
    <div className="overflow-x-auto rounded-xl border bg-card" style={{ ['--day-w' as string]: '2.75rem' }} role="grid" aria-label="Booking calendar. Each column is one night." >
      <div className="min-w-max">
        {/* header */}
        <div className="grid border-b bg-muted/50" style={{ gridTemplateColumns: `9.5rem repeat(${days}, ${DAY_W})` }} role="row">
          <div className="sticky left-0 z-20 bg-muted px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground" role="columnheader">Unit</div>
          {cols.map((d) => {
            const wd = isoWeekday(d)
            return (
              <div key={d} role="columnheader" className={cn('border-l py-1.5 text-center text-[11px] leading-tight', wd >= 6 && 'bg-muted', d === today && 'bg-brand/15 font-semibold text-brand')}>
                <div className="text-muted-foreground">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][wd - 1]}</div>
                <div className="text-sm tabular-nums">{Number(d.slice(8))}</div>
                {(d.endsWith('-01') || d === cols[0]) && <div className="text-[10px] uppercase text-muted-foreground">{formatDayMonth(d).split(' ')[1]}</div>}
              </div>
            )
          })}
        </div>

        {properties.map((p) => {
          const pu = units.filter((u) => u.property_id === p.id)
          if (!pu.length) return null
          const isCollapsed = collapsed.has(p.id)
          return (
            <section key={p.id} aria-label={p.name}>
              <button
                className="sticky left-0 flex h-10 w-full min-w-[24rem] items-center gap-2 border-b bg-muted/30 px-3 text-left text-sm font-semibold hover:bg-muted/60"
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n })}
              >
                {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />} {p.name}
                <span className="text-xs font-normal text-muted-foreground">{pu.length} unit{pu.length > 1 ? 's' : ''}</span>
              </button>
              {!isCollapsed && pu.map((u) => {
                const rowBookings = bookings.filter((b) => b.unit_id === u.id)
                const clean = cleaning.get(u.id)
                return (
                  <div key={u.id} role="row" className="grid border-b" style={{ gridTemplateColumns: `9.5rem repeat(${days}, ${DAY_W})` }}>
                    <div role="rowheader" className={cn('sticky left-0 z-20 flex h-14 flex-col justify-center border-r bg-card px-3', clean && 'shadow-[inset_3px_0_0_hsl(var(--st-pending))]')} style={{ gridRow: 1, gridColumn: 1 }}>
                      <span className="truncate text-sm font-medium">{u.name}</span>
                      {clean && <span className={cn('flex items-center gap-1 text-[11px]', clean.priority ? 'font-semibold text-danger' : 'text-amber-700 dark:text-amber-400')}><Sparkles className="h-3 w-3" aria-hidden /> {clean.priority ? 'Clean today!' : 'Needs cleaning'}</span>}
                    </div>
                    {cols.map((d, i) => {
                      const taken = busy(u.id, d)
                      const inSel = sel && sel.unitId === u.id && d >= (sel.a < sel.b ? sel.a : sel.b) && d <= (sel.a < sel.b ? sel.b : sel.a)
                      const wd = isoWeekday(d)
                      return (
                        <button
                          key={d} role="gridcell" disabled={taken}
                          aria-label={`${u.name}, ${d}${taken ? ', booked' : ', free'}`}
                          style={{ gridRow: 1, gridColumn: i + 2 }}
                          className={cn('h-14 border-l transition-colors', wd >= 6 && 'bg-muted/40', d === today && 'bg-brand/10', !taken && 'hover:bg-brand/15', inSel && 'bg-brand/30 hover:bg-brand/30', taken && 'pointer-events-none')}
                          onPointerDown={(e) => {
                            if (taken || e.pointerType === 'touch') return // touch uses tap, then tap (onClick below)
                            dragging.current = true
                            setSel({ unitId: u.id, a: d, b: d })
                          }}
                          onPointerEnter={() => { if (dragging.current && sel && sel.unitId === u.id && !busy(u.id, d)) setSel({ ...sel, b: d }) }}
                          onPointerUp={(e) => { if (e.pointerType !== 'touch' && dragging.current && sel) finish(sel) }}
                          onClick={(e) => {
                            const pt = (e.nativeEvent as PointerEvent).pointerType
                            if (taken || pt === 'mouse' || pt === 'pen') return // mouse is handled by the drag handlers above
                            // Touch and keyboard: first tap sets the start night, second tap sets the end night.
                            if (!sel || sel.unitId !== u.id || !touchAnchor.current) { touchAnchor.current = true; setSel({ unitId: u.id, a: d, b: d }); return }
                            finish({ ...sel, b: d })
                          }}
                        />
                      )
                    })}
                    {rowBookings.map((b) => {
                      const l = layoutBar(b.check_in, b.check_out, start, days)
                      if (!l) return null
                      const color = `hsl(var(--st-${b.status}))`
                      return (
                        <button
                          key={b.id} onClick={() => onOpenBooking(b.id)}
                          aria-label={`${b.guestName ?? 'Blocked'} ${b.check_in} to ${b.check_out}, ${b.status}`}
                          style={{
                            gridRow: 1, gridColumn: `${l.start + 1} / ${l.end + 1}`, zIndex: 10, color: 'hsl(var(--foreground))',
                            background: b.status === 'blocked'
                              ? `repeating-linear-gradient(45deg, color-mix(in srgb, ${color} 22%, transparent) 0 6px, color-mix(in srgb, ${color} 10%, transparent) 6px 12px)`
                              : `color-mix(in srgb, ${color} ${b.status === 'checked_out' ? 10 : 24}%, var(--color-card))`,
                            borderLeft: l.clippedLeft ? undefined : `4px solid ${color}`, borderRight: l.clippedRight ? undefined : undefined,
                            outline: b.payment_review ? '2px solid hsl(var(--danger))' : undefined,
                          }}
                          className={cn('my-1.5 mx-px flex min-w-0 flex-col justify-center overflow-hidden px-2 text-left text-xs shadow-sm hover:brightness-95', !l.clippedLeft && 'rounded-l-md', !l.clippedRight && 'rounded-r-md', b.status === 'checked_out' && 'opacity-70')}
                        >
                          <span className="truncate font-semibold">{b.guestName ?? 'Blocked'}</span>
                          {b.status !== 'blocked' && <span className="truncate text-[10px] opacity-80">{b.reference.slice(-9)}{b.balance > 0 && b.status !== 'checked_out' ? ` · owes ${b.balance.toLocaleString('en-US')}` : ''}</span>}
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
})
