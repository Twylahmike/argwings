import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, Download, Paperclip, Plus, Receipt } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { isOwner, requireRole } from '~/lib/auth'
import { addMonths, formatDate, formatDateTime, formatMonth, monthStart, todayNairobi } from '~/lib/dates'
import { formatKES, parseKES } from '~/lib/money'
import { toCsv, downloadCsv } from '~/lib/csv'
import { receiptUrl, uploadReceipt } from '~/lib/images'
import { errMessage } from '~/lib/utils'
import { EXPENSE_CATEGORIES, METHOD_LABEL, type Expense, type PaymentMethod } from '~/lib/types'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Badge } from '~/components/ui/badge'
import { Dialog, DialogContent } from '~/components/ui/dialog'
import { Field, Input, Select, Textarea } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, Stat, Tabs, TableWrap, td, th } from '~/components/ui/misc'
import { Money } from '~/components/booking/BookingBits'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/finance')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: FinancePage,
})

type Pnl = { property_id: string; property_name: string; income: number; refunds: number; expenses: number; net: number }
type IncomeRow = { id: string; kind: string; method: PaymentMethod; amount: number; mpesa_receipt: string | null; confirmed_at: string; booking: { reference: string; property_id: string; property: { name: string } } }

function FinancePage() {
  const { scopeIds } = useAdmin()
  const [month, setMonth] = useState(monthStart(todayNairobi()))
  const [tab, setTab] = useState<'pnl' | 'income' | 'expenses'>('pnl')
  const next = addMonths(month, 1)

  return (
    <div>
      <PageHeader title="Finance" description="Money in, money out, and profit for each BNB."
        actions={<div className="flex items-center gap-1">
          <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft className="h-5 w-5" /></Button>
          <Input aria-label="Month" type="month" className="w-44" value={month.slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value + '-01')} />
          <Button variant="outline" size="icon" aria-label="Next month" onClick={() => setMonth(next)}><ChevronRight className="h-5 w-5" /></Button>
        </div>} />
      <div className="mb-5"><Tabs label="Finance sections" value={tab} onChange={setTab} tabs={[{ value: 'pnl', label: 'Monthly profit' }, { value: 'income', label: 'Income' }, { value: 'expenses', label: 'Expenses' }]} /></div>
      {tab === 'pnl' && <ProfitView month={month} scopeIds={scopeIds} />}
      {tab === 'income' && <IncomeView month={month} next={next} scopeIds={scopeIds} />}
      {tab === 'expenses' && <ExpensesView month={month} next={next} scopeIds={scopeIds} />}
    </div>
  )
}

