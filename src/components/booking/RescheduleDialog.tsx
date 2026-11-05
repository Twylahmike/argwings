import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { formatKES } from '~/lib/money'
import { errMessage } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { Dialog, DialogContent } from '~/components/ui/dialog'
import { Field, Input, Select } from '~/components/ui/form'
import type { FrontDeskBooking } from './FrontDeskDialogs'

type Preview = { nights: number; old_total: number; new_total: number; difference: number; amount_paid: number; balance_after: number; refund_due: number }

/** Change a booking's dates and/or room. The preview comes from the database (same quote the website uses); saving is refused if the dates clash. */
export function RescheduleDialog({ booking: b, status, onClose, onDone }: { booking: FrontDeskBooking; status: string; onClose: () => void; onDone: () => void }) {
  const checkedIn = status === 'checked_in'
  const [from, setFrom] = useState(b.check_in)
  const [to, setTo] = useState(b.check_out)
  const [unit, setUnit] = useState(b.unit_id)
  const [reprice, setReprice] = useState(true)
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const units = useQuery({ queryKey: ['units-of', b.property_id], queryFn: async () => {
    const { data, error } = await sb().from('units').select('id, name, max_guests').eq('property_id', b.property_id).eq('active', true).order('sort').order('name')
    if (error) throw error
    return data as { id: string; name: string; max_guests: number }[]
  } })
  const changed = from !== b.check_in || to !== b.check_out || unit !== b.unit_id
  const preview = useQuery({
    queryKey: ['reschedule-preview', b.id, from, to, unit, reprice], enabled: changed && !!from && !!to && to > from, retry: false,
    queryFn: async () => {
      const { data, error } = await sb().rpc('reschedule_booking', { p_booking: b.id, p_in: from, p_out: to, p_unit: unit, p_reprice: reprice, p_reason: null, p_dry_run: true })
      if (error) throw error
      return data as Preview
    },
  })
  const save = useMutation({
    mutationFn: async () => {
      setErr('')
      const { error } = await sb().rpc('reschedule_booking', { p_booking: b.id, p_in: from, p_out: to, p_unit: unit, p_reprice: reprice, p_reason: reason })
      if (error) throw error
    },
    onSuccess: () => { toast.success('Booking changed'); onDone() },
    onError: (e) => setErr(errMessage(e)),
  })
  const p = preview.data
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Change ${b.reference}`} description={checkedIn ? 'The guest is checked in, so only the check-out date can change.' : 'Move the stay to other dates or another room. The new dates must be free.'}>
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Check-in" htmlFor="rs-in"><Input id="rs-in" type="date" disabled={checkedIn} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="Check-out" htmlFor="rs-out"><Input id="rs-out" type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          </div>
          <Field label="Room" htmlFor="rs-unit"><Select id="rs-unit" disabled={checkedIn} value={unit} onChange={(e) => setUnit(e.target.value)}>{units.data?.map((u) => <option key={u.id} value={u.id}>{u.name} (sleeps {u.max_guests})</option>)}</Select></Field>
          <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={reprice} onChange={(e) => setReprice(e.target.checked)} /> Recalculate the price for the new dates and room (untick to keep the agreed total)</label>
          {changed && preview.isFetching && <p className="text-sm text-muted-foreground">Checking availability…</p>}
          {changed && preview.error && <p role="alert" className="rounded-md bg-danger/10 p-3 text-sm text-danger">{errMessage(preview.error)}</p>}
          {p && !preview.isFetching && (
            <dl className="grid gap-1 rounded-md bg-muted p-3 text-sm">
              <div className="flex justify-between"><dt>{p.nights} night{p.nights === 1 ? '' : 's'}</dt><dd>New total {formatKES(p.new_total)}</dd></div>
              <div className="flex justify-between"><dt>Was</dt><dd>{formatKES(p.old_total)}</dd></div>
              <div className="flex justify-between font-medium"><dt>Difference</dt><dd className={p.difference > 0 ? 'text-danger' : p.difference < 0 ? 'text-emerald-700 dark:text-emerald-400' : ''}>{p.difference > 0 ? '+' : ''}{formatKES(p.difference)}</dd></div>
              <div className="flex justify-between"><dt>Paid so far</dt><dd>{formatKES(p.amount_paid)}</dd></div>
              <div className="flex justify-between"><dt>Balance after</dt><dd>{formatKES(p.balance_after)}</dd></div>
              {p.refund_due > 0 && <p className="mt-1 text-amber-700 dark:text-amber-400">The guest has paid {formatKES(p.refund_due)} more than the new total. Record a refund or move it to guest credit after saving.</p>}
            </dl>
          )}
          <Field label="Reason (kept in the booking history)" htmlFor="rs-reason"><Input id="rs-reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <div className="flex gap-2"><Button loading={save.isPending} disabled={!changed || !!preview.error || reason.trim().length < 3} onClick={() => save.mutate()}>Save change</Button><Button variant="ghost" onClick={onClose}>Not now</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
