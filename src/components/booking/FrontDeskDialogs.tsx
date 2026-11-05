import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { formatKES, parseKES } from '~/lib/money'
import { errMessage } from '~/lib/utils'
import { todayNairobi } from '~/lib/dates'
import { Button } from '~/components/ui/button'
import { Dialog, DialogContent } from '~/components/ui/dialog'
import { Field, Input, Select, Textarea } from '~/components/ui/form'

export type FrontDeskBooking = {
  id: string; reference: string; property_id: string; unit_id: string; num_guests: number; check_in: string; check_out: string
  total_amount: number; amount_paid: number; deposit_required: number
}

/** Settings used to suggest the early / late fee (staff can change the amount). */
function useFee(key: 'early_checkin_fee' | 'late_checkout_fee') {
  return useQuery({ queryKey: ['fee', key], queryFn: async () => {
    const { data } = await sb().from('settings').select('value').eq('key', key).maybeSingle()
    const n = Number(data?.value ?? 0)
    return Number.isFinite(n) ? n : 0
  } })
}

export function CheckInDialog({ booking: b, onClose, onDone }: { booking: FrontDeskBooking; onClose: () => void; onDone: () => void }) {
  const early = todayNairobi() < b.check_in
  const units = useQuery({ queryKey: ['units-of', b.property_id], queryFn: async () => {
    const { data, error } = await sb().from('units').select('id, name, max_guests, maintenance_status').eq('property_id', b.property_id).eq('active', true).order('sort').order('name')
    if (error) throw error
    return data as { id: string; name: string; max_guests: number; maintenance_status: string }[]
  } })
  const fee = useFee('early_checkin_fee')
  const [v, setV] = useState({ unit: b.unit_id, guests: String(b.num_guests), idVerified: false, idNote: '', requests: '', notes: '', earlyOk: false, waive: false, earlyFee: '' })
  const [err, setErr] = useState('')
  const depositMissing = b.amount_paid < b.deposit_required
  const run = useMutation({
    mutationFn: async () => {
      setErr('')
      const guests = Number(v.guests)
      if (!Number.isInteger(guests) || guests < 1) throw new Error('Enter the number of guests.')
      if (!v.idVerified) throw new Error('Confirm that you checked the guest\'s identity.')
      const { error } = await sb().rpc('check_in_booking', {
        p_booking: b.id, p_unit: v.unit, p_guests: guests, p_id_verified: v.idVerified, p_id_note: v.idNote || null, p_requests: v.requests || null,
        p_notes: v.notes || null, p_early_approved: v.earlyOk, p_waive_deposit: v.waive,
      })
      if (error) throw error
      const f = parseKES(v.earlyFee || '0')
      if (early && f && f > 0) {
        const r = await sb().rpc('add_booking_charge', { p_booking: b.id, p_label: 'Early check-in', p_amount: f })
        if (r.error) throw r.error
      }
    },
    onSuccess: () => { toast.success('Guest checked in'); onDone() },
    onError: (e) => setErr(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Check in ${b.reference}`} description="Confirm the details before the guest goes to the room.">
        <div className="grid gap-4">
          {depositMissing && <p role="alert" className="rounded-md bg-amber-500/10 p-3 text-sm">The deposit of {formatKES(b.deposit_required)} has not been received (paid {formatKES(b.amount_paid)}). Record the payment first{' '}
            <label className="mt-1 flex items-center gap-2"><input type="checkbox" checked={v.waive} onChange={(e) => setV({ ...v, waive: e.target.checked })} /> or approve check-in without the deposit</label></p>}
          {early && <div className="rounded-md bg-amber-500/10 p-3 text-sm">
            <p>This arrival is before the booked date ({b.check_in}). The room must be free and clean.</p>
            <label className="mt-1 flex items-center gap-2"><input type="checkbox" checked={v.earlyOk} onChange={(e) => setV({ ...v, earlyOk: e.target.checked })} /> I approve this early check-in</label>
            <Field label="Early check-in fee (KES, optional)" htmlFor="ci-fee" className="mt-2" hint={fee.data ? `Policy fee: ${formatKES(fee.data)}` : undefined}>
              <Input id="ci-fee" inputMode="numeric" placeholder={fee.data ? String(fee.data) : '0'} value={v.earlyFee} onChange={(e) => setV({ ...v, earlyFee: e.target.value })} /></Field>
          </div>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Room" htmlFor="ci-unit"><Select id="ci-unit" value={v.unit} onChange={(e) => setV({ ...v, unit: e.target.value })}>{units.data?.map((u) => <option key={u.id} value={u.id} disabled={u.maintenance_status !== 'ok'}>{u.name}{u.maintenance_status !== 'ok' ? ' (maintenance)' : ''}</option>)}</Select></Field>
            <Field label="Number of guests" htmlFor="ci-guests"><Input id="ci-guests" inputMode="numeric" value={v.guests} onChange={(e) => setV({ ...v, guests: e.target.value })} /></Field>
          </div>
          <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={v.idVerified} onChange={(e) => setV({ ...v, idVerified: e.target.checked })} /> I verified the guest's identity using the business's procedure</label>
          <Field label="How identity was verified (optional)" htmlFor="ci-idn" hint="For example: national ID seen. Do not type ID numbers here."><Input id="ci-idn" maxLength={300} value={v.idNote} onChange={(e) => setV({ ...v, idNote: e.target.value })} /></Field>
          <Field label="Guest requests" htmlFor="ci-req"><Input id="ci-req" maxLength={500} value={v.requests} onChange={(e) => setV({ ...v, requests: e.target.value })} /></Field>
          <Field label="Notes" htmlFor="ci-notes"><Textarea id="ci-notes" rows={2} maxLength={500} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <div className="flex gap-2"><Button loading={run.isPending} onClick={() => run.mutate()}>Check in</Button><Button variant="ghost" onClick={onClose}>Not now</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function CheckOutDialog({ booking: b, onClose, onDone }: { booking: FrontDeskBooking; onClose: () => void; onDone: () => void }) {
  const late = todayNairobi() > b.check_out
  const fee = useFee('late_checkout_fee')
  const [lateFee, setLateFee] = useState('')
  const [notes, setNotes] = useState('')
  const [accept, setAccept] = useState(false)
  const [err, setErr] = useState('')
  const fn = parseKES(lateFee || '0') ?? 0
  const owing = Math.max(0, b.total_amount + fn - b.amount_paid)
  const run = useMutation({
    mutationFn: async () => {
      setErr('')
      const { error } = await sb().rpc('check_out_booking', { p_booking: b.id, p_notes: notes || null, p_late_fee: fn, p_accept_balance: accept })
      if (error) throw error
    },
    onSuccess: () => { toast.success('Guest checked out. A cleaning task was created.'); onDone() },
    onError: (e) => setErr(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Check out ${b.reference}`} description="Review the account, then release the room to housekeeping.">
        <div className="grid gap-4">
          <p className="text-sm">Total {formatKES(b.total_amount + fn)} · paid {formatKES(b.amount_paid)} · <b className={owing > 0 ? 'text-danger' : ''}>{owing > 0 ? `owing ${formatKES(owing)}` : 'settled'}</b></p>
          {late && <Field label="Late check-out fee (KES, optional)" htmlFor="co-fee" hint={fee.data ? `Policy fee: ${formatKES(fee.data)}` : 'The stay ran past the booked check-out date.'}>
            <Input id="co-fee" inputMode="numeric" placeholder={fee.data ? String(fee.data) : '0'} value={lateFee} onChange={(e) => setLateFee(e.target.value)} /></Field>}
          {owing > 0 && <label className="flex items-start gap-2 rounded-md bg-amber-500/10 p-3 text-sm"><input className="mt-1" type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /> The guest leaves with KES {owing.toLocaleString('en-US')} unpaid. I accept this and will follow it up.</label>}
          <Field label="Departure notes" htmlFor="co-notes"><Textarea id="co-notes" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <div className="flex gap-2"><Button loading={run.isPending} disabled={owing > 0 && !accept} onClick={() => run.mutate()}>Check out</Button><Button variant="ghost" onClick={onClose}>Not now</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