function ProfitView({ month, scopeIds }: { month: string; scopeIds: string[] }) {
  const q = useQuery({
    queryKey: ['pnl', month, scopeIds],
    queryFn: async () => {
      const [p, c] = await Promise.all([sb().rpc('monthly_pnl', { p_month: month }), sb().rpc('monthly_expenses_by_category', { p_month: month })])
      if (p.error) throw p.error
      if (c.error) throw c.error
      return { rows: (p.data as Pnl[]).filter((r) => scopeIds.includes(r.property_id)), cats: scopeIds.length ? (c.data as { category: string; amount: number }[]) : [] }
    },
  })
  const rows = q.data?.rows ?? []
  const total = rows.reduce((a, r) => ({ income: a.income + r.income - r.refunds, expenses: a.expenses + r.expenses, net: a.net + r.net }), { income: 0, expenses: 0, net: 0 })
  const chart = rows.map((r) => ({ name: r.property_name, Income: r.income - r.refunds, Expenses: r.expenses, Net: r.net }))
  function exportCsv() {
    downloadCsv(`profit-${month.slice(0, 7)}.csv`, toCsv(rows, [
      { header: 'Property', value: (r) => r.property_name }, { header: 'Income (KES)', value: (r) => r.income }, { header: 'Refunds (KES)', value: (r) => r.refunds },
      { header: 'Expenses (KES)', value: (r) => r.expenses }, { header: 'Net (KES)', value: (r) => r.net },
    ]))
  }
  if (q.isLoading) return <Skeleton className="h-80" />
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />
  return (
    <div className="grid gap-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={`Income, ${formatMonth(month)}`} value={formatKES(total.income)} hint="Payments received minus refunds" />
        <Stat label="Expenses" value={formatKES(total.expenses)} />
        <Stat label="Net profit" value={formatKES(total.net)} tone={total.net < 0 ? 'danger' : undefined} />
      </div>
      <Card>
        <CardHeader className="flex-row items-center justify-between"><CardTitle>Profit by property</CardTitle><Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows.length}><Download className="h-4 w-4" /> CSV</Button></CardHeader>
        <CardContent>
          {rows.length === 0 ? <EmptyState title="No data for this month" /> : (
            <>
              <div className="h-64 w-full" role="img" aria-label="Bar chart of income, expenses and net profit per property">
                <ResponsiveContainer><BarChart data={chart} margin={{ left: 8, right: 8 }}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" tick={{ fontSize: 12 }} /><YAxis tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} width={40} tick={{ fontSize: 12 }} /><Tooltip formatter={(v) => formatKES(Number(v))} /><Legend />
                  <Bar dataKey="Income" fill="#0f766e" radius={[3, 3, 0, 0]} /><Bar dataKey="Expenses" fill="#b45309" radius={[3, 3, 0, 0]} /><Bar dataKey="Net" fill="#1d4ed8" radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer>
              </div>
              <div className="mt-4"><TableWrap>
                <thead><tr>{['Property', 'Income', 'Refunds', 'Expenses', 'Net'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
                <tbody className="divide-y">
                  {rows.map((r) => <tr key={r.property_id}><td className={td}>{r.property_name}</td><td className={td}><Money value={r.income} /></td><td className={td}><Money value={r.refunds} /></td><td className={td}><Money value={r.expenses} /></td><td className={`${td} font-semibold`}><Money value={r.net} className={r.net < 0 ? 'text-danger' : ''} /></td></tr>)}
                  <tr className="bg-muted/40 font-semibold"><td className={td}>All properties</td><td className={td}><Money value={rows.reduce((s, r) => s + r.income, 0)} /></td><td className={td}><Money value={rows.reduce((s, r) => s + r.refunds, 0)} /></td><td className={td}><Money value={total.expenses} /></td><td className={td}><Money value={total.net} /></td></tr>
                </tbody>
              </TableWrap></div>
            </>
          )}
        </CardContent>
      </Card>
      {!!q.data?.cats.length && (
        <Card><CardHeader><CardTitle>Expenses by category</CardTitle></CardHeader><CardContent>
          <ul className="divide-y text-sm">{q.data.cats.map((c) => <li key={c.category} className="flex justify-between py-2 capitalize"><span>{c.category}</span><Money value={c.amount} /></li>)}</ul>
        </CardContent></Card>
      )}
    </div>
  )
}

function IncomeView({ month, next, scopeIds }: { month: string; next: string; scopeIds: string[] }) {
  const [method, setMethod] = useState<'' | PaymentMethod>('')
  const q = useQuery({
    queryKey: ['income', month, scopeIds],
    queryFn: async () => {
      // Month edges in Nairobi time (UTC+3)
      const { data, error } = await sb().from('payments').select('id, kind, method, amount, mpesa_receipt, confirmed_at, booking:bookings!inner(reference, property_id, property:properties(name))')
        .eq('status', 'succeeded').in('booking.property_id', scopeIds).gte('confirmed_at', `${month}T00:00:00+03:00`).lt('confirmed_at', `${next}T00:00:00+03:00`).order('confirmed_at', { ascending: false }).limit(2000)
      if (error) throw error
      return data as unknown as IncomeRow[]
    },
  })
  const rows = (q.data ?? []).filter((r) => !method || r.method === method)
  const total = rows.reduce((s, r) => s + (r.kind === 'refund' ? -r.amount : r.amount), 0)
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Select aria-label="Payment method" className="w-52" value={method} onChange={(e) => setMethod(e.target.value as '' | PaymentMethod)}><option value="">All methods</option>{(Object.keys(METHOD_LABEL) as PaymentMethod[]).map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</Select>
        <div className="flex items-center gap-3"><span className="text-sm">Total <b>{formatKES(total)}</b></span>
          <Button variant="outline" size="sm" disabled={!rows.length} onClick={() => downloadCsv(`income-${month.slice(0, 7)}.csv`, toCsv(rows, [
            { header: 'Date', value: (r) => r.confirmed_at }, { header: 'Property', value: (r) => r.booking.property.name }, { header: 'Booking', value: (r) => r.booking.reference },
            { header: 'Type', value: (r) => r.kind }, { header: 'Method', value: (r) => METHOD_LABEL[r.method] }, { header: 'Receipt', value: (r) => r.mpesa_receipt }, { header: 'Amount (KES)', value: (r) => (r.kind === 'refund' ? -r.amount : r.amount) },
          ]))}><Download className="h-4 w-4" /> CSV</Button></div>
      </div>
      {q.isLoading && <Skeleton className="h-48" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && rows.length === 0 && <EmptyState icon={Receipt} title="No payments this month" />}
      {rows.length > 0 && <TableWrap>
        <thead><tr>{['Date', 'Property', 'Booking', 'Type', 'Method', 'Receipt', 'Amount'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
        <tbody className="divide-y">{rows.map((r) => <tr key={r.id}><td className={`${td} whitespace-nowrap`}>{formatDateTime(r.confirmed_at)}</td><td className={td}>{r.booking.property.name}</td><td className={td}>{r.booking.reference}</td><td className={`${td} capitalize`}>{r.kind}</td><td className={td}>{METHOD_LABEL[r.method]}</td><td className={td}>{r.mpesa_receipt}</td><td className={td}><Money value={r.kind === 'refund' ? -r.amount : r.amount} /></td></tr>)}</tbody>
      </TableWrap>}
    </div>
  )
}

function ExpensesView({ month, next, scopeIds }: { month: string; next: string; scopeIds: string[] }) {
  const { me } = useAdmin()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Expense | 'new' | null>(null)
  const q = useQuery({
    queryKey: ['expenses', month, scopeIds],
    queryFn: async () => {
      const { data, error } = await sb().from('expenses').select('*, property:properties(name)').in('property_id', scopeIds).gte('expense_date', month).lt('expense_date', next).order('expense_date', { ascending: false })
      if (error) throw error
      return data as unknown as (Expense & { property: { name: string } })[]
    },
  })
  const total = useMemo(() => (q.data ?? []).filter((e) => !e.voided).reduce((s, e) => s + e.amount, 0), [q.data])
  const del = useMutation({
    mutationFn: async (id: string) => { const { error } = await sb().from('expenses').delete().eq('id', id); if (error) throw error },
    onSuccess: () => { toast.success('Deleted'); qc.invalidateQueries({ queryKey: ['expenses'] }); qc.invalidateQueries({ queryKey: ['pnl'] }) },
    onError: (e) => toast.error(errMessage(e)),
  })
  async function openReceipt(path: string) { const u = await receiptUrl(path); if (u) window.open(u, '_blank', 'noopener'); else toast.error('Could not open the receipt') }
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">Total expenses <b>{formatKES(total)}</b></p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={!q.data?.length} onClick={() => downloadCsv(`expenses-${month.slice(0, 7)}.csv`, toCsv(q.data ?? [], [
            { header: 'Date', value: (e) => e.expense_date }, { header: 'Property', value: (e) => e.property.name }, { header: 'Category', value: (e) => e.category },
            { header: 'Description', value: (e) => e.description }, { header: 'Paid via', value: (e) => (e.paid_via ? METHOD_LABEL[e.paid_via] : '') }, { header: 'Amount (KES)', value: (e) => e.amount }, { header: 'Voided', value: (e) => (e.voided ? 'yes' : '') },
          ]))}><Download className="h-4 w-4" /> CSV</Button>
          <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Add expense</Button>
        </div>
      </div>
      {q.isLoading && <Skeleton className="h-48" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data?.length === 0 && <EmptyState icon={Receipt} title="No expenses this month" action={<Button onClick={() => setEditing('new')}>Add an expense</Button>} />}
      {!!q.data?.length && <TableWrap>
        <thead><tr>{['Date', 'Property', 'Category', 'Description', 'Amount', ''].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
        <tbody className="divide-y">{q.data.map((e) => (
          <tr key={e.id} className={e.voided ? 'opacity-50' : ''}>
            <td className={`${td} whitespace-nowrap`}>{formatDate(e.expense_date)}</td><td className={td}>{e.property.name}</td><td className={`${td} capitalize`}>{e.category}</td>
            <td className={td}>{e.description}{e.voided && <Badge className="ml-2 text-muted-foreground">Voided</Badge>}{e.receipt_url && <button className="ml-2 inline-flex items-center text-brand" onClick={() => openReceipt(e.receipt_url!)} aria-label="View receipt"><Paperclip className="h-4 w-4" /></button>}</td>
            <td className={td}><Money value={e.amount} className={e.voided ? 'line-through' : ''} /></td>
            <td className={`${td} whitespace-nowrap text-right`}><Button variant="ghost" size="sm" onClick={() => setEditing(e)}>Edit</Button>{isOwner(me) && <Button variant="ghost" size="sm" className="text-danger" onClick={() => confirm('Delete this expense permanently?') && del.mutate(e.id)}>Delete</Button>}</td>
          </tr>))}</tbody>
      </TableWrap>}
      {editing && <ExpenseDialog expense={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['expenses'] }); qc.invalidateQueries({ queryKey: ['pnl'] }) }} />}
    </div>
  )
}

