import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { MailCheck } from 'lucide-react'
import { signUp, passwordProblem } from '~/lib/customer'
import { useBrand, DEFAULT_BRAND, type Brand } from '~/lib/brand'
import { pageMeta } from '~/lib/seo'
import { AuthShell } from '~/components/account/AuthShell'
import { Button } from '~/components/ui/button'
import { Field, Input } from '~/components/ui/form'

export const Route = createFileRoute('/join')({
  validateSearch: (s: Record<string, unknown>): { email?: string } => (typeof s.email === 'string' && s.email.length < 120 ? { email: s.email } : {}),
  head: ({ matches }) => {
    const brand = (matches[0]?.loaderData as { brand?: Brand } | undefined)?.brand ?? DEFAULT_BRAND
    return pageMeta({ brand: brand.businessName, site: brand.site, title: 'Join for free', description: `Create your free ${brand.businessName} account for member-only offers and rewards.`, path: '/join' })
  },
  component: Join,
})

const schema = z.object({
  name: z.string().trim().min(2, 'Please enter your full name').max(80),
  email: z.string().trim().email('Enter a valid email address').max(120),
  password: z.string().superRefine((v, ctx) => { const p = passwordProblem(v); if (p) ctx.addIssue({ code: 'custom', message: p }) }),
  confirm: z.string().min(1, 'Please confirm your password'),
  agree: z.boolean().refine((v) => v, 'Please tick the box to continue'),
}).refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'The passwords do not match' })
type Values = z.input<typeof schema>

function Join() {
  const brand = useBrand()
  const prefill = Route.useSearch()
  const [done, setDone] = useState<string | null>(null)
  const [formError, setFormError] = useState('')
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { agree: false, email: prefill.email ?? '' } })

  async function onSubmit(v: Values) {
    setFormError('')
    const r = await signUp({ name: v.name, email: v.email, password: v.password })
    if (r.error) { setFormError(r.error); return }
    setDone(v.email.trim().toLowerCase())
  }

  if (!brand.registrationEnabled) {
    return (
      <AuthShell title="Membership is paused" subtitle="New accounts are not being opened right now." promo={false}>
        <div className="grid gap-4 text-sm">
          <p>You can still book as a guest: it is quick and needs no account.</p>
          <Button asChild><Link to="/search">Find a place to stay</Link></Button>
          <Button asChild variant="outline"><Link to="/login" search={{}}>Sign in</Link></Button>
        </div>
      </AuthShell>
    )
  }

  if (done) {
    return (
      <AuthShell title="Almost there" subtitle="One last step to activate your free membership.">
        <div className="grid gap-4 text-sm" role="status">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-brand/15 text-brand"><MailCheck className="h-6 w-6" aria-hidden /></span>
          <p>We sent a verification link to <b>{done}</b>. Open it to activate your membership and unlock your welcome offer.</p>
          <p className="text-muted-foreground">Can&rsquo;t find it? Check your spam folder. The link works once and expires after a while.</p>
          <Button asChild variant="outline"><Link to="/login" search={{}}>Go to sign in</Link></Button>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell title="Join for free" subtitle={`Create your ${brand.businessName} account in a minute. No card needed.`}>
      <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4" noValidate>
        <Field label="Full name" htmlFor="j-name" error={errors.name?.message}><Input id="j-name" autoComplete="name" aria-invalid={!!errors.name} {...register('name')} /></Field>
        <Field label="Email address" htmlFor="j-email" error={errors.email?.message}><Input id="j-email" type="email" inputMode="email" autoComplete="email" aria-invalid={!!errors.email} {...register('email')} /></Field>
        <Field label="Password" htmlFor="j-pass" error={errors.password?.message} hint="At least 8 characters, with upper and lower case letters and a number.">
          <Input id="j-pass" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...register('password')} />
        </Field>
        <Field label="Confirm password" htmlFor="j-confirm" error={errors.confirm?.message}><Input id="j-confirm" type="password" autoComplete="new-password" aria-invalid={!!errors.confirm} {...register('confirm')} /></Field>
        <div>
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" {...register('agree')} />
            <span>I agree to the terms and privacy notice, and to receive account emails.</span></label>
          {errors.agree && <p role="alert" className="mt-1 text-xs text-danger">{errors.agree.message}</p>}
        </div>
        {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}
        <Button type="submit" size="lg" loading={isSubmitting} className="uppercase tracking-wider">Join for free</Button>
        <p className="text-center text-sm text-muted-foreground">Already a member? <Link to="/login" search={{}} className="font-medium text-foreground underline">Sign in</Link></p>
      </form>
    </AuthShell>
  )
}
