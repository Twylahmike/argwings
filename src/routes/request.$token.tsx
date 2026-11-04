import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { MessageCircle } from 'lucide-react'
import { pub } from '~/lib/public-client'
import { formatDate } from '~/lib/dates'
import { waLink, useBrand } from '~/lib/brand'
import { REQUEST_LABEL, type PublicRequest } from '~/lib/requests'
import { errMessage } from '~/lib/utils'
import { PublicLayout } from '~/components/layout/PublicLayout'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { EmptyState, ErrorState, Skeleton } from '~/components/ui/misc'

export const Route = createFileRoute('/request/$token')({
  ssr: false, // private to the guest holding the link
  head: () => ({ meta: [{ title: 'Your booking request' }, { name: 'robots', content: 'noindex,nofollow' }] }),
  component: RequestPage,
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function RequestPage() {
  const { token } = Route.useParams()
  const brand = useBrand()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['public-request', token],
    enabled: UUID.test(token),
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await pub().rpc('get_booking_request', { p_token: token })
      if (error) throw error
      return (data ?? null) as PublicRequest | null
    },
  })
  const act = useMutation({
    mutationFn: async (fn: 'accept_alternative_dates' | 'withdraw_booking_request') => {
      const { error } = await pub().rpc(fn, { p_token: token })
      if (error) throw error
    },
    onSuccess: () => { toast.success('Updated'); qc.invalidateQueries({ queryKey: ['public-request', token] }) },
    onError: (e) => toast.error(errMessage(e)),
  })

  const r = q.data
  return (
    <PublicLayout>
      <div className="mx-auto max-w-xl px-4 py-10">
        {!UUID.test(token) || (q.isSuccess && !r)
          ? <EmptyState title="We could not find that request" description="Check the link we sent you, or contact us." />
          : q.isLoading ? <Skeleton className="h-72" />
          : q.error ? <ErrorState error={q.error} retry={() => q.refetch()} />
          : r && (
            <Card>
              <CardHeader>
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Booking request</p>
                <CardTitle className="text-2xl">{REQUEST_LABEL[r.status]}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 text-sm">
                <div>
                  <p className="font-medium">{r.property_name} · {r.unit_name}</p>
                  <p>{formatDate(r.check_in)} → {formatDate(r.check_out)} · {r.guests} guest{r.guests > 1 ? 's' : ''}</p>
                </div>
                {r.status === 'new' && <p>Thanks {r.name.split(' ')[0]}. We have your request and will reply as soon as we have checked the dates. No payment is needed yet.</p>}
                {r.decision_note && <p className="rounded-md bg-muted p-3">{r.decision_note}</p>}
                {r.status === 'approved' && (r.booking_token
                  ? <Button asChild size="lg"><Link to="/booking/$token" params={{ token: r.booking_token }}>Pay your deposit to confirm</Link></Button>
                  : <p>Approved. We will send you the payment link shortly.</p>)}
                {r.status === 'alternative_offered' && r.alt_check_in && r.alt_check_out && (
                  <div className="grid gap-3 rounded-md border p-3">
                    <p>We suggest <strong>{formatDate(r.alt_check_in)} → {formatDate(r.alt_check_out)}</strong> instead.</p>
                    <div className="flex flex-wrap gap-2">
                      <Button loading={act.isPending} onClick={() => act.mutate('accept_alternative_dates')}>Accept these dates</Button>
                      <Button variant="outline" onClick={() => act.mutate('withdraw_booking_request')}>No thanks</Button>
                    </div>
                  </div>
                )}
                {r.status === 'rejected' && <p>Sorry we could not host you this time. You are welcome to try other dates.</p>}
                {r.status === 'expired' && <p>This request expired before it was answered. Please send a new one.</p>}
                {(r.status === 'new') && <div><Button variant="outline" size="sm" onClick={() => act.mutate('withdraw_booking_request')}>Withdraw request</Button></div>}
                {brand.supportWhatsapp && (
                  <a className="inline-flex items-center gap-2 text-brand hover:underline" target="_blank" rel="noreferrer"
                    href={waLink(brand.supportWhatsapp, `Hi ${brand.businessName}, about my booking request for ${r.property_name} (${r.check_in} to ${r.check_out}).`)}>
                    <MessageCircle className="h-4 w-4" aria-hidden /> Message us on WhatsApp
                  </a>
                )}
              </CardContent>
            </Card>
          )}
      </div>
    </PublicLayout>
  )
}