function ExpenseDialog({ expense, onClose, onSaved }: { expense?: Expense; onClose: () => void; onSaved: () => void }) {
  const { me, propertyId } = useAdmin()
  const [propId, setPropId] = useState(expense?.property_id ?? (propertyId !== 'all' ? propertyId : me.properties[0]?.id ?? ''))
  const [category, setCategory] = useState(expense?.category ?? 'utilities')
  const [amount, setAmount] = useState(expense ? String(expense.amount) : '')
  const [date, setDate] = useState(expense?.expense_date ?? todayNairobi())
  const [desc, setDesc] = useState(expense?.description ?? '')
  const [paidVia, setPaidVia] = useState<PaymentMethod>(expense?.paid_via ?? 'cash')
  const [voided, setVoided] = useState(expense?.voided ?? false)
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const save = useMutation({
    mutationFn: async () => {
      const n = parseKES(amount)
      if (!n || n <= 0) throw new Error('Enter the amount as a whole number of shillings.')
      let receipt_url = expense?.receipt_url ?? null
      if (file) receipt_url = await uploadReceipt(file, propId)
      const row = { property_id: propId, category, amount: n, expense_date: date, description: desc.trim() || null, paid_via: paidVia, receipt_url, voided, created_by: me.id }
      const { error: err } = expense ? await sb().from('expenses').update(row).eq('id', expense.id) : await sb().from('expenses').insert(row)
      if (err) throw err
    },
    onSuccess: () => { toast.success('Expense saved'); onSaved() },
    onError: (e) => setError(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={expense ? 'Edit expense' : 'Add expense'}>
        <div className="grid gap-4">
          <Field label="Property" htmlFor="ex-prop"><Select id="ex-prop" value={propId} onChange={(e) => setPropId(e.target.value)} disabled={!!expense}>{me.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category" htmlFor="ex-cat"><Select id="ex-cat" value={category} onChange={(e) => setCategory(e.target.value)}>{EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>
            <Field label="Amount (KES)" htmlFor="ex-amt"><Input id="ex-amt" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
            <Field label="Date" htmlFor="ex-date"><Input id="ex-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Paid via" htmlFor="ex-via"><Select id="ex-via" value={paidVia} onChange={(e) => setPaidVia(e.target.value as PaymentMethod)}>{(Object.keys(METHOD_LABEL) as PaymentMethod[]).filter((m) => m !== 'mpesa_stk').map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</Select></Field>
          </div>
          <Field label="Description" htmlFor="ex-desc"><Textarea id="ex-desc" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
          <Field label="Receipt photo (optional)" htmlFor="ex-file"><Input id="ex-file" type="file" accept="image/*" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          {expense && <label className="flex h-11 items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5" checked={voided} onChange={(e) => setVoided(e.target.checked)} /> Void this expense (excluded from profit, kept for the record)</label>}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <Button loading={save.isPending} onClick={() => { setError(''); save.mutate() }}>Save expense</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
