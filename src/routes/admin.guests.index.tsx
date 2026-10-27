import { useMemo, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Search, Users } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import type { Guest } from '~/lib/types'
import { formatDate } from '~/lib/dates'
import { formatPhoneLocal } from '~/lib/phone'
import { Input } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, TableWrap, td, th } from '~/components/ui/misc'
import { Money } from '~/components/booking/BookingBits'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/guests/')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: GuestsPage,
})

/** id numbers are sensitive: lists only ever show the last three characters. */
export const maskId = (v: string | null) => (v ? '•'.repeat(Math.max(v.length - 3, 0)) + v.slice(-3) : '')

function GuestsPage() {
  const { scopeIds } = useAdmin()
  const [term, setTerm] = useState('')
  const q = useQuery({
    queryKey: ['guests', scopeIds],
    queryFn: async () => {
      const [g, b] = await Promise.all([
        sb().from('guests').select('id, full_name, phone, email, id_number, anonymised_at').order('full_name').limit(2000),
        sb().from('bookings').select('guest_id, check_in, status, total_amount, amount_paid').in('property_id', scopeIds).not('guest_id', 'is', null).limit(5000),
      ])
      if (g.error) throw g.error
      if (b.error) throw b.error
      const stats = new Map<string, { stays: number; spent: number; last: string }>()
      for (const x of b.data) {
        if (!['confirmed', 'checked_in', 'checked_out'].includes(x.status)) continue
        const s = stats.get(x.guest_id!) ?? { stays: 0, spent: 0, last: '' }
        s.stays += x.status === 'checked_out' ? 1 : 0
        s.spent += x.amount_paid
        if (x.check_in > s.last) s.last = x.check_in
        stats.set(x.guest_id!, s)
      }
      // Only guests with a booking in the selected properties (managers see no others anyway).
      const ids = new Set(b.data.map((x) => x.guest_id))
      return (g.data as Pick<Guest, 'id' | 'full_name' | 'phone' | 'email' | 'id_number' | 'anonymised_at'>[])
        .filter((x) => ids.has(x.id)).map((x) => ({ ...x, ...(stats.get(x.id) ?? { stays: 0, spent: 0, last: '' }) }))
    },
  })
  const rows = useMemo(() => {
    const t = term.trim().toLowerCase(); const d = t.replace(/\D/g, '')
    return (q.data ?? []).filter((g) => !t || g.full_name.toLowerCase().includes(t) || (d.length >= 3 && g.phone.includes(d.replace(/^0/, '254'))) || (g.email ?? '').toLowerCase().includes(t))
  }, [q.data, term])
  return (
    <div>
      <PageHeader title="Guests" description="Everyone who has booked with you, with their stay history." />
      <div className="relative mb-4 max-w-md">
        <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" aria-hidden />
        <Input aria-label="Search guests" className="pl-9" placeholder="Search name, phone or email" value={term} onChange={(e) => setTerm(e.target.value)} />
      </div>
      {q.isLoading && <Skeleton className="h-64" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && rows.length === 0 && <EmptyState icon={Users} title="No guests found" description="Guests appear here as soon as they book." />}
      {rows.length > 0 && (
        <TableWrap>
          <thead><tr>{['Guest', 'Phone', 'Email', 'ID', 'Completed stays', 'Total paid', 'Last stay'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">
            {rows.map((g) => (
              <tr key={g.id} className="hover:bg-muted/40">
                <td className={td}><Link to="/admin/guests/$id" params={{ id: g.id }} className="font-medium text-brand hover:underline">{g.full_name}</Link></td>
                <td className={td}>{formatPhoneLocal(g.phone)}</td>
                <td className={td}>{g.email}</td>
                <td className={`${td} font-mono text-xs`}>{maskId(g.id_number)}</td>
                <td className={td}>{g.stays}</td>
                <td className={td}><Money value={g.spent} /></td>
                <td className={td}>{g.last ? formatDate(g.last) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  )
}
