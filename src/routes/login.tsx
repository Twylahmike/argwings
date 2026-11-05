import { useState } from 'react'
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { fetchMe, homePath } from '~/lib/auth'
import { fetchCustomer, hasStoredSession, authRedirect } from '~/lib/customer'
import { AuthShell } from '~/components/account/AuthShell'
import { Button } from '~/components/ui/button'
import { Field, Input } from '~/components/ui/form'

const schema = z.object({ email: z.string().email('Enter a valid email'), password: z.string().min(1, 'Enter your password') })
type Values = z.infer<typeof schema>

/** Same-site targets only. Members may return to their account or the booking page; staff to the admin area. */
const safeTarget = (t: string | undefined, staff: boolean) => (t && (staff ? t.startsWith('/admin') : /^\/(account|book)(\/|\?|$)/.test(t)) ? t : undefined)

export const Route = createFileRoute('/login')({
  validateSearch: (s: Record<string, unknown>): { redirect?: string } => (typeof s.redirect === 'string' ? { redirect: s.redirect } : {}),
  head: () => ({ meta: [{ title: 'Sign in' }, { name: 'robots', content: 'noindex' }] }),
  ssr: false,
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.fetchQuery({ queryKey: ['me'], queryFn: fetchMe, staleTime: 0 })
    if (me) throw redirect({ to: homePath(me) })
    if (hasStoredSession()) {
      const cs = await fetchCustomer()
      if (cs.state === 'ready') { const t = safeTarget(search.redirect, false) ?? '/account'; throw redirect(t.includes('?') ? { href: t } : { to: t }) }
    }
  },
  component: Login,
})

function Login() {
  const nav = useNavigate()
  const search = Route.useSearch()
  const { queryClient } = Route.useRouteContext()
  const [formError, setFormError] = useState('')
  const [unverified, setUnverified] = useState('')
  const { register, handleSubmit, getValues, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(schema) })

  async function onSubmit(v: Values) {
    setFormError(''); setUnverified('')
    const { error } = await sb().auth.signInWithPassword(v)
    // Best effort: a failed attempt is recorded (throttled) so the owner can see suspicious sign-ins. Never blocks the login.
    void Promise.resolve(sb().rpc('record_login_event', { p_email: v.email, p_success: !error })).catch(() => undefined)
    if (error) {
      if (/not confirmed|confirm/i.test(error.message)) { setUnverified(v.email); setFormError('Please verify your email first. We sent you a link when you joined.'); return }
      if (/rate|too many/i.test(error.message)) { setFormError('Too many attempts. Please wait a few minutes and try again.'); return }
      setFormError('That email or password is not right. Please try again.'); return
    }
    // Staff first (they go to the dashboard), then members.
    const me = await queryClient.fetchQuery({ queryKey: ['me'], queryFn: fetchMe, staleTime: 0 })
    if (me) {
      toast.success(`Welcome back, ${me.fullName.split(' ')[0]}`)
      nav({ to: me.mustChangePassword ? '/admin/change-password' : safeTarget(search.redirect, true) ?? homePath(me) })
      return
    }
    const cs = await fetchCustomer()
    if (cs.state === 'ready') {
      toast.success(`Welcome back, ${cs.customer!.full_name.split(' ')[0]}`)
      const target = safeTarget(search.redirect, false) ?? '/account'
      if (target.includes('?')) window.location.assign(target)   // a full URL with its query (for example back to the booking page)
      else nav({ to: target })
      return
    }
    if (cs.state === 'unverified') { setUnverified(v.email); setFormError('Please verify your email first. We sent you a link when you joined.'); await sb().auth.signOut(); return }
    setFormError('This account is not active. Please contact us.')
    await sb().auth.signOut()
  }

  async function resend() {
    const email = unverified || getValues('email')
    const { error } = await sb().auth.resend({ type: 'signup', email, options: { emailRedirectTo: authRedirect('/auth/callback') } })
    if (error) toast.error('We could not resend the email just now. Please try again in a few minutes.')
    else toast.success('Verification email sent. Check your inbox.')
  }

  return (
    <AuthShell title="Sign in" subtitle="Members, owners and staff sign in here.">
      <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4" noValidate>
        <Field label="Email" htmlFor="email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="username" inputMode="email" aria-invalid={!!errors.email} {...register('email')} />
        </Field>
        <Field label="Password" htmlFor="password" error={errors.password?.message}>
          <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!errors.password} {...register('password')} />
        </Field>
        {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}
        {unverified && <Button type="button" variant="outline" onClick={resend}>Resend verification email</Button>}
        <Button type="submit" size="lg" loading={isSubmitting}>Sign in</Button>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <Link to="/forgot-password" className="text-muted-foreground underline">Forgot password?</Link>
          <span className="text-muted-foreground">New here? <Link to="/join" className="font-medium text-foreground underline">Join for free</Link></span>
        </div>
      </form>
    </AuthShell>
  )
}
