import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { formatKES, parseKES } from '~/lib/money'
import { errMessage } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { Dialog, DialogContent } from '~/components/ui/dialog'
import { Field, Input } from '~/components/ui/form'

/** Shows only when the guest has credit and the booking has a balance. The database enforces both limits. */
export function UseCreditButton({ bookingId, guestId, balance, onDone }: { bookingId: string; guestId: string; balance: number; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const credit = useQuery({ queryKey: ['guest-credit', guestId], queryFn: async () => {
    const { data, error } = await sb().rpc('guest_credit_balance', { p_guest: guestId })
    if (error) throw error
    return (data as number | null) ?? 0
  } })
  const max = Math.min(credit.data ?? 0, balance)
  const [amount, setAmount] = useState('')
  const [err, setErr] = useState('')
  const apply = useMutation({
    mutationFn: async () => {
      const n = parseKES(amount)
      if (!n || n < 1) throw new Error('Enter an amount.')
      const { error } = await sb().rpc('apply_guest_credit', { p_booking: bookingId, p_amount: n })
      if (error) throw error
    },
    onSuccess: () => { toast.success('Credit applied'); setOpen(false); credit.refetch(); onDone() },
    onError: (e) => setErr(errMessage(e)),
  })
  if (!credit.data || credit.data < 1 || balance < 1) return null
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => { setAmount(String(max)); setErr(''); setOpen(true) }}><Wallet className="h-4 w-4" /> Use guest credit ({formatKES(credit.data)})</Button>
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent title="Use guest credit" description={`The guest has ${formatKES(credit.data)} credit. This booking owes ${formatKES(balance)}.`}>
            <div className="grid gap-4">
              <Field label="Amount (KES)" htmlFor="uc-amt" error={err}><Input id="uc-amt" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
              <Button loading={apply.isPending} onClick={() => apply.mutate()}>Apply credit</Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
