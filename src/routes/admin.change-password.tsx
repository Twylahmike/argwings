import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { homePath } from '~/lib/auth'
import { Button } from '~/components/ui/button'
import { Field, Input } from '~/components/ui/form'
import { PageHeader } from '~/components/ui/misc'
import { errMessage } from '~/lib/utils'

const schema = z.object({
  password: z.string().min(10, 'Use at least 10 characters'),
  confirm: z.string(),
}).refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'The two passwords do not match' })

export const Route = createFileRoute('/admin/change-password')({ component: ChangePassword })

function ChangePassword() {
  const { me } = Route.useRouteContext()
  const { queryClient } = Route.useRouteContext()
  const nav = useNavigate()
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) })

  async function onSubmit(v: z.infer<typeof schema>) {
    // Updating the password and clearing the "must change" flag in one call.
    const { error } = await sb().auth.updateUser({ password: v.password, data: { must_change_password: false } })
    if (error) { setError('password', { message: errMessage(error) }); return }
    await queryClient.invalidateQueries({ queryKey: ['me'] })
    toast.success('Password updated')
    nav({ to: homePath(me) })
  }
  return (
    <div className="max-w-md">
      <PageHeader title="Change password" description={me.mustChangePassword ? 'Please choose a new password before you continue.' : undefined} />
      <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4" noValidate>
        <Field label="New password" htmlFor="password" error={errors.password?.message}>
          <Input id="password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...register('password')} />
        </Field>
        <Field label="Confirm new password" htmlFor="confirm" error={errors.confirm?.message}>
          <Input id="confirm" type="password" autoComplete="new-password" aria-invalid={!!errors.confirm} {...register('confirm')} />
        </Field>
        <Button type="submit" loading={isSubmitting}>Save password</Button>
      </form>
    </div>
  )
}
