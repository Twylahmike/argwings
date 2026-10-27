import { useEffect, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, ArrowLeft, Copy, ExternalLink, Pencil, Plus, Receipt, Smartphone } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { isOwner, requireRole } from '~/lib/auth'
import { balance, fetchBooking, fetchPayments, nextActions, type NextAction } from '~/lib/bookings-api'
import { METHOD_LABEL, SOURCE_LABEL, type BookingStatus } from '~/lib/types'
import { formatDate, formatDateTime } from '~/lib/dates'
import { formatPhoneLocal } from '~/lib/phone'
import { errMessage } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { PaymentBadge, StatusBadge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Dialog, DialogContent } from '~/components/ui/dialog'
import { Field, Textarea } from '~/components/ui/form'
import { ErrorState, Skeleton } from '~/components/ui/misc'
import { Money } from '~/components/booking/BookingBits'
import { RecordPaymentDialog } from '~/components/booking/RecordPaymentDialog'
import { RequestPaymentDialog } from '~/components/booking/RequestPaymentDialog'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/bookings/$id')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: BookingDetail,
})

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex justify-between gap-4 py-1.5 text-sm"><dt className="text-muted-foreground">{label}</dt><dd className="text-right font-medium">{children}</dd></div>
}

function BookingDetail() {
  const { id } = Route.useParams()
  const { me } = useAdmin()
  const qc = useQueryClient()
  const booking = useQuery({ queryKey: ['booking', id], queryFn: () => fetchBooking(id) })
  const payments = useQuery({ queryKey: ['booking-payments', id], queryFn: () => fetchPayments(id) })
  const [recording, setRecording] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [pending, setPending] = useState<NextAction | null>(null)
  const [editNotes, setEditNotes] = useState(false)

  // Live updates: STK confirmations arrive while staff are looking at the page.
  useEffect(() => {
    const ch = sb().channel(`booking-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payments', filter: `booking_id=eq.${id}` }, () => {
        qc.invalidateQueries({ queryKey: ['booking-payments', id] }); qc.invalidateQueries({ queryKey: ['booking', id] })
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'bookings', filter: `id=eq.${id}` }, () => qc.invalidateQueries({ queryKey: ['booking', id] }))
      .subscribe()
    return () => { sb().removeChannel(ch) }
  }, [id, qc])

  const refresh = () => { qc.invalidateQueries({ queryKey: ['booking', id] }); qc.invalidateQueries({ queryKey: ['booking-payments', id] }); qc.invalidateQueries({ queryKey: ['bookings'] }) }

  const setStatus = useMutation({
    mutationFn: async (v: { to: BookingStatus; reason?: string }) => {
      const patch: Record<string, unknown> = { status: v.to }
      if (v.reason) patch.cancel_reason = v.reason
      const { error } = await sb().from('bookings').update(patch).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => { toast.success('Booking updated'); setPending(null); refresh() },
    onError: (e) => toast.error((e as { code?: string }).code === '23P01' ? 'Those dates are no longer free, so this booking cannot be re-confirmed.' : errMessage(e)),
  })

  if (booking.isLoading) return <Skeleton className="h-96" />
  if (booking.error) return <ErrorState error={booking.error} retry={() => booking.refetch()} />
  const b = booking.data!
  const bal = balance(b)
  const guestLink = `${window.location.origin}/booking/${b.public_token}`

  return (
    <div className="max-w-5xl">
      <Link to="/admin/bookings" className="mb-3 inline-flex h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Bookings</Link>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3"><h1 className="text-xl font-semibold md:text-2xl">{b.reference}</h1><StatusBadge status={b.status} /></div>
        <div className="flex flex-wrap gap-2">
          {nextActions(b.status).map((a) => (
            <Button key={a.to} variant={a.variant} onClick={() => (a.needsReason || a.to === 'checked_in' || a.to === 'checked_out' ? setPending(a) : setStatus.mutate({ to: a.to }))} loading={setStatus.isPending && setStatus.variables?.to === a.to}>{a.label}</Button>
          ))}
        </div>
      </div>

      {b.payment_review && (
        <div role="alert" className="mb-4 flex gap-3 rounded-xl border border-danger/50 bg-danger/5 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden />
          <div><p className="font-semibold text-danger">Payment needs review</p><p className="mt-1">{b.review_reason ?? 'A payment needs your attention.'}</p>
            {isOwner(me) && <Button variant="outline" size="sm" className="mt-2" onClick={async () => { const { error } = await sb().from('bookings').update({ payment_review: false }).eq('id', id); if (error) toast.error(errMessage(error)); else { toast.success('Marked as reviewed'); refresh() } }}>Mark as reviewed</Button>}</div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Stay</CardTitle></CardHeader>
          <CardContent><dl className="divide-y">
            {b.guest && <Row label="Guest"><Link to="/admin/guests/$id" params={{ id: b.guest.id }} className="text-brand hover:underline">{b.guest.full_name}</Link></Row>}
            {b.guest && <Row label="Phone"><a href={`tel:+${b.guest.phone}`} className="hover:underline">{formatPhoneLocal(b.guest.phone)}</a></Row>}
            <Row label="Property">{b.property.name}</Row>
            <Row label="Unit">{b.unit.name}</Row>
            <Row label="Check-in">{formatDate(b.check_in)}</Row>
            <Row label="Check-out">{formatDate(b.check_out)}</Row>
            <Row label="Nights">{b.nights}</Row>
            <Row label="Guests">{b.num_guests}</Row>
            <Row label="Source">{SOURCE_LABEL[b.source]}</Row>
            <Row label="Created">{formatDateTime(b.created_at)}</Row>
            {b.hold_expires_at && b.status === 'pending' && <Row label="Hold expires">{formatDateTime(b.hold_expires_at)}</Row>}
            {b.cancel_reason && <Row label="Reason">{b.cancel_reason}</Row>}
          </dl>
          {b.status !== 'blocked' && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(guestLink).then(() => toast.success('Guest link copied')) }}><Copy className="h-4 w-4" /> Copy guest link</Button>
              <Button variant="outline" size="sm" asChild><a href={guestLink} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /> Open guest page</a></Button>
            </div>)}
          </CardContent>
        </Card>

        {b.status !== 'blocked' && (
          <Card>
            <CardHeader><CardTitle>Money</CardTitle></CardHeader>
            <CardContent><dl className="divide-y">
              <Row label="Nights total"><Money value={b.nightly_total} /></Row>
              <Row label="Cleaning fee"><Money value={b.cleaning_fee} /></Row>
              {b.discount > 0 && <Row label="Discount"><Money value={-b.discount} /></Row>}
              <Row label="Total"><Money value={b.total_amount} /></Row>
              <Row label="Deposit required"><Money value={b.deposit_required} /></Row>
              <Row label="Paid"><Money value={b.amount_paid} /></Row>
              <Row label="Balance"><Money value={bal} className={bal > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'} /></Row>
            </dl></CardContent>
          </Card>
        )}
      </div>

      {b.status !== 'blocked' && (
        <Card className="mt-4">
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>Payments</CardTitle>
            <div className="flex flex-wrap gap-2">
              {bal > 0 && b.guest && ['pending', 'confirmed', 'checked_in', 'checked_out'].includes(b.status) && <Button size="sm" onClick={() => setRequesting(true)}><Smartphone className="h-4 w-4" /> Request payment by M-Pesa</Button>}
              <Button size="sm" variant="outline" onClick={() => setRecording(true)}><Plus className="h-4 w-4" /> Record manual payment</Button>
            </div>
          </CardHeader>
          <CardContent>
            {payments.isLoading && <Skeleton className="h-16" />}
            {payments.data?.length === 0 && <p className="py-4 text-sm text-muted-foreground">No payments yet.</p>}
            <ul className="divide-y">
              {payments.data?.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                  <div>
                    <p className="font-medium"><Money value={p.kind === 'refund' ? -p.amount : p.amount} /> <span className="font-normal capitalize text-muted-foreground">· {p.kind} · {METHOD_LABEL[p.method]}</span></p>
                    <p className="text-xs text-muted-foreground">{formatDateTime(p.confirmed_at ?? p.created_at)}{p.mpesa_receipt && <> · {p.mpesa_receipt}</>}{p.status === 'failed' && p.result_desc && <> · {p.result_desc}</>}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <PaymentBadge status={p.status} />
                    {p.status === 'succeeded' && p.kind !== 'refund' && (
                      <Button variant="ghost" size="sm" asChild><a href={`/receipt/${p.id}?token=${b.public_token}`} target="_blank" rel="noreferrer"><Receipt className="h-4 w-4" /> Receipt</a></Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card className="mt-4">
        <CardHeader className="flex-row items-center justify-between"><CardTitle>Internal notes</CardTitle><Button variant="ghost" size="sm" onClick={() => setEditNotes(true)}><Pencil className="h-4 w-4" /> Edit</Button></CardHeader>
        <CardContent><p className="whitespace-pre-line text-sm">{b.notes || <span className="text-muted-foreground">No notes.</span>}</p></CardContent>
      </Card>

      {requesting && <RequestPaymentDialog booking={b} onClose={() => setRequesting(false)} onDone={() => { setRequesting(false); refresh() }} />}
      {recording && <RecordPaymentDialog booking={b} userId={me.id} onClose={() => setRecording(false)} onDone={() => { setRecording(false); refresh() }} />}
      {pending && <StatusDialog action={pending} booking={b} busy={setStatus.isPending} onClose={() => setPending(null)} onConfirm={(reason) => setStatus.mutate({ to: pending.to, reason })} />}
      {editNotes && <NotesDialog id={id} initial={b.notes ?? ''} onClose={() => setEditNotes(false)} onDone={() => { setEditNotes(false); refresh() }} />}
    </div>
  )
}

function StatusDialog({ action, booking, busy, onClose, onConfirm }: { action: NextAction; booking: { total_amount: number; amount_paid: number; check_in: string; check_out: string }; busy: boolean; onClose: () => void; onConfirm: (reason?: string) => void }) {
  const [reason, setReason] = useState('')
  const owing = booking.total_amount - booking.amount_paid
  const warn = (action.to === 'checked_in' || action.to === 'checked_out') && owing > 0
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={action.label}>
        <div className="grid gap-4">
          {warn && <p className="flex gap-2 rounded-md bg-amber-500/10 p-3 text-sm"><AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden /> A balance of KES {owing.toLocaleString('en-US')} is still unpaid. You can continue, but remember to collect it.</p>}
          {action.needsReason ? (
            <Field label="Reason" htmlFor="st-reason" hint="Saved on the booking. The system never refunds automatically: record any refund as a payment afterwards.">
              <Textarea id="st-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          ) : <p className="text-sm text-muted-foreground">{action.to === 'checked_out' ? 'A cleaning task will be created for the unit.' : 'Confirm to continue.'}</p>}
          <div className="flex gap-2">
            <Button variant={action.variant === 'danger' ? 'danger' : 'default'} loading={busy} disabled={action.needsReason && !reason.trim()} onClick={() => onConfirm(reason.trim() || undefined)}>{action.label}</Button>
            <Button variant="ghost" onClick={onClose}>Not now</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function NotesDialog({ id, initial, onClose, onDone }: { id: string; initial: string; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState(initial)
  const save = useMutation({
    mutationFn: async () => { const { error } = await sb().from('bookings').update({ notes: text.trim() || null }).eq('id', id); if (error) throw error },
    onSuccess: () => { toast.success('Notes saved'); onDone() },
    onError: (e) => toast.error(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Internal notes" description="Only staff see these.">
        <Textarea aria-label="Notes" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
        <Button className="mt-3" loading={save.isPending} onClick={() => save.mutate()}>Save notes</Button>
      </DialogContent>
    </Dialog>
  )
}
