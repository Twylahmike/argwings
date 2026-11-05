import { useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { sessionFromUrl } from '~/lib/auth-link'
import { fetchCustomer } from '~/lib/customer'
import { AuthShell } from '~/components/account/AuthShell'
import { Button } from '~/components/ui/button'

export const Route = createFileRoute('/auth/callback')({
  head: () => ({ meta: [{ title: 'Confirming your email' }, { name: 'robots', content: 'noindex' }] }),
  ssr: false,
  component: Callback,
})

/** Landing page for the email verification link. Activates the membership, then opens the account. */
function Callback() {
  const nav = useNavigate()
  const [msg, setMsg] = useState('')
  useEffect(() => {
    let alive = true
    void (async () => {
      const r = await sessionFromUrl()
      if (!alive) return
      if (!r.ok) { setMsg(/expired|invalid|used/i.test(r.reason) ? 'This link has expired or was already used. Sign in, or request a new verification email.' : r.reason); return }
      const cs = await fetchCustomer()
      if (!alive) return
      if (cs.state === 'ready') { nav({ to: '/account', search: { welcome: cs.newlyJoined ? '1' : undefined } }); return }
      if (cs.state === 'staff') { nav({ to: '/admin' }); return }
      setMsg('We could not confirm your email yet. Please try the link again.')
    })()
    return () => { alive = false }
  }, [nav])
  return (
    <AuthShell title={msg ? 'We hit a snag' : 'Confirming your email'} promo={false}>
      {msg ? (
        <div className="grid gap-4 text-sm" role="alert">
          <p>{msg}</p>
          <Button asChild><Link to="/login" search={{}}>Go to sign in</Link></Button>
        </div>
      ) : <p className="text-sm text-muted-foreground" role="status">One moment while we activate your membership&hellip;</p>}
    </AuthShell>
  )
}
