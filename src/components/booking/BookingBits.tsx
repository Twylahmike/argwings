import { Link } from '@tanstack/react-router'
import { formatKES } from '~/lib/money'
import { cn } from '~/lib/utils'
import { balance, type BookingRow } from '~/lib/bookings-api'

export function Money({ value, className }: { value: number; className?: string }) {
  return <span className={cn('tabular-nums', className)}>{formatKES(value)}</span>
}

export function BalanceCell({ b }: { b: Pick<BookingRow, 'total_amount' | 'amount_paid' | 'status'> }) {
  const bal = balance(b)
  if (b.status === 'blocked') return <span className="text-muted-foreground">—</span>
  return <Money value={bal} className={bal > 0 && ['confirmed', 'checked_in', 'pending'].includes(b.status) ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-muted-foreground'} />
}

export function BookingLink({ id, children }: { id: string; children: React.ReactNode }) {
  return <Link to="/admin/bookings/$id" params={{ id }} className="font-medium text-brand underline-offset-4 hover:underline">{children}</Link>
}
