import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { MessageCircle, Send } from 'lucide-react'
import { callFunction, sb } from '~/lib/supabase'
import { waLink } from '~/lib/brand'
import { formatDateTime } from '~/lib/dates'
import { errMessage } from '~/lib/utils'
import type { MessageLog } from '~/lib/types'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import { Textarea } from '~/components/ui/form'
import { Skeleton } from '~/components/ui/misc'

const TEMPLATES = [
  { value: 'booking_confirmed', label: 'Booking confirmed' }, { value: 'payment_receipt', label: 'Payment receipt' },
  { value: 'balance_reminder', label: 'Balance reminder' }, { value: 'checkin_reminder', label: 'Check-in reminder' }, { value: 'thank_you', label: 'Thank you' },
] as const
type TemplateValue = (typeof TEMPLATES)[number]['value'] | 'custom'

export function MessageStatus({ status }: { status: string }) {
  const tone = status === 'failed' ? 'text-danger border-danger/40' : status === 'skipped' ? 'text-muted-foreground' : status === 'queued' ? 'text-amber-700 border-amber-500/40' : 'text-emerald-700 border-emerald-600/40 dark:text-emerald-400'
  return <Badge className={tone}>{status}</Badge>
}

/** Resend a logged message. If WhatsApp is off, `wa.me` lets staff send the exact same text from their own phone. */
export function ManualSendButton({ m }: { m: Pick<MessageLog, 'to_phone' | 'body' | 'status'> }) {
  if (!m.body || (m.status !== 'skipped' && m.status !== 'failed')) return null
  return (
    <Button variant="outline" size="sm" asChild>
      <a href={waLink(m.to_phone, m.body)} target="_blank" rel="noopener noreferrer"><MessageCircle className="h-4 w-4" /> Send via WhatsApp</a>
    </Button>
  )
}

export function useSendMessage(bookingId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { template: TemplateValue; text?: string }) =>
      callFunction<{ status: string; wa_link: string }>('send-whatsapp', { booking_id: bookingId, template: v.template, text: v.text }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['messages'] })
      if (r.status === 'sent') toast.success('Message sent on WhatsApp')
      else toast.message('WhatsApp sending is off or failed. Use "Send via WhatsApp" to send it from your phone.')
    },
    onError: (e) => toast.error(errMessage(e)),
  })
}

export function MessagesPanel({ bookingId }: { bookingId: string }) {
  const [tpl, setTpl] = useState<TemplateValue>('booking_confirmed')
  const [text, setText] = useState('')
  const send = useSendMessage(bookingId)
  const q = useQuery({
    queryKey: ['messages', 'booking', bookingId],
    queryFn: async () => {
      const { data, error } = await sb().from('message_log').select('*').eq('booking_id', bookingId).order('created_at', { ascending: false }).limit(50)
      if (error) throw error
      return data as MessageLog[]
    },
  })
  return (
    <div>
      {q.isLoading && <Skeleton className="h-16" />}
      {q.data?.length === 0 && <p className="py-2 text-sm text-muted-foreground">No messages yet. Confirmations go out automatically once a payment arrives.</p>}
      <ul className="divide-y">
        {q.data?.map((m) => (
          <li key={m.id} className="grid gap-1 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{m.template.replace(/_/g, ' ')} <span className="font-normal text-muted-foreground">· {formatDateTime(m.created_at)}</span></span>
              <span className="flex items-center gap-2"><MessageStatus status={m.status} /><ManualSendButton m={m} /></span>
            </div>
            {m.error && <p className="text-xs text-muted-foreground">{m.error}</p>}
            <p className="line-clamp-2 whitespace-pre-line text-muted-foreground">{m.body}</p>
          </li>
        ))}
      </ul>
      <div className="mt-3 grid gap-2 border-t pt-3">
        <label className="text-sm font-medium" htmlFor="msg-tpl">Send a message</label>
        <div className="flex flex-wrap gap-2">
          <select id="msg-tpl" className="h-11 rounded-md border bg-card px-3 text-sm" value={tpl} onChange={(e) => setTpl(e.target.value as TemplateValue)}>
            {TEMPLATES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}<option value="custom">Custom message…</option>
          </select>
          <Button onClick={() => send.mutate({ template: tpl, text: tpl === 'custom' ? text : undefined })} loading={send.isPending} disabled={tpl === 'custom' && !text.trim()}><Send className="h-4 w-4" /> Send</Button>
        </div>
        {tpl === 'custom' && <Textarea aria-label="Custom message" rows={3} maxLength={1500} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write your message…" />}
      </div>
    </div>
  )
}
