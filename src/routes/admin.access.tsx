import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { isOwner, requireRole } from '~/lib/auth'
import { errMessage } from '~/lib/utils'
import { formatDateTime } from '~/lib/dates'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Dialog, DialogContent, SheetContent } from '~/components/ui/dialog'
import { Field, Input, Select } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, Tabs, TableWrap, td, th } from '~/components/ui/misc'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/access')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: AccessPage,
})

type Device = { id: string; property_id: string; unit_id: string; label: string; provider: 'manual' | 'external'; external_id: string | null; status: string; last_seen_at: string | null; battery_pct: number | null; active: boolean }
type Cred = { id: string; booking_id: string; device_id: string; pin_hint: string; valid_from: string; valid_until: string; status: string; revoked_reason: string | null; created_at: string; booking: { reference: string } | null }
type Log = { id: number; action: string; detail: string | null; created_at: string; device_id: string | null }
const STATUS_TEXT: Record<string, [string, string]> = {
  pending: ['Waiting for the lock provider', 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'],
  provisioned: ['Confirmed on the lock', 'border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300'],
  manual: ['Code issued: set it on the lock yourself', 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'],
  failed: ['Lock provider refused it', 'border-danger/40 bg-danger/10 text-danger'],
  revoked: ['Revoked', 'border-border bg-muted text-muted-foreground'], expired: ['Expired', 'border-border bg-muted text-muted-foreground'],
}

function AccessPage() {
  const { me } = useAdmin()
  const owner = isOwner(me)
  const [tab, setTab] = useState<'codes' | 'devices' | 'log'>('codes')
  const [issuing, setIssuing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [shown, setShown] = useState<{ pin: string; message: string; reference: string } | null>(null)
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['access'], queryFn: async () => {
    const [d, c, l, u] = await Promise.all([
      sb().from('smart_lock_devices').select('*').order('label'),
      sb().from('access_credentials').select('id, booking_id, device_id, pin_hint, valid_from, valid_until, status, revoked_reason, created_at, booking:bookings(reference)').order('created_at', { ascending: false }).limit(200),
      sb().from('access_logs').select('id, action, detail, created_at, device_id').order('id', { ascending: false }).limit(200),
      sb().from('units').select('id, name, property_id'),
    ])
    if (d.error) throw d.error
    if (c.error) throw c.error
    return { devices: d.data as Device[], creds: c.data as unknown as Cred[], logs: (l.data ?? []) as Log[], units: new Map((u.data ?? []).map((x) => [x.id as string, x.name as string])) }
  } })
  const revoke = useMutation({
    mutationFn: async (v: { id: string; reason: string }) => { const { error } = await sb().rpc('revoke_access_credential', { p_credential: v.id, p_reason: v.reason }); if (error) throw error },
    onSuccess: () => { toast.success('Access revoked'); qc.invalidateQueries({ queryKey: ['access'] }) },
    onError: (e) => toast.error(errMessage(e)),
  })
  const dev = (id: string) => q.data?.devices.find((d) => d.id === id)
  return (
    <div>
      <PageHeader title="Smart access" description="Temporary door codes for guests. Codes are shown once and never stored in readable form."
        actions={<div className="flex gap-2">{owner && <Button variant="outline" onClick={() => setAdding(true)}><Plus className="h-4 w-4" aria-hidden /> Add lock</Button>}<Button onClick={() => setIssuing(true)} disabled={!q.data?.devices.length}><KeyRound className="h-4 w-4" aria-hidden /> Issue code</Button></div>} />
      <p role="note" className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        No lock provider is connected to this system yet. Locks added as “Manual” only record the code, so you must set it on the lock yourself; the system never claims a lock was programmed unless the lock provider confirmed it. Connecting a real smart-lock brand needs a compatible lock, the provider's API credentials and an adapter (see docs/SMART_ACCESS.md).
      </p>
      <div className="mb-4"><Tabs label="Smart access" value={tab} onChange={setTab} tabs={[{ value: 'codes', label: 'Access codes' }, { value: 'devices', label: 'Locks' }, { value: 'log', label: 'History' }]} /></div>
      {q.isLoading && <Skeleton className="h-48" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && tab === 'codes' && (q.data.creds.length === 0 ? <EmptyState icon={KeyRound} title="No access codes yet" description={q.data.devices.length ? 'Issue a code for a paid, confirmed stay.' : 'Add a lock first.'} /> : (
        <TableWrap>
          <thead><tr>{['Booking', 'Lock', 'Code', 'Valid', 'Status', ''].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">{q.data.creds.map((c) => {
            const [label, tone] = STATUS_TEXT[c.status] ?? [c.status, '']
            const live = ['pending', 'provisioned', 'manual'].includes(c.status)
            return (
              <tr key={c.id}>
                <td className={td}>{c.booking?.reference}</td><td className={td}>{dev(c.device_id)?.label}</td><td className={`${td} font-mono`}>••••{c.pin_hint}</td>
                <td className={`${td} whitespace-nowrap text-xs`}>{formatDateTime(c.valid_from)}<br />to {formatDateTime(c.valid_until)}</td>
                <td className={td}><Badge className={tone}>{label}</Badge>{c.revoked_reason && <p className="text-xs text-muted-foreground">{c.revoked_reason}</p>}</td>
                <td className={td}>{live && <Button size="sm" variant="outline" className="text-danger" onClick={() => { const r = prompt('Why is this access being revoked?'); if (r && r.trim().length >= 3) revoke.mutate({ id: c.id, reason: r }) }}>Revoke</Button>}</td>
              </tr>)
          })}</tbody>
        </TableWrap>))}
      {q.data && tab === 'devices' && (q.data.devices.length === 0 ? <EmptyState icon={KeyRound} title="No locks yet" description={owner ? 'Add a lock for a room.' : 'The owner adds locks.'} /> : (
        <TableWrap>
          <thead><tr>{['Lock', 'Room', 'Type', 'Status'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">{q.data.devices.map((d) => (
            <tr key={d.id}><td className={td}>{d.label}</td><td className={td}>{q.data.units.get(d.unit_id)}</td><td className={td}>{d.provider === 'manual' ? 'Manual (keypad or key box)' : 'Provider-connected'}</td>
              <td className={td}>{d.provider === 'manual' ? <span className="text-muted-foreground">Not monitored</span> : d.status === 'unconfigured' ? <Badge className="border-border bg-muted text-muted-foreground">Needs provider configuration</Badge> : <>{d.status}{d.battery_pct != null ? ` · battery ${d.battery_pct}%` : ''}{d.last_seen_at ? ` · seen ${formatDateTime(d.last_seen_at)}` : ''}</>}</td></tr>))}</tbody>
        </TableWrap>))}
      {q.data && tab === 'log' && (q.data.logs.length === 0 ? <EmptyState title="No activity yet" /> : (
        <TableWrap>
          <thead><tr>{['When', 'Action', 'Detail'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">{q.data.logs.map((l) => <tr key={l.id}><td className={`${td} whitespace-nowrap`}>{formatDateTime(l.created_at)}</td><td className={`${td} capitalize`}>{l.action.replace(/_/g, ' ')}</td><td className={td}>{l.detail}</td></tr>)}</tbody>
        </TableWrap>))}
      {adding && q.data && <AddLock properties={me.properties} onClose={() => setAdding(false)} />}
      {issuing && q.data && <Issue devices={q.data.devices} units={q.data.units} onClose={() => setIssuing(false)} onIssued={(r) => { setIssuing(false); setShown(r); qc.invalidateQueries({ queryKey: ['access'] }) }} />}
      {shown && (
        <Dialog open onOpenChange={(o) => !o && setShown(null)}>
          <DialogContent title={`Access code for ${shown.reference}`} description="This is the only time the code is shown. Copy it now.">
            <p className="my-3 text-center font-mono text-4xl tracking-[0.3em]" aria-live="polite">{shown.pin}</p>
            <p className="mb-4 rounded-md bg-muted p-3 text-sm">{shown.message}</p>
            <div className="flex gap-2"><Button onClick={() => navigator.clipboard.writeText(shown.pin).then(() => toast.success('Code copied'))}><Copy className="h-4 w-4" /> Copy code</Button><Button variant="ghost" onClick={() => setShown(null)}>Done</Button></div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

function AddLock({ properties, onClose }: { properties: { id: string; name: string }[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [prop, setProp] = useState(properties[0]?.id ?? '')
  const [unit, setUnit] = useState('')
  const [label, setLabel] = useState('')
  const [err, setErr] = useState('')
  const units = useQuery({ queryKey: ['units-of', prop], enabled: !!prop, queryFn: async () => (await sb().from('units').select('id, name').eq('property_id', prop).eq('active', true).order('sort').order('name')).data ?? [] })
  const save = useMutation({
    mutationFn: async () => {
      setErr('')
      if (!unit) throw new Error('Choose the room this lock belongs to.')
      if (label.trim().length < 2) throw new Error('Give the lock a name.')
      const { error } = await sb().from('smart_lock_devices').insert({ property_id: prop, unit_id: unit, label: label.trim(), provider: 'manual' })
      if (error) throw error
    },
    onSuccess: () => { toast.success('Lock added'); qc.invalidateQueries({ queryKey: ['access'] }); onClose() }, onError: (e) => setErr(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title="Add a lock" description="A manual lock is a keypad or key box you set yourself.">
        <div className="grid gap-4">
          <Field label="Property" htmlFor="lk-prop"><Select id="lk-prop" value={prop} onChange={(e) => { setProp(e.target.value); setUnit('') }}>{properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <Field label="Room" htmlFor="lk-unit"><Select id="lk-unit" value={unit} onChange={(e) => setUnit(e.target.value)}><option value="">Choose a room</option>{units.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
          <Field label="Name" htmlFor="lk-label"><Input id="lk-label" maxLength={60} placeholder="e.g. Front door keypad" value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <Button loading={save.isPending} onClick={() => save.mutate()}>Add lock</Button>
        </div>
      </SheetContent>
    </Dialog>
  )
}

function Issue({ devices, units, onClose, onIssued }: { devices: Device[]; units: Map<string, string>; onClose: () => void; onIssued: (r: { pin: string; message: string; reference: string }) => void }) {
  const [ref, setRef] = useState('')
  const [device, setDevice] = useState(devices.filter((d) => d.active)[0]?.id ?? '')
  const [err, setErr] = useState('')
  const run = useMutation({
    mutationFn: async () => {
      setErr('')
      const { data: b } = await sb().from('bookings').select('id, reference').ilike('reference', ref.trim()).maybeSingle()
      if (!b) throw new Error('No booking with that reference.')
      const { data, error } = await sb().rpc('issue_access_credential', { p_booking: b.id, p_device: device })
      if (error) throw error
      const r = (data as { pin: string; message: string }[])[0]
      return { pin: r.pin, message: r.message, reference: b.reference as string }
    },
    onSuccess: onIssued, onError: (e) => setErr(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Issue an access code" description="For a confirmed stay whose deposit is paid. The code works from check-in day 12:00 to check-out day 12:00.">
        <div className="grid gap-4">
          <Field label="Booking reference" htmlFor="ac-ref"><Input id="ac-ref" placeholder="BNB-2611-0001" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
          <Field label="Lock" htmlFor="ac-dev"><Select id="ac-dev" value={device} onChange={(e) => setDevice(e.target.value)}>{devices.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.label} ({units.get(d.unit_id)})</option>)}</Select></Field>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <Button loading={run.isPending} disabled={!ref.trim() || !device} onClick={() => run.mutate()}>Generate code</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
