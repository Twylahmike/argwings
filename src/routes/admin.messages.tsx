import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageCircle, Send } from 'lucide-react'
import { toast } from 'sonner'
import { callFunction, sb } from '~/lib/supabase'
import { errMessage } from '~/lib/utils'
import { requireRole } from '~/lib/auth'
import { formatDateTime } from '~/lib/dates'
import { formatPhoneLocal } from '~/lib/phone'
import type { MessageLog } from '~/lib/types'
import { Button } from '~/components/ui/button'
import { Dialog, DialogContent } from '~/components/ui/dialog'
import { Field, Input, Select, Textarea } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, TableWrap, td, th } from '~/components/ui/misc'
import { ManualSendButton, MessageStatus } from '~/components/booking/MessagesPanel'
import { BookingLink } from '~/components/booking/BookingBits'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/messages')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: MessagesPage,
})

type Row = MessageLog & { booking: { id: string; reference: string } | null }

function MessagesPage() {
  const { scopeIds } = useAdmin()
  const [status, setStatus] = useState('')
  const [composing, setComposing] = useState(false)
  const q = useQuery({
    queryKey: ['messages', scopeIds, status],
    queryFn: async () => {
      let query = sb().from('message_log').select('*, booking:bookings(id, reference)').in('property_id', scopeIds).order('created_at', { ascending: false }).limit(300)
      if (status) query = query.eq('status', status)
      const { data, error } = await query
      if (error) throw error
      return data as unknown as Row[]
    },
  })
  const resend = useSendBooking()
  return (
    <div>
      <PageHeader title="Messages" description="Every WhatsApp message the system sends. If sending is off or fails, use the green button to send it yourself."
        actions={<Button onClick={() => setComposing(true)}><Send className="h-4 w-4" /> New message</Button>} />
      <div className="mb-4 max-w-xs"><Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['sent', 'delivered', 'read', 'skipped', 'failed', 'queued'].map((s) => <option key={s}>{s}</option>)}</Select></div>
      {q.isLoading && <Skeleton className="h-48" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data?.length === 0 && <EmptyState icon={MessageCircle} title="No messages yet" description="Confirmations and reminders appear here." />}
      {!!q.data?.length && <TableWrap>
        <thead><tr>{['When', 'To', 'Booking', 'Type', 'Status', 'Message', ''].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
        <tbody className="divide-y">{q.data.map((m) => (
          <tr key={m.id} className="align-top">
            <td className={`${td} whitespace-nowrap`}>{formatDateTime(m.created_at)}</td><td className={td}>{formatPhoneLocal(m.to_phone)}</td>
            <td className={td}>{m.booking ? <BookingLink id={m.booking.id}>{m.booking.reference}</BookingLink> : '—'}</td>
            <td className={`${td} capitalize`}>{m.template.replace(/_/g, ' ')}</td>
            <td className={td}><MessageStatus status={m.status} />{m.error && <p className="mt-1 max-w-[12rem] text-xs text-muted-foreground">{m.error}</p>}</td>
            <td className={`${td} max-w-xs`}><p className="line-clamp-2 whitespace-pre-line text-muted-foreground">{m.body}</p></td>
            <td className={`${td} whitespace-nowrap`}><div className="flex gap-1"><ManualSendButton m={m} />
              {m.booking && m.template !== 'custom' && <Button variant="ghost" size="sm" loading={resend.isPending} onClick={() => resend.mutate({ bookingId: m.booking!.id, template: m.template })}>Resend</Button>}</div></td>
          </tr>))}</tbody>
      </TableWrap>}
      {composing && <Compose onClose={() => setComposing(false)} />}
    </div>
  )
}

function useSendBooking() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { bookingId: string; template: string; text?: string }) => callFunction<{ status: string }>('send-whatsapp', { booking_id: v.bookingId, template: v.template, text: v.text }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['messages'] }); toast[r.status === 'sent' ? 'success' : 'message'](r.status === 'sent' ? 'Message sent' : 'WhatsApp is off or failed: use "Send via WhatsApp" on the new row.') },
    onError: (e) => toast.error(errMessage(e)),
  })
}

function Compose({ onClose }: { onClose: () => void }) {
  const [ref, setRef] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function go() {
    setError(''); setBusy(true)
    try {
      const { data } = await sb().from('bookings').select('id').ilike('reference', ref.trim()).maybeSingle()
      if (!data) { setError('No booking with that reference.'); return }
      const r = await callFunction<{ status: string }>('send-whatsapp', { booking_id: data.id, template: 'custom', text })
      toast[r.status === 'sent' ? 'success' : 'message'](r.status === 'sent' ? 'Message sent' : 'Logged. WhatsApp is off, so use "Send via WhatsApp" on the new row.')
      onClose()
    } catch (e) { setError(errMessage(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="New message" description="Sent to the guest on the booking.">
        <div className="grid gap-4">
          <Field label="Booking reference" htmlFor="cm-ref"><Input id="cm-ref" placeholder="BNB-2611-0001" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
          <Field label="Message" htmlFor="cm-text"><Textarea id="cm-text" rows={4} maxLength={1500} value={text} onChange={(e) => setText(e.target.value)} /></Field>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <Button loading={busy} disabled={!ref.trim() || !text.trim()} onClick={go}>Send</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
