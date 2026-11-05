import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, FileSpreadsheet, Printer } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { addDays, addMonths, formatDate, monthStart, todayNairobi } from '~/lib/dates'
import { formatKES } from '~/lib/money'
import { useBrand } from '~/lib/brand'
import { toCsv, downloadCsv } from '~/lib/csv'
import { downloadXlsx } from '~/lib/xlsx'
import { REPORT_KINDS, buildReport, type RBook, type RExp, type RPay, type ReportData, type ReportKind } from '~/lib/report-centre'
import { Button } from '~/components/ui/button'
import { Input, Select } from '~/components/ui/form'
import { ErrorState, Skeleton, TableWrap, td, th } from '~/components/ui/misc'
import { useAdmin } from '~/components/layout/AdminShell'

export function ReportCentre() {
  const { scopeIds, me } = useAdmin()
  const brand = useBrand()
  const today = todayNairobi()
  const [kind, setKind] = useState<ReportKind>('monthly')
  const [from, setFrom] = useState(addMonths(monthStart(today), -2))
  const [to, setTo] = useState(today)
  const valid = !!from && !!to && to >= from && to <= addDays(today, 366)
  const toEx = addDays(to, 1)

  const q = useQuery({
    queryKey: ['report-centre', scopeIds, from, to],
    enabled: valid && scopeIds.length > 0,
    queryFn: async (): Promise<ReportData> => {
      const [b, p, e, u, g] = await Promise.all([
        sb().from('bookings').select('id, reference, property_id, unit_id, guest_id, check_in, check_out, nights, status, source, nightly_total, total_amount, amount_paid, cancel_reason, cancelled_at, created_at').in('property_id', scopeIds).lt('check_in', toEx).gt('check_out', from).limit(10000),
        sb().from('payments').select('booking_id, kind, method, amount, verified, confirmed_at, mpesa_receipt, booking:bookings!inner(reference, property_id)').in('booking.property_id', scopeIds).eq('status', 'succeeded').gte('confirmed_at', `${from}T00:00:00+03:00`).lt('confirmed_at', `${toEx}T00:00:00+03:00`).limit(20000),
        sb().from('expenses').select('property_id, category, amount, expense_date, description, status, voided').in('property_id', scopeIds).gte('expense_date', from).lte('expense_date', to).limit(10000),
        sb().from('units').select('id, name, property_id').in('property_id', scopeIds).eq('active', true),
        sb().from('guests').select('id, full_name').limit(10000),
      ])
      for (const r of [b, p, e, u, g]) if (r.error) throw r.error
      return {
        bookings: b.data as RBook[], expenses: e.data as RExp[],
        payments: (p.data as unknown as (Omit<RPay, 'reference' | 'property_id'> & { booking: { reference: string; property_id: string } })[]).map((x) => ({ ...x, reference: x.booking.reference, property_id: x.booking.property_id })),
        properties: new Map(me.properties.filter((x) => scopeIds.includes(x.id)).map((x) => [x.id, x.name])),
        units: new Map((u.data ?? []).map((x) => [x.id as string, { name: x.name as string, property_id: x.property_id as string }])),
        guests: new Map((g.data ?? []).map((x) => [x.id as string, x.full_name as string])),
      }
    },
  })
  const report = useMemo(() => (q.data ? buildReport(kind, q.data, from, to) : null), [q.data, kind, from, to])
  const fmt = (v: string | number, money?: boolean) => (money && typeof v === 'number' ? formatKES(v) : typeof v === 'number' ? v.toLocaleString('en-US') : v)
  const name = `${kind}-${from}-to-${to}`
  const sheetRows = () => report ? [[brand.businessName], [report.title], [`${from} to ${to}`], [], report.columns.map((c) => c.label), ...report.rows, ...(report.totals ? [report.totals] : [])] : []

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3 print:hidden">
        <label className="grid gap-1 text-sm font-medium">Report<Select value={kind} onChange={(e) => setKind(e.target.value as ReportKind)}>{REPORT_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</Select></label>
        <label className="grid gap-1 text-sm font-medium">From<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="grid gap-1 text-sm font-medium">To<Input type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!report} onClick={() => report && downloadCsv(`${name}.csv`, toCsv(report.rows, report.columns.map((c, i) => ({ header: c.label, value: (r: (string | number)[]) => r[i] }))))}><Download className="h-4 w-4" /> CSV</Button>
          <Button variant="outline" disabled={!report} onClick={() => downloadXlsx(`${name}.xlsx`, [{ name: report?.title.slice(0, 28) ?? 'Report', rows: sheetRows() }])}><FileSpreadsheet className="h-4 w-4" /> Excel</Button>
          <Button variant="outline" disabled={!report} onClick={() => window.print()}><Printer className="h-4 w-4" /> PDF / Print</Button>
        </div>
      </div>
      {!valid && <p role="alert" className="text-sm text-danger">Choose a start date on or before the end date.</p>}
      {q.isLoading && <Skeleton className="h-64" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {report && (
        <div className="print-area">
          <div className="mb-3 hidden items-center gap-3 border-b pb-3 print:flex">
            {brand.logoUrl && <img src={brand.logoUrl} alt="" className="h-12 w-auto" />}
            <div><p className="text-lg font-semibold">{brand.businessName}</p><p className="text-sm">{report.title} · {formatDate(from)} to {formatDate(to)}</p></div>
          </div>
          <h2 className="mb-2 text-lg font-semibold print:hidden">{report.title}</h2>
          {report.rows.length === 0 ? <p className="rounded-xl border p-6 text-sm text-muted-foreground">No records for these dates.</p> : (
            <TableWrap>
              <thead><tr>{report.columns.map((c) => <th key={c.label} className={`${th} ${c.money || c.num ? 'text-right' : ''}`}>{c.label}</th>)}</tr></thead>
              <tbody className="divide-y">{report.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={`${td} ${report.columns[j].money || report.columns[j].num ? 'text-right tabular-nums' : ''}`}>{fmt(v, report.columns[j].money)}</td>)}</tr>)}</tbody>
              {report.totals && <tfoot><tr className="border-t-2 font-semibold">{report.totals.map((v, j) => <td key={j} className={`${td} ${report.columns[j].money || report.columns[j].num ? 'text-right tabular-nums' : ''}`}>{fmt(v, report.columns[j].money)}</td>)}</tr></tfoot>}
            </TableWrap>
          )}
          <p className="mt-3 text-xs text-muted-foreground">Revenue counts verified payments only, net of refunds; expenses count approved entries only. Generated {formatDate(today)}.</p>
        </div>
      )}
    </div>
  )
}
