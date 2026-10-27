import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Printer } from 'lucide-react'
import { pub } from '~/lib/public-client'
import { formatKES } from '~/lib/money'
import { formatDate, formatDateTime } from '~/lib/dates'
import { METHOD_LABEL, type PaymentKind, type PaymentMethod } from '~/lib/types'
import { Button } from '~/components/ui/button'
import { EmptyState, ErrorState, Skeleton } from '~/components/ui/misc'

type Receipt = {
  payment_id: string; receipt_no: string; kind: PaymentKind; method: PaymentMethod; amount: number; confirmed_at: string
  booking_reference: string; check_in: string; check_out: string; nights: number; total_amount: number; amount_paid: number; balance: number
  guest_name: string | null; property_name: string; property_address: string | null; unit_name: string; business_name: string
}

export const Route = createFileRoute('/receipt/$paymentId')({
  ssr: false,
  validateSearch: (s: Record<string, unknown>): { token?: string } => (typeof s.token === 'string' ? { token: s.token } : {}),
  head: () => ({ meta: [{ title: 'Payment receipt' }, { name: 'robots', content: 'noindex,nofollow' }] }),
  component: ReceiptPage,
})

function ReceiptPage() {
  const { paymentId } = Route.useParams()
  const { token } = Route.useSearch()
  const q = useQuery({
    queryKey: ['receipt', paymentId, token],
    enabled: !!token,
    queryFn: async () => {
      const { data, error } = await pub().rpc('get_receipt', { p_payment: paymentId, p_token: token })
      if (error) throw error
      return (data as Receipt | null) ?? null
    },
  })
  if (!token || (q.isSuccess && !q.data)) return <div className="mx-auto max-w-md px-4 py-16"><EmptyState title="Receipt not found" description="Open the receipt from your booking page." /></div>
  const r = q.data
  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <div className="no-print mb-4 flex justify-end"><Button onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / Save as PDF</Button></div>
      {q.isLoading && <Skeleton className="h-96" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {r && (
        <article className="rounded-xl border bg-card p-6 shadow-sm print:border-0 print:shadow-none" aria-label="Payment receipt">
          <header className="border-b pb-4">
            <p className="text-lg font-semibold">{r.business_name}</p>
            <h1 className="mt-1 text-sm uppercase tracking-widest text-muted-foreground">Payment receipt</h1>
          </header>
          <dl className="mt-4 grid gap-2 text-sm">
            {([
              ['Receipt no.', r.receipt_no], ['Booking reference', r.booking_reference], ['Guest', r.guest_name ?? ''],
              ['Property', `${r.property_name}${r.property_address ? `, ${r.property_address}` : ''}`], ['Unit', r.unit_name],
              ['Stay', `${formatDate(r.check_in)} to ${formatDate(r.check_out)} (${r.nights} night${r.nights > 1 ? 's' : ''})`],
              ['Payment type', r.kind], ['Method', METHOD_LABEL[r.method]], ['Date and time', `${formatDateTime(r.confirmed_at)} (Nairobi)`],
            ] as [string, string][]).map(([k, v]) => <div key={k} className="flex justify-between gap-4"><dt className="text-muted-foreground">{k}</dt><dd className="text-right font-medium capitalize-first">{v}</dd></div>)}
          </dl>
          <div className="mt-5 rounded-lg bg-muted p-4">
            <p className="flex justify-between text-lg font-semibold"><span>Amount paid</span><span className="tabular-nums">{formatKES(r.amount)}</span></p>
            <p className="mt-2 flex justify-between text-sm"><span>Booking total</span><span className="tabular-nums">{formatKES(r.total_amount)}</span></p>
            <p className="flex justify-between text-sm"><span>Total paid so far</span><span className="tabular-nums">{formatKES(r.amount_paid)}</span></p>
            <p className="flex justify-between text-sm font-semibold"><span>Balance remaining</span><span className="tabular-nums">{formatKES(r.balance)}</span></p>
          </div>
          <p className="mt-5 text-center text-xs text-muted-foreground">Thank you for staying with {r.business_name}.</p>
        </article>
      )}
    </div>
  )
}
