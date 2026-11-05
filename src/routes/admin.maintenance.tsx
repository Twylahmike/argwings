import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { isOwner } from '~/lib/auth'
import { errMessage } from '~/lib/utils'
import { formatDate, formatDateTime, todayNairobi } from '~/lib/dates'
import { cap } from '~/lib/tickets'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { Field, Input, Select, Textarea } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, Tabs, TableWrap, td, th } from '~/components/ui/misc'
import { useAdmin } from '~/components/layout/AdminShell'

// Open to every staff member: housekeeping reports issues, managers assign and close them. The database decides who can see what.
export const Route = createFileRoute('/admin/maintenance')({ component: MaintenancePage })

type Req = {
  id: string; property_id: string; unit_id: string | null; title: string; description: string; priority: 'low' | 'normal' | 'high' | 'urgent'
  status: 'open' | 'assigned' | 'in_progress' | 'completed' | 'cancelled'; assigned_to: string | null; reported_by: string | null
  start_date: string | null; expected_completion: string | null; completed_at: string | null; completion_notes: string | null; takes_unit_offline: boolean; created_at: string
}
const STATUSES = [['open', 'Open'], ['assigned', 'Assigned'], ['in_progress', 'In progress'], ['completed', 'Completed'], ['cancelled', 'Cancelled']] as const
const PRI_TONE: Record<string, string> = { low: 'border-border bg-muted text-muted-foreground', normal: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300', high: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300', urgent: 'border-danger/50 bg-danger/10 text-danger' }

function MaintenancePage() {
  const { me } = useAdmin()
  const canManage = isOwner(me) || me.roles.includes('manager')
  const [tab, setTab] = useState<'active' | 'completed' | 'all'>('active')
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const q = useQuery({
    queryKey: ['maintenance'],
    queryFn: async () => {
      const [r, p, u, s] = await Promise.all([
        sb().from('maintenance_requests').select('*').order('created_at', { ascending: false }).limit(1000),
        sb().from('properties').select('id, name'),
        sb().from('units').select('id, name'),
        canManage ? sb().from('profiles').select('id, full_name').eq('active', true) : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
      ])
      if (r.error) throw r.error
      return { rows: r.data as Req[], props: new Map((p.data ?? []).map((x) => [x.id as string, x.name as string])), units: new Map((u.data ?? []).map((x) => [x.id as string, x.name as string])), staff: (s.data ?? []) as { id: string; full_name: string }[] }
    },
  })
  const rows = useMemo(() => (q.data?.rows ?? []).filter((r) => tab === 'all' || (tab === 'active' ? !['completed', 'cancelled'].includes(r.status) : r.status === 'completed')), [q.data, tab])
  const open = q.data?.rows.find((r) => r.id === openId)
  const today = todayNairobi()
  return (
    <div>
      <PageHeader title="Maintenance" description="Report faults, assign them, and keep a record of every repair. A request can take a room out of service until it is fixed."
        actions={<Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Report an issue</Button>} />
      <div className="mb-4"><Tabs label="Status" value={tab} onChange={setTab} tabs={[{ value: 'active', label: 'Active' }, { value: 'completed', label: 'Completed' }, { value: 'all', label: 'All' }]} /></div>
      {q.isLoading && <Skeleton className="h-48" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && rows.length === 0 && <EmptyState icon={Wrench} title="No maintenance requests" description="Report an issue when something needs fixing." />}
      {rows.length > 0 && (
        <TableWrap>
          <thead><tr>{['Issue', 'Where', 'Priority', 'Status', 'Due', 'Reported'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">{rows.map((r) => (
            <tr key={r.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setOpenId(r.id)}>
              <td className={td}><button className="text-left font-medium text-brand hover:underline" onClick={() => setOpenId(r.id)}>{r.title}</button>{r.takes_unit_offline && !['completed', 'cancelled'].includes(r.status) && <p className="text-xs text-danger">Room out of service</p>}</td>
              <td className={td}>{q.data!.props.get(r.property_id)}{r.unit_id ? ` · ${q.data!.units.get(r.unit_id) ?? ''}` : ''}</td>
              <td className={td}><Badge className={PRI_TONE[r.priority]}>{cap(r.priority)}</Badge></td>
              <td className={td}>{STATUSES.find(([v]) => v === r.status)?.[1]}</td>
              <td className={`${td} whitespace-nowrap ${r.expected_completion && r.expected_completion < today && !['completed', 'cancelled'].includes(r.status) ? 'font-medium text-danger' : ''}`}>{r.expected_completion ? formatDate(r.expected_completion) : '—'}</td>
              <td className={`${td} whitespace-nowrap`}>{formatDateTime(r.created_at)}</td>
            </tr>))}</tbody>
        </TableWrap>
      )}
      {open && q.data && <Detail req={open} staff={q.data.staff} canManage={canManage} meId={me.id} onClose={() => setOpenId(null)} />}
      {creating && q.data && <Create canManage={canManage} meId={me.id} props={me.properties} onClose={() => setCreating(false)} />}
    </div>
  )
}

