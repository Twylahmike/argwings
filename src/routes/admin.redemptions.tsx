import { createFileRoute, Link } from '@tanstack/react-router'
import { requireRole } from '~/lib/auth'
import { formatDateTime } from '~/lib/dates'
import { formatKES } from '~/lib/money'
import { LedgerPage } from '~/components/admin/LedgerPage'

export const Route = createFileRoute('/admin/redemptions')({ beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']), component: Page })
type R = { id: string; created_at: string; released_at: string | null; amount: number; offer: string; code: string; customer: string; booking_id: string; reference: string }
function Page() {
  return <LedgerPage<R> title="Reward redemptions" description="Every member offer applied to a booking. A cancelled or expired booking releases its reward back to the customer." fn="admin_redemptions" empty="No offers have been redeemed yet"
    cols={[
      { head: 'When', cell: (r) => formatDateTime(r.created_at) }, { head: 'Customer', cell: (r) => r.customer }, { head: 'Offer', cell: (r) => <>{r.offer}<p className="font-mono text-xs text-muted-foreground">{r.code}</p></> },
      { head: 'Booking', cell: (r) => <Link to="/admin/bookings/$id" params={{ id: r.booking_id }} className="underline">{r.reference}</Link> }, { head: 'Discount', cell: (r) => formatKES(r.amount) },
      { head: 'Status', cell: (r) => (r.released_at ? `Released ${formatDateTime(r.released_at)}` : 'Applied') },
    ]} />
}
