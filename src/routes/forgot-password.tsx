import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { sb } from '~/lib/supabase'
import { authRedirect } from '~/lib/customer'
import { AuthShell } from '~/components/account/AuthShell'
import { Button } from '~/components/ui/button'
import { Field, Input } from '~/components/ui/form'

export const Route = createFileRoute('/forgot-password')({
  head: () => ({ meta: [{ title: 'Reset your password' }, { name: 'robots', content: 'noindex' }] }),
  ssr: false,
  component: Forgot,
})
const schema = z.object({ email: z.string().trim().email('Enter a valid email address') })

function Forgot() {
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState('')
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<{ email: string }>({ resolver: zodResolver(schema) })
  async function onSubmit(v: { email: string }) {
    setErr('')
    const { error } = await sb().auth.resetPasswordForEmail(v.email.trim().toLowerCase(), { redirectTo: authRedirect('/reset-password') })
    // The same answer whether or not the address has an account, so this cannot be used to find out who is registered.
    if (error && /rate|too many/i.test(error.message)) { setErr('Too many attempts. Please wait a few minutes and try again.'); return }
    setSent(true)
  }
  return (
    <AuthShell title="Reset your password" subtitle="We will email you a link to choose a new one." promo={false}>
      {sent ? (
        <div className="grid gap-4 text-sm" role="status">
          <p>If an account exists for that email, a reset link is on its way. It works once and expires soon.</p>
          <Button asChild variant="outline"><Link to="/login" search={{}}>Back to sign in</Link></Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4" noValidate>
          <Field label="Email" htmlFor="f-email" error={errors.email?.message}><Input id="f-email" type="email" inputMode="email" autoComplete="email" aria-invalid={!!errors.email} {...register('email')} /></Field>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <Button type="submit" loading={isSubmitting}>Send reset link</Button>
          <Link to="/login" search={{}} className="text-center text-sm text-muted-foreground underline">Back to sign in</Link>
        </form>
      )}
    </AuthShell>
  )
}
