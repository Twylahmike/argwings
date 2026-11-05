import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { rpc, authRedirect } from '~/lib/customer'
import { normalizePhone } from '~/lib/phone'
import { errMessage } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { Field, Input } from '~/components/ui/form'
import { Skeleton } from '~/components/ui/misc'
import { useCustomer } from './account'

export const Route = createFileRoute('/account/profile')({ component: Profile })

function Profile() {
  const c = useCustomer()
  const qc = useQueryClient()
  const [v, setV] = useState({ name: '', phone: '', country: '', birthday: '' })
  const [email, setEmail] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => { if (c) { setV({ name: c.full_name, phone: c.phone ? `0${c.phone.slice(3)}` : '', country: c.country ?? '', birthday: c.birthday ?? '' }); setEmail(c.email) } }, [c])
  const save = useMutation({
    mutationFn: async () => {
      let phone = ''
      if (v.phone.trim()) { const p = normalizePhone(v.phone); if (!p.ok) throw new Error(p.error); phone = p.phone }
      await rpc('update_my_profile', { p_name: v.name, p_phone: phone, p_country: v.country, p_birthday: v.birthday || null, p_marketing: c?.marketing_opt_in ?? true })
    },
    onSuccess: () => { toast.success('Profile saved'); setErr(''); qc.invalidateQueries({ queryKey: ['customer'] }) },
    onError: (e) => setErr(errMessage(e)),
  })
  const changeEmail = useMutation({
    mutationFn: async () => {
      const { sb } = await import('~/lib/supabase')
      const { error } = await sb().auth.updateUser({ email: email.trim().toLowerCase() }, { emailRedirectTo: authRedirect('/auth/callback') })
      if (error) throw new Error(/already|registered/i.test(error.message) ? 'That email is already in use.' : error.message)
    },
    onSuccess: () => toast.success('Check both inboxes: confirm the change from the link we sent. Your email updates once confirmed.'),
    onError: (e) => toast.error(errMessage(e)),
  })
  if (!c) return <Skeleton className="h-64" />
  return (
    <div className="grid max-w-xl gap-6">
      <h1 className="font-display text-4xl">My profile</h1>
      <form className="grid gap-4 rounded-xl border bg-card p-5" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
        <Field label="Full name" htmlFor="p-name"><Input id="p-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} autoComplete="name" /></Field>
        <Field label="Phone (optional)" htmlFor="p-phone" hint="Used to prefill your M-Pesa number at checkout."><Input id="p-phone" type="tel" inputMode="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} autoComplete="tel" placeholder="0712 345 678" /></Field>
        <Field label="Country (optional)" htmlFor="p-country"><Input id="p-country" value={v.country} onChange={(e) => setV({ ...v, country: e.target.value })} autoComplete="country-name" /></Field>
        <Field label="Birthday (optional)" htmlFor="p-bday" hint="Only used to send you a birthday reward if one is running."><Input id="p-bday" type="date" value={v.birthday} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setV({ ...v, birthday: e.target.value })} /></Field>
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
        <Button type="submit" loading={save.isPending}>Save changes</Button>
      </form>
      <form className="grid gap-3 rounded-xl border bg-card p-5" onSubmit={(e) => { e.preventDefault(); changeEmail.mutate() }}>
        <h2 className="font-display text-2xl">Email address</h2>
        <Field label="Email" htmlFor="p-email" hint="We email a confirmation link. Your email only changes after you confirm it."><Input id="p-email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
        <Button type="submit" variant="outline" loading={changeEmail.isPending} disabled={email.trim().toLowerCase() === c.email}>Change email</Button>
      </form>
    </div>
  )
}