function Create({ canManage, meId, props, onClose }: { canManage: boolean; meId: string; props: { id: string; name: string }[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [v, setV] = useState({ property_id: props[0]?.id ?? '', unit_id: '', title: '', description: '', priority: 'normal', offline: false, expected: '' })
  const [err, setErr] = useState('')
  const units = useQuery({ queryKey: ['units-of', v.property_id], enabled: !!v.property_id, queryFn: async () => (await sb().from('units').select('id, name').eq('property_id', v.property_id).eq('active', true).order('sort').order('name')).data ?? [] })
  const save = useMutation({
    mutationFn: async () => {
      setErr('')
      if (v.title.trim().length < 3) throw new Error('Describe the issue in a few words.')
      const { error } = await sb().from('maintenance_requests').insert({
        property_id: v.property_id, unit_id: v.unit_id || null, title: v.title.trim(), description: v.description.trim(), priority: v.priority,
        reported_by: meId, takes_unit_offline: canManage && !!v.unit_id && v.offline, expected_completion: v.expected || null,
      })
      if (error) throw error
    },
    onSuccess: () => { toast.success('Issue reported'); qc.invalidateQueries({ queryKey: ['maintenance'] }); onClose() },
    onError: (e) => setErr(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title="Report an issue" description="Say what is wrong and where.">
        <div className="grid gap-4">
          <Field label="Property" htmlFor="mr-prop"><Select id="mr-prop" value={v.property_id} onChange={(e) => setV({ ...v, property_id: e.target.value, unit_id: '' })}>{props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <Field label="Room" htmlFor="mr-unit"><Select id="mr-unit" value={v.unit_id} onChange={(e) => setV({ ...v, unit_id: e.target.value })}><option value="">Not in a specific room</option>{units.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
          <Field label="Issue" htmlFor="mr-title"><Input id="mr-title" maxLength={120} value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
          <Field label="Details" htmlFor="mr-desc"><Textarea id="mr-desc" rows={3} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Priority" htmlFor="mr-pri"><Select id="mr-pri" value={v.priority} onChange={(e) => setV({ ...v, priority: e.target.value })}>{['low', 'normal', 'high', 'urgent'].map((p) => <option key={p} value={p}>{cap(p)}</option>)}</Select></Field>
            <Field label="Expected fix date" htmlFor="mr-exp"><Input id="mr-exp" type="date" value={v.expected} onChange={(e) => setV({ ...v, expected: e.target.value })} /></Field>
          </div>
          {canManage && <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!v.unit_id} checked={v.offline} onChange={(e) => setV({ ...v, offline: e.target.checked })} /> Take this room out of service until it is fixed</label>}
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <Button loading={save.isPending} onClick={() => save.mutate()}>Report issue</Button>
        </div>
      </SheetContent>
    </Dialog>
  )
}

function Detail({ req: r, staff, canManage, meId, onClose }: { req: Req; staff: { id: string; full_name: string }[]; canManage: boolean; meId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [notes, setNotes] = useState(r.completion_notes ?? '')
  const canEdit = canManage || r.assigned_to === meId
  const update = useMutation({
    mutationFn: async (patch: Partial<Req>) => { const { error } = await sb().from('maintenance_requests').update(patch).eq('id', r.id); if (error) throw error },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['maintenance'] }); toast.success('Saved') },
    onError: (e) => toast.error(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={r.title} description={`Reported ${formatDateTime(r.created_at)}${r.completed_at ? ` · completed ${formatDateTime(r.completed_at)}` : ''}`}>
        <div className="grid gap-4 text-sm">
          {r.description && <p className="whitespace-pre-line rounded-md bg-muted p-3">{r.description}</p>}
          {canEdit ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Status" htmlFor="md-status"><Select id="md-status" value={r.status} onChange={(e) => { const s = e.target.value as Req['status']; if (s === 'completed') { if (notes.trim().length < 3) return toast.error('Add completion notes first.'); update.mutate({ status: s, completion_notes: notes.trim() }) } else update.mutate({ status: s }) }}>
                  {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
                {canManage && <Field label="Assigned to" htmlFor="md-assign"><Select id="md-assign" value={r.assigned_to ?? ''} onChange={(e) => update.mutate({ assigned_to: e.target.value || null, ...(e.target.value && r.status === 'open' ? { status: 'assigned' as const } : {}) })}><option value="">Unassigned</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}</Select></Field>}
                {canManage && <Field label="Priority" htmlFor="md-pri"><Select id="md-pri" value={r.priority} onChange={(e) => update.mutate({ priority: e.target.value as Req['priority'] })}>{['low', 'normal', 'high', 'urgent'].map((p) => <option key={p} value={p}>{cap(p)}</option>)}</Select></Field>}
                {canManage && <Field label="Expected completion" htmlFor="md-exp"><Input id="md-exp" type="date" value={r.expected_completion ?? ''} onChange={(e) => update.mutate({ expected_completion: e.target.value || null })} /></Field>}
              </div>
              {canManage && r.unit_id && <label className="flex items-center gap-2"><input type="checkbox" checked={r.takes_unit_offline} onChange={(e) => update.mutate({ takes_unit_offline: e.target.checked })} /> Room is out of service while this is open</label>}
              <Field label="Completion notes" htmlFor="md-notes" hint="Required to mark the request completed."><Textarea id="md-notes" rows={3} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== (r.completion_notes ?? '') && update.mutate({ completion_notes: notes.trim() || null })} /></Field>
            </>
          ) : <p className="text-muted-foreground">Status: {STATUSES.find(([v]) => v === r.status)?.[1]}. A manager will follow this up.</p>}
        </div>
      </SheetContent>
    </Dialog>
  )
}
