import { createFileRoute } from '@tanstack/react-router'
import { requireRole } from '~/lib/auth'
import { formatDateTime } from '~/lib/dates'
import { LedgerPage } from '~/components/admin/LedgerPage'

export const Route = createFileRoute('/admin/customer-activity')({ beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']), component: Page })
type R = { id: string; created_at: string; kind: string; detail: string | null; customer: string }
function Page() {
  return <LedgerPage<R> title="Customer activity" description="Sign-ups, offers issued and used, bookings, tier changes and account actions. The latest 300 events." fn="admin_customer_activity" empty="No customer activity yet"
    cols={[{ head: 'When', cell: (r) => formatDateTime(r.created_at) }, { head: 'Customer', cell: (r) => r.customer }, { head: 'Event', cell: (r) => <span className="capitalize">{r.kind.replace(/_/g, ' ')}</span> }, { head: 'Detail', cell: (r) => r.detail ?? '' }]} />
}
