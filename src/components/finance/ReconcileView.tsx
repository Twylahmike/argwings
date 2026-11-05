import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileUp } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { formatKES } from '~/lib/money'
import { errMessage } from '~/lib/utils'
import { usePermissions } from '~/lib/permissions'
import { matchStatement, parseStatement, type Match, type StatementRow } from '~/lib/reconcile'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { EmptyState, TableWrap, td, th } from '~/components/ui/misc'
import { useAdmin } from '~/components/layout/AdminShell'

const LABEL: Record<Match['status'], [string, string]> = {
  matched: ['Matched', 'border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300'],
  amount_mismatch: ['Amount differs', 'border-danger/40 bg-danger/10 text-danger'],
  possible: ['Possible match', 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'],
  missing_in_system: ['On statement, not recorded', 'border-danger/40 bg-danger/10 text-danger'],
  not_on_statement: ['Recorded, not on statement', 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'],
}

/** Upload a bank or M-Pesa statement (CSV). Matches it against recorded payments; matched manual payments can be verified in one click. */
export function ReconcileView() {
  const { scopeIds } = useAdmin()
  const { can } = usePermissions()
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<StatementRow[] | null>(null)
  const [error, setError] = useState('')
  const dates = (rows ?? []).map((r) => r.date).filter(Boolean).sort()
  const from = dates[0] ?? ''
  const to = dates.at(-1) ?? ''

  const pays = useQuery({
    queryKey: ['reconcile-payments', scopeIds, from, to], enabled: !!rows,
    queryFn: async () => {
      let q = sb().from('payments').select('id, kind, method, amount, mpesa_receipt, verified, confirmed_at, booking:bookings!inner(reference, property_id)').in('booking.property_id', scopeIds).eq('status', 'succeeded').neq('method', 'mpesa_stk').limit(5000)
      if (from) q = q.gte('confirmed_at', new Date(Date.parse(from) - 4 * 86_400_000).toISOString())
      if (to) q = q.lte('confirmed_at', new Date(Date.parse(to) + 5 * 86_400_000).toISOString())
      const { data, error } = await q
      if (error) throw error
      return (data as unknown as { id: string; kind: string; method: string; amount: number; mpesa_receipt: string | null; verified: boolean; confirmed_at: string; booking: { reference: string } }[])
        .map((p) => ({ id: p.id, reference: p.booking.reference, method: p.method, kind: p.kind, amount: p.amount, mpesa_receipt: p.mpesa_receipt, verified: p.verified, confirmed_at: p.confirmed_at }))
    },
  })
  const matches = rows && pays.data ? matchStatement(rows, pays.data) : null
  const verifiable = (matches ?? []).filter((m): m is Extract<Match, { status: 'matched' }> => m.status === 'matched' && !m.payment.verified)
  const verify = useMutation({
    mutationFn: async () => { for (const m of verifiable) { const { error } = await sb().rpc('verify_payment', { p_payment: m.payment.id, p_ok: true }); if (error) throw error } },
    onSuccess: () => { toast.success(`${verifiable.length} payment${verifiable.length === 1 ? '' : 's'} verified`); qc.invalidateQueries({ queryKey: ['reconcile-payments'] }); qc.invalidateQueries({ queryKey: ['income'] }) },
    onError: (e) => toast.error(errMessage(e)),
  })
  async function load(file?: File) {
    if (!file) return
    setError('')
    if (file.size > 3_000_000) { setError('That file is too large. Export a shorter date range.'); return }
    const r = parseStatement(await file.text())
    if (r.error) { setError(r.error); setRows(null); return }
    setRows(r.rows)
  }
  const count = (s: Match['status']) => (matches ?? []).filter((m) => m.status === s).length
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">Upload a CSV export of your M-Pesa or bank statement. Payments are matched by receipt number and amount. Nothing is changed until you press “Verify matched”. STK push payments are already confirmed by M-Pesa and are not listed.</p>
      <div><input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => { load(e.target.files?.[0]); e.target.value = '' }} /><Button variant="outline" onClick={() => input.current?.click()}><FileUp className="h-4 w-4" /> Choose statement (CSV)</Button></div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {rows && rows.length === 0 && !error && <EmptyState title="No money-in lines found" description="The file was read but has no credit rows with a reference and amount." />}
      {matches && (
        <>
          <p className="text-sm">{(['matched', 'amount_mismatch', 'possible', 'missing_in_system', 'not_on_statement'] as const).map((s) => `${LABEL[s][0]}: ${count(s)}`).join(' · ')}</p>
          {can('payments.verify') && verifiable.length > 0 && <div><Button loading={verify.isPending} onClick={() => verify.mutate()}>Verify matched ({verifiable.length})</Button></div>}
          <TableWrap>
            <thead><tr>{['Result', 'Statement', 'Recorded payment'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
            <tbody className="divide-y">{matches.map((m, i) => (
              <tr key={i} className="align-top">
                <td className={td}><Badge className={LABEL[m.status][1]}>{LABEL[m.status][0]}</Badge></td>
                <td className={td}>{'row' in m ? <>{m.row.ref}<br /><span className="text-xs text-muted-foreground">{formatKES(m.row.amount)}{m.row.date ? ` · ${m.row.date}` : ''} · line {m.row.line}</span></> : '—'}</td>
                <td className={td}>{'payment' in m ? <>{m.payment.reference} · {m.payment.method.replace('_', ' ')}<br /><span className="text-xs text-muted-foreground">{formatKES(m.payment.amount)} · {m.payment.mpesa_receipt ?? 'no receipt'} · {m.payment.verified ? 'verified' : 'awaiting verification'}</span></> : '—'}</td>
              </tr>))}</tbody>
          </TableWrap>
        </>
      )}
    </div>
  )
}
