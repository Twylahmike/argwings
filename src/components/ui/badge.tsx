import * as React from 'react'
import { cn } from '~/lib/utils'
import { STATUS_LABEL, type BookingStatus, type TaskStatus, type PaymentStatus } from '~/lib/types'

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium', className)} {...props} />
}

/** One badge component for every booking status so colours match the calendar everywhere. */
export function StatusBadge({ status, className }: { status: BookingStatus; className?: string }) {
  const c = `hsl(var(--st-${status}))`
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium', className)}
      style={{ color: c, borderColor: `color-mix(in srgb, ${c} 45%, transparent)`, background: `color-mix(in srgb, ${c} 12%, transparent)` }}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
      {STATUS_LABEL[status]}
    </span>
  )
}

const TASK_STYLE: Record<TaskStatus, { label: string; color: string }> = {
  dirty: { label: 'Dirty', color: 'var(--st-cancelled)' },
  in_progress: { label: 'In progress', color: 'var(--st-pending)' },
  clean: { label: 'Clean', color: 'var(--st-confirmed)' },
  inspected: { label: 'Inspected', color: 'var(--st-checked_in)' },
}
export function TaskBadge({ status }: { status: TaskStatus }) {
  const s = TASK_STYLE[status]
  const c = `hsl(${s.color})`
  return (
    <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium"
      style={{ color: c, borderColor: `color-mix(in srgb, ${c} 45%, transparent)`, background: `color-mix(in srgb, ${c} 12%, transparent)` }}>
      {s.label}
    </span>
  )
}

const PAY_STYLE: Record<PaymentStatus, string> = {
  pending: 'var(--st-pending)', succeeded: 'var(--st-confirmed)', failed: 'var(--st-cancelled)', cancelled: 'var(--st-expired)',
}
export function PaymentBadge({ status }: { status: PaymentStatus }) {
  const c = `hsl(${PAY_STYLE[status]})`
  return (
    <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize"
      style={{ color: c, borderColor: `color-mix(in srgb, ${c} 45%, transparent)`, background: `color-mix(in srgb, ${c} 12%, transparent)` }}>
      {status}
    </span>
  )
}
