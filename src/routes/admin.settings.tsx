import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Download, ImagePlus } from 'lucide-react'
import { callFunction, sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { uploadImage } from '~/lib/images'
import { normalizePhone } from '~/lib/phone'
import { HEX_RE, readableOn } from '~/lib/color'
import { formatDateTime } from '~/lib/dates'
import { toCsv, downloadCsv } from '~/lib/csv'
import { errMessage } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Field, Input, Textarea } from '~/components/ui/form'
import { ErrorState, PageHeader, Skeleton, Tabs, TableWrap, td, th } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/settings')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner']),
  component: SettingsPage,
})

type Vals = Record<string, string>
const KEYS = ['business_name', 'brand_color', 'logo_url', 'support_whatsapp', 'owner_notify_phone', 'mpesa_paybill_display', 'mpesa_manual_instructions', 'deposit_percent', 'hold_minutes',
  'default_check_in_time', 'default_check_out_time', 'cancellation_policy', 'reminder_days_before', 'balance_reminder_days_before'] as const

function SettingsPage() {
  const [tab, setTab] = useState<'business' | 'system' | 'audit' | 'export'>('business')
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="mb-5"><Tabs label="Settings sections" value={tab} onChange={setTab} tabs={[{ value: 'business', label: 'Business' }, { value: 'system', label: 'Payments & WhatsApp' }, { value: 'audit', label: 'Audit log' }, { value: 'export', label: 'Data export' }]} /></div>
      {tab === 'business' && <Business />}
      {tab === 'system' && <System />}
      {tab === 'audit' && <Audit />}
      {tab === 'export' && <Export />}
    </div>
  )
}

