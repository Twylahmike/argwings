import { useState } from 'react'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { fetchMe, homePath } from '~/lib/auth'
import { Button } from '~/components/ui/button'
import { Field, Input } from '~/components/ui/form'
import { Wordmark } from '~/components/layout/Wordmark'

const schema = z.object({ email: z.string().email('Enter a valid email'), password: z.string().min(1, 'Enter your password') })
type Values = z.infer<typeof schema>

export const Route = createFileRoute('/login')({
  validateSearch: (s: Record<string, unknown>): { redirect?: string } => (typeof s.redirect === 'string' ? { redirect: s.redirect } : {}),
  head: () => ({ meta: [{ title: 'Staff login' }, { name: 'robots', content: 'noindex' }] }),
  ssr: false,
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery({ queryKey: ['me'], queryFn: fetchMe, staleTime: 0 })
    if (me) throw redirect({ to: homePath(me) })
  },
  component: Login,
})

function Login() {
  const nav = useNavigate()
  const search = Route.useSearch()
  const { queryClient } = Route.useRouteContext()
  const [formError, setFormError] = useState('')
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Values>({ resolver: zodResolver(schema) })

  async function onSubmit(v: Values) {
    setFormError('')
    const { error } = await sb().auth.signInWithPassword(v)
    if (error) { setFormError('That email or password is not right. Please try again.'); return }
    const me = await queryClient.fetchQuery({ queryKey: ['me'], queryFn: fetchMe, staleTime: 0 })
    if (!me) { setFormError('This account is not active. Ask the owner to check your access.'); return }
    toast.success(`Welcome back, ${me.fullName.split(' ')[0]}`)
    // Only follow same-site redirect targets.
    const target = search.redirect && search.redirect.startsWith('/admin') ? search.redirect : homePath(me)
    nav({ to: me.mustChangePassword ? '/admin/change-password' : target })
  }

  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm rounded-2xl border bg-card p-6 shadow-sm">
        <Wordmark className="mb-6" />
        <h1 className="text-xl font-semibold">Staff sign in</h1>
        <p className="mt-1 text-sm text-muted-foreground">Owners, managers and cleaners sign in here.</p>
        <form onSubmit={handleSubmit(onSubmit)} className="mt-5 grid gap-4" noValidate>
          <Field label="Email" htmlFor="email" error={errors.email?.message}>
            <Input id="email" type="email" autoComplete="username" inputMode="email" aria-invalid={!!errors.email} {...register('email')} />
          </Field>
          <Field label="Password" htmlFor="password" error={errors.password?.message}>
            <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!errors.password} {...register('password')} />
          </Field>
          {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}
          <Button type="submit" loading={isSubmitting}>Sign in</Button>
        </form>
      </div>
    </div>
  )
}
