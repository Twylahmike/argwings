import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { adminRpc } from '~/lib/membership-admin'
import { usePermissions } from '~/lib/permissions'
import { errMessage } from '~/lib/utils'
import { formatDate, formatDateTime } from '~/lib/dates'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/form'

type Req = { id: string; kind: 'cancellation' | 'modification'; message: string; new_check_in: string | null; new_check_out: string | null; status: 'open' | 'done' | 'declined'; staff_note: string | null; created_at: string }

/** Change and cancellation requests a member sent from their account. Staff decide; nothing changes by itself. */
export function CustomerRequests({ bookingId }: { bookingId: string }) {
  const qc = useQueryClient()
  const { can } = usePermissions()
  const [note, setNote] = useState('')
  const q = useQuery({
    queryKey: ['customer-requests', bookingId],
    queryFn: async () => { const { data, error } = await sb().from('customer_booking_requests').select('id, kind, message, new_check_in, new_check_out, status, staff_note, created_at').eq('booking_id', bookingId).order('created_at', { ascending: false }); if (error) throw error; return data as Req[] },
  })
  const resolve = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'done' | 'declined' }) => adminRpc('resolve_customer_request', { p_request: id, p_status: status, p_note: note }),
    onSuccess: () => { toast.success('Saved'); setNote(''); qc.invalidateQueries({ queryKey: ['customer-requests', bookingId] }) },
    onError: (e) => toast.error(errMessage(e)),
  })
  if (!q.data?.length) return null
  return (
    <Card>
      <CardHeader><CardTitle>Customer requests</CardTitle></CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {q.data.map((r) => (
          <div key={r.id} className="rounded-lg border p-3">
            <p className="font-medium capitalize">{r.kind} request <span className="font-normal text-muted-foreground">· {formatDateTime(r.created_at)} · {r.status}</span></p>
            {r.new_check_in && r.new_check_out && <p>Wants {formatDate(r.new_check_in)} to {formatDate(r.new_check_out)}</p>}
            <p className="text-muted-foreground">{r.message}</p>
            {r.staff_note && <p className="mt-1">Staff note: {r.staff_note}</p>}
            {r.status === 'open' && can('bookings.manage') && (
              <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                <Input aria-label="Note to the customer record" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
                <Button size="sm" loading={resolve.isPending} onClick={() => resolve.mutate({ id: r.id, status: 'done' })}>Mark handled</Button>
                <Button size="sm" variant="outline" loading={resolve.isPending} onClick={() => resolve.mutate({ id: r.id, status: 'declined' })}>Decline</Button>
              </div>
            )}
          </div>
        ))}
        <p className="text-xs text-muted-foreground">Use Change dates or Cancel on this booking to act on a request, then mark it handled.</p>
      </CardContent>
    </Card>
  )
}
