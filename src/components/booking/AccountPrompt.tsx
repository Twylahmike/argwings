import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CircleCheck } from 'lucide-react'
import { claimBookingByToken, fetchCustomer, hasStoredSession } from '~/lib/customer'
import { useBrand } from '~/lib/brand'
import { errMessage } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { Card, CardContent } from '~/components/ui/card'

/**
 * Shown on the booking page after a guest booking. Quiet and optional: the booking and its receipts work without an account.
 *  - Not signed in: invite them to create a free account (the email is carried over).
 *  - Signed-in member: add THIS booking to their account. The secret booking link in the address is the proof they hold it.
 */
export function AccountPrompt({ token, email }: { token: string; email?: string | null }) {
  const brand = useBrand()
  const [stored, setStored] = useState(false)
  useEffect(() => setStored(hasStoredSession()), [])
  const me = useQuery({ queryKey: ['customer'], queryFn: fetchCustomer, enabled: stored, staleTime: 30_000 })
  const member = me.data?.state === 'ready' && me.data.customer!.status === 'active'
  const [added, setAdded] = useState(false)
  const claim = useMutation({
    mutationFn: () => claimBookingByToken(token),
    onSuccess: (r) => { setAdded(true); toast.success(`Booking ${r.reference} added to your account`) },
    onError: (e) => toast.error(errMessage(e)),
  })
  if (member) {
    return (
      <Card className="mt-4"><CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6 text-sm">
        {added ? <p className="flex items-center gap-2"><CircleCheck className="h-4 w-4 text-emerald-600" aria-hidden /> This booking is on your account. <Link to="/account/bookings" search={{ tab: 'all' }} className="underline">View my bookings</Link></p> : <>
          <p>Is this your booking? Add it to your member account to manage it alongside the rest.</p>
          <Button variant="outline" size="sm" loading={claim.isPending} onClick={() => claim.mutate()}>Add to my account</Button></>}
      </CardContent></Card>
    )
  }
  if (!brand.registrationEnabled || stored) return null
  return (
    <Card className="mt-4 border-brand/40"><CardContent className="grid gap-3 pt-6 text-sm">
      <p className="font-medium">Create a free account to manage your bookings and receive exclusive offers.</p>
      <p className="text-muted-foreground">Optional. Your booking, payments and receipts already work from this page. After you verify your email you can add this booking to your account in one tap.</p>
      <div className="flex flex-wrap gap-3">
        <Button asChild size="sm"><Link to="/join" search={email ? { email } : {}}>Join for free</Link></Button>
        <Button asChild size="sm" variant="outline"><Link to="/login" search={{ redirect: `/account` }}>Already a member? Sign in</Link></Button>
      </div>
    </CardContent></Card>
  )
}
