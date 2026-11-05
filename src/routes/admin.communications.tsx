import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { isOwner, requireRole } from '~/lib/auth'
import { errMessage } from '~/lib/utils'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Field, Input, Textarea } from '~/components/ui/form'
import { ErrorState, PageHeader, Skeleton } from '~/components/ui/misc'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/communications')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: CommunicationsPage,
})

type Tpl = { key: string; label: string; body: string | null; enabled: boolean }
const PLACEHOLDERS = ['guest', 'business', 'reference', 'property', 'unit', 'check_in', 'check_out', 'check_in_time', 'check_out_time', 'nights', 'total', 'paid', 'balance', 'amount', 'address', 'phone', 'link']
const SCHEDULE: [string, string, string][] = [
  ['reminder_days_before', 'Pre-arrival reminder', 'days before check-in'],
  ['balance_reminder_days_before', 'Outstanding payment reminder', 'days before check-in'],
  ['checkout_reminder_days_before', 'Check-out reminder', 'days before check-out (0 = on the day)'],
]

function CommunicationsPage() {
  const { me } = useAdmin()
  const owner = isOwner(me)
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['comms'],
    queryFn: async () => {
      const [t, s] = await Promise.all([
        sb().from('message_templates').select('key, label, body, enabled').order('label'),
        sb().from('settings').select('key, value').in('key', ['whatsapp_enabled', ...SCHEDULE.map(([k]) => k)]),
      ])
      if (t.error) throw t.error
      return { templates: t.data as Tpl[], settings: Object.fromEntries((s.data ?? []).map((r) => [r.key as string, r.value as unknown])) }
    },
  })
  const [days, setDays] = useState<Record<string, string>>({})
  const saveDays = useMutation({
    mutationFn: async () => {
      const rows = SCHEDULE.map(([k]) => {
        const raw = days[k] ?? String(q.data?.settings[k] ?? (k === 'reminder_days_before' ? 1 : k === 'balance_reminder_days_before' ? 2 : 0))
        const n = Number(raw)
        if (!Number.isInteger(n) || n < 0 || n > 30) throw new Error('Days must be a whole number from 0 to 30.')
        return { key: k, value: n, updated_at: new Date().toISOString() }
      })
      const { error } = await sb().from('settings').upsert(rows)
      if (error) throw error
    },
    onSuccess: () => { toast.success('Schedule saved'); qc.invalidateQueries({ queryKey: ['comms'] }) },
    onError: (e) => toast.error(errMessage(e)),
  })
  const waOn = q.data?.settings.whatsapp_enabled === true
  return (
    <div>
      <PageHeader title="Guest communications" description="What guests are sent and when. Messages are only sent through providers that are actually connected, and never twice for the same booking." />
      {q.isLoading && <Skeleton className="h-64" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && (
        <div className="grid gap-5">
          <Card><CardHeader><CardTitle>Channels</CardTitle></CardHeader><CardContent className="grid gap-2 text-sm">
            <p className="flex items-center justify-between rounded-lg border p-3"><span>WhatsApp</span>{waOn ? <Badge className="border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300">Switched on</Badge> : <Badge className="border-border bg-muted text-muted-foreground">Switched off in Settings</Badge>}</p>
            <p className="flex items-center justify-between rounded-lg border p-3"><span>SMS</span><Badge className="border-border bg-muted text-muted-foreground">Not connected: needs an SMS provider account</Badge></p>
            <p className="flex items-center justify-between rounded-lg border p-3"><span>Email</span><Badge className="border-border bg-muted text-muted-foreground">Not connected: needs an email provider account</Badge></p>
            <p className="flex items-center justify-between rounded-lg border p-3"><span>In-app notifications</span><Link to="/admin/notifications" className="text-brand hover:underline">Open notifications</Link></p>
            <p className="text-xs text-muted-foreground">Provider credentials are kept as secrets on the server and are never shown here. See Settings &gt; Payments &amp; WhatsApp for status. Every message sent, skipped or failed is listed under <Link to="/admin/messages" className="underline">Messages</Link>; failed reminders are retried automatically up to three times.</p>
          </CardContent></Card>
          <Card><CardHeader><CardTitle>Schedule</CardTitle></CardHeader><CardContent className="grid gap-4 sm:grid-cols-3">
            {SCHEDULE.map(([k, label, hint]) => (
              <Field key={k} label={label} htmlFor={`sc-${k}`} hint={hint}>
                <Input id={`sc-${k}`} inputMode="numeric" disabled={!owner} value={days[k] ?? String(q.data.settings[k] ?? (k === 'reminder_days_before' ? 1 : k === 'balance_reminder_days_before' ? 2 : 0))} onChange={(e) => setDays((s) => ({ ...s, [k]: e.target.value }))} />
              </Field>))}
            <p className="text-xs text-muted-foreground sm:col-span-3">Reminders go out once a day at 08:00 Nairobi time (Africa/Nairobi).</p>
            {owner && <div className="sm:col-span-3"><Button loading={saveDays.isPending} onClick={() => saveDays.mutate()}>Save schedule</Button></div>}
          </CardContent></Card>
          <div className="grid gap-4">
            {q.data.templates.map((t) => <TemplateCard key={t.key} t={t} owner={owner} />)}
          </div>
          <p className="text-xs text-muted-foreground">Placeholders you can use: {PLACEHOLDERS.map((p) => `{{${p}}}`).join('  ')}. Leave the wording empty to use the built-in text. Guests can be excluded from reminders on their guest profile.</p>
        </div>
      )}
    </div>
  )
}

function TemplateCard({ t, owner }: { t: Tpl; owner: boolean }) {
  const qc = useQueryClient()
  const [body, setBody] = useState(t.body ?? '')
  const save = useMutation({
    mutationFn: async (patch: Partial<Tpl>) => { const { error } = await sb().from('message_templates').update(patch).eq('key', t.key); if (error) throw error },
    onSuccess: () => { toast.success('Saved'); qc.invalidateQueries({ queryKey: ['comms'] }) },
    onError: (e) => toast.error(errMessage(e)),
  })
  const trimmed = body.trim()
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3"><CardTitle>{t.label}</CardTitle>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!owner} checked={t.enabled} onChange={(e) => save.mutate({ enabled: e.target.checked })} /> Send this message</label></CardHeader>
      <CardContent className="grid gap-3">
        <Textarea aria-label={`${t.label} wording`} rows={4} maxLength={1000} disabled={!owner} placeholder="Built-in wording is used. Write your own to replace it." value={body} onChange={(e) => setBody(e.target.value)} />
        {owner && <div className="flex gap-2">
          <Button variant="outline" disabled={trimmed === (t.body ?? '') || (trimmed.length > 0 && trimmed.length < 10)} loading={save.isPending} onClick={() => save.mutate({ body: trimmed || null })}>Save wording</Button>
          {t.body && <Button variant="ghost" onClick={() => { setBody(''); save.mutate({ body: null }) }}>Use built-in wording</Button>}
        </div>}
      </CardContent>
    </Card>
  )
}
