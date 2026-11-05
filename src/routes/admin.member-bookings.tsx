import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { formatDate } from '~/lib/dates'
import { formatKES } from '~/lib/money'
import { StatusBadge } from '~/components/ui/badge'
import { EmptyState, ErrorState, PageHeader, Skeleton, TableWrap, Tabs, td, th } from '~/components/ui/misc'
import type { BookingStatus } from '~/lib/types'

export const Route = createFileRoute('/admin/member-bookings')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: Page,
})

type Kind = 'member' | 'guest'
type Row = { id: string; reference: string; status: string; check_in: string; check_out: string; total_amount: number; amount_paid: number; discount: number; guest: { full_name: string } | null; customer: { full_name: string } | null }

function Page() {
  const [kind, setKind] = useState<Kind>('member')
  const q = useQuery({
    queryKey: ['bookings-by-kind', kind],
    queryFn: async () => {
      const cols: string = 'id, reference, status, check_in, check_out, total_amount, amount_paid, discount, guest:guests(full_name), customer:customer_profiles(full_name)'
      const base = sb().from('bookings').select(cols).neq('status', 'blocked').order('created_at', { ascending: false }).limit(200)
      const { data, error } = kind === 'member' ? await base.not('customer_id', 'is', null) : await base.is('customer_id', null).not('guest_id', 'is', null)
      if (error) throw error
      return data as unknown as Row[]
    },
  })
  return (
    <div>
      <PageHeader title="Member and guest bookings" description="Member bookings were made while signed in (or added to an account later). Guest bookings were made without an account. Latest 200." />
      <div className="mb-4"><Tabs<Kind> label="Booking type" value={kind} onChange={setKind} tabs={[{ value: 'member', label: 'Member bookings' }, { value: 'guest', label: 'Guest bookings' }]} /></div>
      {q.isLoading && <Skeleton className="h-48" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && !q.data.length && <EmptyState title={`No ${kind} bookings yet`} />}
      {!!q.data?.length && (
        <TableWrap>
          <thead><tr>{['Reference', kind === 'member' ? 'Member' : 'Guest', 'Stay', 'Total', 'Paid', 'Discount', 'Status'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">{q.data.map((b) => (
            <tr key={b.id}>
              <td className={td}><Link to="/admin/bookings/$id" params={{ id: b.id }} className="font-medium text-brand hover:underline">{b.reference}</Link></td>
              <td className={td}>{(kind === 'member' ? b.customer?.full_name : null) ?? b.guest?.full_name ?? '—'}</td>
              <td className={`${td} whitespace-nowrap`}>{formatDate(b.check_in)} to {formatDate(b.check_out)}</td>
              <td className={td}>{formatKES(b.total_amount)}</td><td className={td}>{formatKES(b.amount_paid)}</td><td className={td}>{b.discount > 0 ? formatKES(b.discount) : '—'}</td>
              <td className={td}><StatusBadge status={b.status as BookingStatus} /></td>
            </tr>))}</tbody>
        </TableWrap>
      )}
    </div>
  )
}