function Business() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const { data, error } = await sb().from('settings').select('key, value')
      if (error) throw error
      return Object.fromEntries((data ?? []).map((r) => [r.key, typeof r.value === 'string' ? r.value : JSON.stringify(r.value)])) as Vals
    },
  })
  const [v, setV] = useState<Vals>({})
  useEffect(() => { if (q.data) setV(q.data) }, [q.data])
  const [busyLogo, setBusyLogo] = useState(false)
  const [errors, setErrors] = useState<Vals>({})
  const set = (k: string) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }))

  const save = useMutation({
    mutationFn: async () => {
      const errs: Vals = {}
      const rows: { key: string; value: unknown; updated_at: string }[] = []
      for (const k of KEYS) {
        let raw = (v[k] ?? '').trim()
        let val: unknown = raw
        if (k === 'support_whatsapp' || k === 'owner_notify_phone') {
          if (raw) { const p = normalizePhone(raw); if (!p.ok) errs[k] = p.error; else raw = p.phone }
          val = raw
        } else if (['deposit_percent', 'hold_minutes', 'reminder_days_before', 'balance_reminder_days_before'].includes(k)) {
          const n = Number(raw)
          const [lo, hi] = k === 'deposit_percent' ? [0, 100] : k === 'hold_minutes' ? [1, 1440] : [0, 30]
          if (!Number.isFinite(n) || raw === '' || n < lo || n > hi || !Number.isInteger(n)) errs[k] = `Enter a whole number from ${lo} to ${hi}.`
          val = n
        } else if (k === 'business_name' && !raw) errs[k] = 'Enter your business name.'
        else if (k === 'brand_color' && raw && !HEX_RE.test(raw)) errs[k] = 'Use a colour like #0f766e.'
        rows.push({ key: k, value: val, updated_at: new Date().toISOString() })
      }
      setErrors(errs)
      if (Object.keys(errs).length) throw new Error('Please fix the highlighted fields.')
      const { error } = await sb().from('settings').upsert(rows)
      if (error) throw error
    },
    onSuccess: () => { toast.success('Settings saved'); qc.invalidateQueries({ queryKey: ['settings'] }); setTimeout(() => window.location.reload(), 600) },
    onError: (e) => toast.error(errMessage(e)),
  })

  async function logo(file?: File) {
    if (!file) return
    setBusyLogo(true)
    try { const url = await uploadImage(file, 'branding'); setV((s) => ({ ...s, logo_url: url })); toast.success('Logo uploaded. Press Save to apply it.') } catch (e) { toast.error(errMessage(e)) } finally { setBusyLogo(false) }
  }
  if (q.isLoading) return <Skeleton className="h-96" />
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const f = (k: string, label: string, props: { hint?: string; type?: string; inputMode?: 'numeric' | 'tel' } = {}) => (
    <Field label={label} htmlFor={`s-${k}`} hint={props.hint} error={errors[k]}><Input id={`s-${k}`} type={props.type} inputMode={props.inputMode} value={v[k] ?? ''} onChange={set(k)} aria-invalid={!!errors[k]} /></Field>
  )
  return (
    <div className="grid max-w-3xl gap-5">
      <Card><CardHeader><CardTitle>Brand</CardTitle></CardHeader><CardContent className="grid gap-4">
        {f('business_name', 'Business name')}
        <div className="flex items-center gap-4">
          {v.logo_url ? <img src={v.logo_url} alt="Current logo" className="h-12 w-auto rounded border bg-white p-1" /> : <span className="text-sm text-muted-foreground">No logo yet (a text wordmark is shown).</span>}
          <label className="inline-flex"><input type="file" accept="image/*" hidden onChange={(e) => logo(e.target.files?.[0])} /><span role="button" tabIndex={0} className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-md border bg-card px-4 text-sm font-medium hover:bg-muted"><ImagePlus className="h-4 w-4" /> {busyLogo ? 'Uploading…' : 'Upload logo'}</span></label>
          {v.logo_url && <Button variant="ghost" size="sm" onClick={() => setV((s) => ({ ...s, logo_url: '' }))}>Remove</Button>}
        </div>
        <Field label="Brand colour" htmlFor="s-brand_color" error={errors.brand_color} hint="Buttons, links and highlights across the site and admin. The text colour adjusts automatically.">
          <div className="flex items-center gap-3">
            <input aria-label="Pick a colour" type="color" className="h-11 w-14 cursor-pointer rounded-md border bg-card p-1" value={HEX_RE.test(v.brand_color ?? '') ? v.brand_color : '#0f766e'} onChange={set('brand_color')} />
            <Input id="s-brand_color" className="w-32 font-mono" value={v.brand_color ?? ''} onChange={set('brand_color')} placeholder="#0f766e" aria-invalid={!!errors.brand_color} />
            {HEX_RE.test(v.brand_color ?? '') && <span className="inline-flex h-11 items-center rounded-md px-4 text-sm font-medium" style={{ background: v.brand_color, color: readableOn(v.brand_color) }}>Preview</span>}
          </div>
        </Field>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Contact</CardTitle></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2">
        {f('support_whatsapp', 'Support WhatsApp', { inputMode: 'tel', hint: 'Shown to guests. Also the fallback for "Book on WhatsApp".' })}
        {f('owner_notify_phone', 'Owner alert number', { inputMode: 'tel', hint: 'Gets WhatsApp alerts when a payment needs review.' })}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Booking rules</CardTitle></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2">
        {f('deposit_percent', 'Deposit (%)', { inputMode: 'numeric', hint: 'Rounded up to the next KES 10.' })}
        {f('hold_minutes', 'Hold time (minutes)', { inputMode: 'numeric', hint: 'How long dates are held while a guest pays.' })}
        {f('default_check_in_time', 'Default check-in time', { type: 'time' })}{f('default_check_out_time', 'Default check-out time', { type: 'time' })}
        {f('reminder_days_before', 'Check-in reminder (days before)', { inputMode: 'numeric' })}{f('balance_reminder_days_before', 'Balance reminder (days before)', { inputMode: 'numeric' })}
        <Field label="Cancellation policy" htmlFor="s-cancel" className="sm:col-span-2"><Textarea id="s-cancel" rows={3} value={v.cancellation_policy ?? ''} onChange={set('cancellation_policy')} /></Field>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Manual M-Pesa payment details</CardTitle></CardHeader><CardContent className="grid gap-4">
        {f('mpesa_paybill_display', 'Paybill / Till number shown to guests', { hint: 'Only for guests who pay manually. STK push uses the server settings.' })}
        <Field label="Instructions" htmlFor="s-instr"><Textarea id="s-instr" rows={2} value={v.mpesa_manual_instructions ?? ''} onChange={set('mpesa_manual_instructions')} /></Field>
      </CardContent></Card>
      <div><Button size="lg" loading={save.isPending} onClick={() => save.mutate()}>Save settings</Button></div>
    </div>
  )
}

