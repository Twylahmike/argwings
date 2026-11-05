import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { rpc, passwordProblem } from '~/lib/customer'
import { errMessage } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { Field, Input } from '~/components/ui/form'
import { Skeleton } from '~/components/ui/misc'
import { useCustomer } from './account'

export const Route = createFileRoute('/account/settings')({ component: Settings })

function Settings() {
  const c = useCustomer()
  const qc = useQueryClient()
  const nav = useNavigate()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [err, setErr] = useState('')
  const change = useMutation({
    mutationFn: async () => {
      const p = passwordProblem(pw)
      if (p) throw new Error(p)
      if (pw !== pw2) throw new Error('The passwords do not match.')
      const { sb } = await import('~/lib/supabase')
      const { error } = await sb().auth.updateUser({ password: pw })
      if (error) throw new Error(/same|different/i.test(error.message) ? 'Choose a password you have not used before.' : error.message)
    },
    onSuccess: () => { toast.success('Password updated'); setPw(''); setPw2(''); setErr('') },
    onError: (e) => setErr(errMessage(e)),
  })
  const marketing = useMutation({
    mutationFn: (on: boolean) => rpc('update_my_profile', { p_name: c!.full_name, p_phone: c!.phone ?? '', p_country: c!.country ?? '', p_birthday: c!.birthday, p_marketing: on }),
    onSuccess: () => { toast.success('Saved'); qc.invalidateQueries({ queryKey: ['customer'] }) },
    onError: (e) => toast.error(errMessage(e)),
  })
  const [reason, setReason] = useState('')
  const [asked, setAsked] = useState(false)
  async function downloadData() {
    try {
      const data = await rpc<unknown>('my_data_export')
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
      const a = document.createElement('a')
      a.href = url; a.download = 'my-data.json'; a.click()
      URL.revokeObjectURL(url)
    } catch (e) { toast.error(errMessage(e)) }
  }
  const deletion = useMutation({
    mutationFn: () => rpc('request_account_deletion', { p_reason: reason }),
    onSuccess: () => { setAsked(true); toast.success('Request sent. Our team will be in touch.') },
    onError: (e) => toast.error(errMessage(e)),
  })
  async function signOutEverywhere() {
    const { sb } = await import('~/lib/supabase')
    await sb().auth.signOut({ scope: 'global' })
    qc.clear()
    nav({ to: '/login', search: {} })
  }
  if (!c) return <Skeleton className="h-64" />
  return (
    <div className="grid max-w-xl gap-6">
      <h1 className="font-display text-4xl">Account settings</h1>
      <form className="grid gap-4 rounded-xl border bg-card p-5" onSubmit={(e) => { e.preventDefault(); change.mutate() }}>
        <h2 className="font-display text-2xl">Change password</h2>
        <Field label="New password" htmlFor="s-pw" hint="At least 8 characters, with upper and lower case letters and a number."><Input id="s-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
        <Field label="Confirm new password" htmlFor="s-pw2"><Input id="s-pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
        <Button type="submit" loading={change.isPending} disabled={!pw}>Update password</Button>
      </form>
      <section className="grid gap-3 rounded-xl border bg-card p-5">
        <h2 className="font-display text-2xl">Emails</h2>
        <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 h-5 w-5" checked={c.marketing_opt_in} disabled={marketing.isPending} onChange={(e) => marketing.mutate(e.target.checked)} />
          <span>Send me member offers and rewards by email. Booking confirmations and receipts are always sent.</span></label>
      </section>
      <section className="grid gap-3 rounded-xl border bg-card p-5">
        <h2 className="font-display text-2xl">Your data</h2>
        <p className="text-sm text-muted-foreground">Download a copy of what we hold about your membership. If you want your account removed, tell us below. We remove your personal details but must keep booking and payment records for the books.</p>
        <Button variant="outline" className="justify-self-start" onClick={downloadData}>Download my data</Button>
        {asked ? <p role="status" className="text-sm">Your request has been sent. We will confirm once it is done.</p> : (
          <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (window.confirm('Ask us to delete your membership?')) deletion.mutate() }}>
            <Field label="Request account deletion (optional reason)" htmlFor="s-del"><Input id="s-del" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} /></Field>
            <Button type="submit" variant="outline" className="justify-self-start" loading={deletion.isPending}>Request deletion</Button>
          </form>
        )}
      </section>
      <section className="grid gap-3 rounded-xl border bg-card p-5">
        <h2 className="font-display text-2xl">Security</h2>
        <p className="text-sm text-muted-foreground">Signed in on a shared device? Sign out of every device at once.</p>
        <Button variant="outline" onClick={signOutEverywhere}>Sign out everywhere</Button>
      </section>
    </div>
  )
}
