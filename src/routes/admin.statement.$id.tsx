import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Printer } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { useBrand } from '~/lib/brand'
import { formatDate, formatDateTime } from '~/lib/dates'
import { formatKES } from '~/lib/money'
import { formatPhoneLocal } from '~/lib/phone'
import { Button } from '~/components/ui/button'
import { ErrorState, Skeleton } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/statement/$id')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: StatementPage,
})

type Statement = {
  guest: { name: string; phone: string; email: string | null }
  bookings: { reference: string; property: string; check_in: string; check_out: string; status: string; total: number; discount: number; paid: number; balance: number }[]
  payments: { reference: string; kind: string; method: string; amount: number; receipt: string | null; at: string }[]
  credit: { amount: number; kind: string; reason: string; at: string }[]
  credit_balance: number
}

function StatementPage() {
  const { id } = Route.useParams()
  const brand = useBrand()
  const q = useQuery({ queryKey: ['guest-statement', id], queryFn: async () => {
    const { data, error } = await sb().rpc('guest_statement', { p_guest: id })
    if (error) throw error
    return data as Statement
  } })
  if (q.isLoading) return <Skeleton className="h-96" />
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const s = q.data!
  const owing = s.bookings.reduce((n, b) => n + b.balance, 0)
  const cell = 'px-2 py-1.5 text-left align-top'
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <Link to="/admin/guests/$id" params={{ id }} className="inline-flex h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Back to guest</Link>
        <Button onClick={() => window.print()}><Printer className="h-4 w-4" /> Print or save as PDF</Button>
      </div>
      <article className="rounded-xl border bg-white p-6 text-sm text-black print:border-0 print:p-0">
        <header className="flex items-start justify-between gap-4 border-b pb-4">
          <div><h1 className="text-xl font-semibold">Guest statement</h1><p className="text-neutral-600">{brand.businessName}</p></div>
          <p className="text-right text-neutral-600">Prepared {formatDate(new Date().toISOString().slice(0, 10))}</p>
        </header>
        <section className="py-4"><p className="font-medium">{s.guest.name}</p><p className="text-neutral-600">{formatPhoneLocal(s.guest.phone)}{s.guest.email ? ` · ${s.guest.email}` : ''}</p></section>
        <h2 className="mb-1 font-semibold">Bookings</h2>
        <table className="w-full border-collapse"><thead><tr className="border-b text-xs uppercase text-neutral-600"><th className={cell}>Ref</th><th className={cell}>Stay</th><th className={cell}>Status</th><th className={`${cell} text-right`}>Total</th><th className={`${cell} text-right`}>Paid</th><th className={`${cell} text-right`}>Balance</th></tr></thead>
          <tbody>{s.bookings.map((b) => <tr key={b.reference} className="border-b"><td className={cell}>{b.reference}<br /><span className="text-neutral-500">{b.property}</span></td><td className={cell}>{formatDate(b.check_in)} to {formatDate(b.check_out)}</td><td className={cell}>{b.status.replace('_', ' ')}</td><td className={`${cell} text-right`}>{formatKES(b.total)}{b.discount > 0 && <><br /><span className="text-neutral-500">incl. -{formatKES(b.discount)}</span></>}</td><td className={`${cell} text-right`}>{formatKES(b.paid)}</td><td className={`${cell} text-right`}>{formatKES(b.balance)}</td></tr>)}
            {s.bookings.length === 0 && <tr><td className={cell} colSpan={6}>No bookings.</td></tr>}</tbody></table>
        <h2 className="mb-1 mt-5 font-semibold">Payments received</h2>
        <table className="w-full border-collapse"><tbody>{s.payments.map((p, i) => <tr key={i} className="border-b"><td className={cell}>{formatDateTime(p.at)}</td><td className={cell}>{p.reference}</td><td className={cell}>{p.kind} · {p.method.replace('_', ' ')}{p.receipt ? ` · ${p.receipt}` : ''}</td><td className={`${cell} text-right`}>{p.kind === 'refund' ? '-' : ''}{formatKES(p.amount)}</td></tr>)}
          {s.payments.length === 0 && <tr><td className={cell}>No payments.</td></tr>}</tbody></table>
        {s.credit.length > 0 && <>
          <h2 className="mb-1 mt-5 font-semibold">Credit account</h2>
          <table className="w-full border-collapse"><tbody>{s.credit.map((c, i) => <tr key={i} className="border-b"><td className={cell}>{formatDateTime(c.at)}</td><td className={cell}>{c.reason}</td><td className={`${cell} text-right`}>{c.amount < 0 ? '-' : '+'}{formatKES(Math.abs(c.amount))}</td></tr>)}</tbody></table>
        </>}
        <footer className="mt-5 flex flex-wrap justify-end gap-x-8 gap-y-1 border-t pt-3 font-medium"><span>Outstanding: {formatKES(owing)}</span><span>Credit held: {formatKES(s.credit_balance)}</span></footer>
      </article>
    </div>
  )
}
