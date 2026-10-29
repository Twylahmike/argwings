import { useMemo, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Download, Plus, Search } from 'lucide-react'
import { requireRole } from '~/lib/auth'
import { fetchBookings } from '~/lib/bookings-api'
import { STATUS_LABEL, SOURCE_LABEL, type BookingStatus } from '~/lib/types'
import { addDays, formatDate, todayNairobi } from '~/lib/dates'
import { formatPhoneLocal } from '~/lib/phone'
import { toCsv, downloadCsv } from '~/lib/csv'
import { Button } from '~/components/ui/button'
import { StatusBadge } from '~/components/ui/badge'
import { Input, Select } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, TableWrap, td, th } from '~/components/ui/misc'
import { BalanceCell, BookingLink, Money } from '~/components/booking/BookingBits'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/bookings/')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: BookingsPage,
})

const STATUSES = Object.keys(STATUS_LABEL) as BookingStatus[]

function BookingsPage() {
  const { scopeIds } = useAdmin()
  const today = todayNairobi()
  const [status, setStatus] = useState<'' | BookingStatus>('')
  const [from, setFrom] = useState(addDays(today, -30))
  const [to, setTo] = useState(addDays(today, 180))
  const [balanceDue, setBalanceDue] = useState(false)
  const [search, setSearch] = useState('')

  const q = useQuery({
    queryKey: ['bookings', scopeIds, status, from, to],
    queryFn: () => fetchBookings({ propertyIds: scopeIds, statuses: status ? [status] : undefined, from, to }),
  })

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase()
    const digits = term.replace(/\D/g, '')
    return (q.data ?? []).filter((b) => {
      if (balanceDue && !(b.total_amount - b.amount_paid > 0 && ['pending', 'confirmed', 'checked_in', 'checked_out'].includes(b.status))) return false
      if (!term) return true
      return b.reference.toLowerCase().includes(term) || (b.guest?.full_name ?? '').toLowerCase().includes(term) || (digits.length >= 3 && (b.guest?.phone ?? '').includes(digits.replace(/^0/, '254')))
    })
  }, [q.data, search, balanceDue])

  function exportCsv() {
    downloadCsv(`bookings-${today}.csv`, toCsv(rows, [
      { header: 'Reference', value: (b) => b.reference }, { header: 'Guest', value: (b) => b.guest?.full_name }, { header: 'Phone', value: (b) => b.guest?.phone },
      { header: 'Property', value: (b) => b.property.name }, { header: 'Unit', value: (b) => b.unit.name },
      { header: 'Check-in', value: (b) => b.check_in }, { header: 'Check-out', value: (b) => b.check_out }, { header: 'Nights', value: (b) => b.nights },
      { header: 'Status', value: (b) => STATUS_LABEL[b.status] }, { header: 'Source', value: (b) => SOURCE_LABEL[b.source] },
      { header: 'Total (KES)', value: (b) => b.total_amount }, { header: 'Paid (KES)', value: (b) => b.amount_paid },
      { header: 'Balance (KES)', value: (b) => Math.max(0, b.total_amount - b.amount_paid) },
    ]))
  }

  return (
    <div>
      <PageHeader title="Bookings" actions={<>
        <Button variant="outline" onClick={exportCsv} disabled={!rows.length}><Download className="h-4 w-4" /> Export CSV</Button>
        <Button asChild><Link to="/admin/bookings/new"><Plus className="h-4 w-4" /> New booking</Link></Button>
      </>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input aria-label="Search by reference, name or phone" placeholder="Search reference, name or phone" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as '' | BookingStatus)}>
          <option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </Select>
        <div className="grid grid-cols-2 gap-3 sm:contents">
          <Input aria-label="Stays ending on or after" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
  <Input aria-label="Stays starting on or before" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <label className="flex h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={balanceDue} onChange={(e) => setBalanceDue(e.target.checked)} /> Balance due</label>
      </div>
      {q.isLoading && <Skeleton className="h-64" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && rows.length === 0 && <EmptyState title="No bookings match" description="Try a wider date range or clear the filters." action={<Button asChild><Link to="/admin/bookings/new">Create a booking</Link></Button>} />}
      {rows.length > 0 && (
        <>
          <p className="mb-2 text-sm text-muted-foreground">{rows.length} booking{rows.length === 1 ? '' : 's'}{q.data && q.data.length >= 1000 ? ' (showing the latest 1,000: narrow the dates)' : ''}</p>
          <ul className="grid gap-3 md:hidden" aria-label="Bookings">
            {rows.map((b) => (
              <li key={b.id} className="rounded-xl border bg-card p-4">
                <div className="flex items-start justify-between gap-2"><div><BookingLink id={b.id}>{b.reference}</BookingLink><p className="text-sm">{b.guest?.full_name ?? 'Blocked dates'}</p></div><StatusBadge status={b.status} /></div>
                <p className="mt-2 text-sm text-muted-foreground">{b.property.name} · {b.unit.name}</p>
                <p className="text-sm">{formatDate(b.check_in)} → {formatDate(b.check_out)} · {b.nights} night{b.nights === 1 ? '' : 's'}</p>
                {b.status !== 'blocked' && <p className="mt-2 flex justify-between text-sm"><span>Total <Money value={b.total_amount} /></span><span>Balance <BalanceCell b={b} /></span></p>}
                {b.payment_review && <p className="mt-1 text-xs font-medium text-danger">Payment needs review</p>}
              </li>
            ))}
          </ul>
          <div className="hidden md:block">
          <TableWrap>
            <thead><tr>
              {['Reference', 'Guest', 'Property / unit', 'Dates', 'Nights', 'Status', 'Total', 'Paid', 'Balance', 'Source'].map((h) => <th key={h} className={th}>{h}</th>)}
            </tr></thead>
            <tbody className="divide-y">
              {rows.map((b) => (
                <tr key={b.id} className="hover:bg-muted/40">
                  <td className={td}><BookingLink id={b.id}>{b.reference}</BookingLink></td>
                  <td className={td}>{b.guest ? <><p>{b.guest.full_name}</p><p className="text-xs text-muted-foreground">{formatPhoneLocal(b.guest.phone)}</p></> : <span className="text-muted-foreground">Blocked dates</span>}</td>
                  <td className={td}><p>{b.property.name}</p><p className="text-xs text-muted-foreground">{b.unit.name}</p></td>
                  <td className={`${td} whitespace-nowrap`}>{formatDate(b.check_in)}<br /><span className="text-muted-foreground">to {formatDate(b.check_out)}</span></td>
                  <td className={td}>{b.nights}</td>
                  <td className={td}><StatusBadge status={b.status} />{b.payment_review && <p className="mt-1 text-xs font-medium text-danger">Payment needs review</p>}</td>
                  <td className={td}>{b.status === 'blocked' ? '—' : <Money value={b.total_amount} />}</td>
                  <td className={td}>{b.status === 'blocked' ? '—' : <Money value={b.amount_paid} />}</td>
                  <td className={td}><BalanceCell b={b} /></td>
                  <td className={td}>{SOURCE_LABEL[b.source]}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          </div>
        </>
      )}
    </div>
  )
}
