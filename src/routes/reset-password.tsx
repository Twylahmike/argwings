import { useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { passwordProblem } from '~/lib/customer'
import { sessionFromUrl } from '~/lib/auth-link'
import { AuthShell } from '~/components/account/AuthShell'
import { Button } from '~/components/ui/button'
import { Field, Input } from '~/components/ui/form'

export const Route = createFileRoute('/reset-password')({
  head: () => ({ meta: [{ title: 'Choose a new password' }, { name: 'robots', content: 'noindex' }] }),
  ssr: false,
  component: Reset,
})
const schema = z.object({
  password: z.string().superRefine((v, ctx) => { const p = passwordProblem(v); if (p) ctx.addIssue({ code: 'custom', message: p }) }),
  confirm: z.string().min(1, 'Please confirm your password'),
}).refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'The passwords do not match' })
type Values = z.infer<typeof schema>

function Reset() {
  const nav = useNavigate()
  const [state, setState] = useState<'checking' | 'ready' | 'invalid'>('checking')
  const [err, setErr] = useState('')
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(schema) })
  useEffect(() => { void sessionFromUrl().then((r) => setState(r.ok ? 'ready' : 'invalid')) }, [])
  async function onSubmit(v: Values) {
    setErr('')
    const { error } = await sb().auth.updateUser({ password: v.password })
    if (error) { setErr(/same|different/i.test(error.message) ? 'Choose a password you have not used before.' : 'We could not update your password. The link may have expired. Request a new one.'); return }
    await sb().auth.signOut()
    toast.success('Password updated. Please sign in.')
    nav({ to: '/login', search: {} })
  }
  return (
    <AuthShell title="Choose a new password" promo={false}>
      {state === 'checking' && <p className="text-sm text-muted-foreground">Checking your link&hellip;</p>}
      {state === 'invalid' && (
        <div className="grid gap-4 text-sm" role="alert">
          <p>This reset link is not valid any more. Links work once and expire soon.</p>
          <Button asChild><Link to="/forgot-password">Request a new link</Link></Button>
        </div>
      )}
      {state === 'ready' && (
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4" noValidate>
          <Field label="New password" htmlFor="r-pass" error={errors.password?.message} hint="At least 8 characters, with upper and lower case letters and a number.">
            <Input id="r-pass" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...register('password')} />
          </Field>
          <Field label="Confirm new password" htmlFor="r-confirm" error={errors.confirm?.message}><Input id="r-confirm" type="password" autoComplete="new-password" aria-invalid={!!errors.confirm} {...register('confirm')} /></Field>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <Button type="submit" loading={isSubmitting}>Update password</Button>
        </form>
      )}
    </AuthShell>
  )
}