function System() {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['system-status'], queryFn: () => callFunction<{ mpesa_env: string; mpesa_callback_secret_set: boolean; whatsapp_env_enabled: boolean; whatsapp_configured: boolean; whatsapp_templates: boolean; site_url: string }>('system-status', {}) , retry: 0 })
  const wa = useQuery({ queryKey: ['wa-setting'], queryFn: async () => (await sb().from('settings').select('value').eq('key', 'whatsapp_enabled').maybeSingle()).data?.value === true })
  const toggle = useMutation({
    mutationFn: async (on: boolean) => { const { error } = await sb().from('settings').upsert({ key: 'whatsapp_enabled', value: on, updated_at: new Date().toISOString() }); if (error) throw error },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['wa-setting'] }); toast.success('Saved') },
    onError: (e) => toast.error(errMessage(e)),
  })
  const s = status.data
  const modeTone = s?.mpesa_env === 'production' ? 'text-emerald-700 border-emerald-600/40' : 'text-amber-700 border-amber-500/50'
  return (
    <div className="grid max-w-3xl gap-5">
      <Card><CardHeader><CardTitle>M-Pesa mode</CardTitle></CardHeader><CardContent className="grid gap-2 text-sm">
        {status.isLoading && <Skeleton className="h-10" />}
        {status.error && <p className="text-muted-foreground">Could not read the server status. Is the <code>system-status</code> function deployed?</p>}
        {s && <>
          <p>Current mode: <Badge className={modeTone}>{s.mpesa_env}</Badge></p>
          {s.mpesa_env === 'mock' && <p className="text-amber-700 dark:text-amber-400">Mock mode: payments are simulated and no real money moves. Switch to <b>production</b> only after Safaricom Go-Live (see DEPLOY.md).</p>}
          <p className="text-muted-foreground">Set with the <code>MPESA_ENV</code> secret. It cannot be changed from this screen on purpose.</p>
          <p>Callback secret configured: <b>{s.mpesa_callback_secret_set ? 'yes' : 'NO: set MPESA_CALLBACK_SECRET'}</b></p>
        </>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>WhatsApp messages</CardTitle></CardHeader><CardContent className="grid gap-3 text-sm">
        <label className="flex h-11 items-center gap-3"><input type="checkbox" className="h-5 w-5" checked={!!wa.data} disabled={wa.isLoading || toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} /> Send automatic WhatsApp messages</label>
        {s && <p className="text-muted-foreground">Server credentials: {s.whatsapp_configured ? <b className="text-emerald-700">configured</b> : <b className="text-amber-700">not configured on the server (see the WhatsApp section of DEPLOY.md)</b>}{s.whatsapp_templates ? ' · using approved templates' : ' · using session messages'}.</p>}
        <p className="text-muted-foreground">When sending is off or fails, nothing breaks: open the booking or the Messages page and tap "Send via WhatsApp" to send the same text yourself.</p>
      </CardContent></Card>
    </div>
  )
}

type AuditRow = { id: number; user_id: string | null; action: string; entity: string; entity_id: string | null; diff: unknown; created_at: string }
function Audit() {
  const [entity, setEntity] = useState('')
  const q = useQuery({
    queryKey: ['audit', entity],
    queryFn: async () => {
      let query = sb().from('audit_log').select('*').order('created_at', { ascending: false }).limit(200)
      if (entity) query = query.eq('entity', entity)
      const [a, p] = await Promise.all([query, sb().from('profiles').select('id, full_name')])
      if (a.error) throw a.error
      return { rows: a.data as AuditRow[], names: new Map((p.data ?? []).map((x) => [x.id as string, x.full_name as string])) }
    },
  })
  return (
    <div>
      <div className="mb-3 max-w-xs"><select aria-label="Filter by type" className="h-11 w-full rounded-md border bg-card px-3 text-sm" value={entity} onChange={(e) => setEntity(e.target.value)}><option value="">Everything</option>{['booking', 'payment', 'unit', 'rate_override', 'expense', 'user_role', 'staff_property', 'setting', 'staff', 'guest'].map((x) => <option key={x}>{x}</option>)}</select></div>
      {q.isLoading && <Skeleton className="h-48" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && <TableWrap>
        <thead><tr>{['When', 'Who', 'What', 'Details'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
        <tbody className="divide-y">{q.data.rows.map((r) => (
          <tr key={r.id} className="align-top"><td className={`${td} whitespace-nowrap`}>{formatDateTime(r.created_at)}</td><td className={td}>{r.user_id ? q.data.names.get(r.user_id) ?? 'Unknown' : 'System'}</td>
            <td className={td}>{r.action}</td><td className={`${td} max-w-md`}><code className="line-clamp-2 break-all text-xs text-muted-foreground">{r.diff ? JSON.stringify(r.diff) : r.entity_id}</code></td></tr>))}</tbody>
      </TableWrap>}
    </div>
  )
}

function Export() {
  const [busy, setBusy] = useState('')
  async function dump(table: string) {
    setBusy(table)
    try {
      const rows: Record<string, unknown>[] = []
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb().from(table).select('*').range(from, from + 999)
        if (error) throw error
        rows.push(...(data as Record<string, unknown>[]))
        if (data.length < 1000) break
      }
      const cols = rows.length ? Object.keys(rows[0]) : []
      downloadCsv(`${table}.csv`, toCsv(rows, cols.map((c) => ({ header: c, value: (r: Record<string, unknown>) => { const x = r[c]; return x == null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x) } }))))
    } catch (e) { toast.error(errMessage(e)) } finally { setBusy('') }
  }
  return (
    <Card className="max-w-3xl"><CardHeader><CardTitle>Download your data</CardTitle><p className="text-sm text-muted-foreground">CSV files you can open in Excel. Keep them somewhere safe: they contain guest details. For a full backup see DEPLOY.md.</p></CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {['bookings', 'payments', 'guests', 'expenses', 'properties', 'units', 'message_log'].map((t) => <Button key={t} variant="outline" loading={busy === t} onClick={() => dump(t)}><Download className="h-4 w-4" /> {t.replace('_', ' ')}</Button>)}
      </CardContent>
    </Card>
  )
}
