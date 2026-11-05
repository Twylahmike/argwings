import { createFileRoute } from '@tanstack/react-router'
import { requireRole } from '~/lib/auth'
import { formatDateTime } from '~/lib/dates'
import { LedgerPage } from '~/components/admin/LedgerPage'

export const Route = createFileRoute('/admin/loyalty')({ beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']), component: Page })
type R = { id: string; created_at: string; kind: string; points: number; note: string | null; customer: string; reference: string | null }
function Page() {
  return <LedgerPage<R> title="Loyalty transactions" description="Points earned from completed stays and adjusted by staff. Entries are never edited or deleted." fn="admin_loyalty_ledger" empty="No points have been recorded yet"
    cols={[
      { head: 'When', cell: (r) => formatDateTime(r.created_at) }, { head: 'Customer', cell: (r) => r.customer }, { head: 'Type', cell: (r) => <span className="capitalize">{r.kind}</span> },
      { head: 'Points', cell: (r) => <b className={r.points < 0 ? 'text-danger' : ''}>{r.points > 0 ? '+' : ''}{r.points}</b> }, { head: 'Note', cell: (r) => <>{r.note ?? ''}{r.reference ? <span className="text-muted-foreground"> · {r.reference}</span> : null}</> },
    ]} />
}
