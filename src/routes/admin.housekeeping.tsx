import { useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Brush, Camera, CheckCircle2, Plus, Printer, Wrench } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { sb } from '~/lib/supabase'
import { canManage } from '~/lib/auth'
import type { HousekeepingTask, TaskStatus } from '~/lib/types'
import { formatDate, todayNairobi } from '~/lib/dates'
import { errMessage } from '~/lib/utils'
import { uploadImage } from '~/lib/images'
import { Button } from '~/components/ui/button'
import { TaskBadge } from '~/components/ui/badge'
import { Field, Input, Select } from '~/components/ui/form'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { EmptyState, ErrorState, PageHeader, Skeleton, Tabs } from '~/components/ui/misc'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/housekeeping')({ component: HousekeepingPage })

type TaskRow = HousekeepingTask & { unit: { name: string; code: string | null }; property: { id: string; name: string } }
const ORDER: TaskStatus[] = ['dirty', 'in_progress', 'clean', 'inspected']

function HousekeepingPage() {
  const { me, scopeIds } = useAdmin()
  const manager = canManage(me)
  const qc = useQueryClient()
  const [show, setShow] = useState<'open' | 'done'>('open')
  const [creating, setCreating] = useState(false)
  const today = todayNairobi()

  const tasks = useQuery({
    queryKey: ['hk', scopeIds, show],
    queryFn: async () => {
      let q = sb().from('housekeeping_tasks').select('*, unit:units(name, code), property:properties(id, name)').in('property_id', scopeIds).order('priority', { ascending: false }).order('created_at')
      q = show === 'open' ? q.in('status', ['dirty', 'in_progress']) : q.in('status', ['clean', 'inspected']).gte('created_at', new Date(Date.now() - 7 * 864e5).toISOString())
      const { data, error } = await q.limit(500)
      if (error) throw error
      return data as unknown as TaskRow[]
    },
  })
  const photos = useQuery({
    queryKey: ['hk-photos', tasks.data?.map((t) => t.id).join(',')], enabled: !!tasks.data?.length,
    queryFn: async () => {
      const { data } = await sb().from('housekeeping_task_photos').select('id, task_id, url, caption').in('task_id', (tasks.data ?? []).map((t) => t.id)).order('created_at')
      const m = new Map<string, { id: string; url: string; caption: string | null }[]>()
      for (const x of (data ?? []) as { id: string; task_id: string; url: string; caption: string | null }[]) m.set(x.task_id, [...(m.get(x.task_id) ?? []), x])
      return m
    },
  })
  const addPhoto = useMutation({
    mutationFn: async (v: { taskId: string; file: File }) => {
      const url = await uploadImage(v.file, 'housekeeping')
      const { error } = await sb().from('housekeeping_task_photos').insert({ task_id: v.taskId, url, created_by: me.id })
      if (error) throw error
    },
    onSuccess: () => { toast.success('Photo added'); qc.invalidateQueries({ queryKey: ['hk-photos'] }) },
    onError: (e) => toast.error(errMessage(e)),
  })
  const cleaners = useQuery({
    queryKey: ['cleaners'], enabled: manager,
    queryFn: async () => {
      const [r, p, sp] = await Promise.all([sb().from('user_roles').select('user_id').eq('role', 'cleaner'), sb().from('profiles').select('id, full_name, active'), sb().from('staff_properties').select('user_id, property_id')])
      const ids = new Set((r.data ?? []).map((x) => x.user_id))
      return (p.data ?? []).filter((x) => ids.has(x.id) && x.active).map((x) => ({ ...x, props: (sp.data ?? []).filter((s) => s.user_id === x.id).map((s) => s.property_id as string) }))
    },
  })
  useEffect(() => {
    const ch = sb().channel('hk').on('postgres_changes', { event: '*', schema: 'public', table: 'housekeeping_tasks' }, () => qc.invalidateQueries({ queryKey: ['hk'] })).subscribe()
    return () => { sb().removeChannel(ch) }
  }, [qc])

  const update = useMutation({
    mutationFn: async (v: { id: string; patch: Partial<Pick<HousekeepingTask, 'status' | 'notes' | 'assigned_to'>> }) => {
      const { error } = await sb().from('housekeeping_tasks').update(v.patch).eq('id', v.id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hk'] }),
    onError: (e) => toast.error(errMessage(e)),
  })

  const byProperty = useMemo(() => {
    const m = new Map<string, { name: string; rows: TaskRow[] }>()
    for (const t of tasks.data ?? []) { const e = m.get(t.property.id) ?? { name: t.property.name, rows: [] }; e.rows.push(t); m.set(t.property.id, e) }
    return [...m.entries()]
  }, [tasks.data])

  return (
    <div>
      <PageHeader title="Housekeeping" description={`Today is ${formatDate(todayNairobi())}. Tap a button to move a unit along.`}
        actions={<>{manager && <Button className="no-print" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New task</Button>}<Tabs label="Show" value={show} onChange={setShow} tabs={[{ value: 'open', label: 'To do' }, { value: 'done', label: 'Done (7 days)' }]} />
          <Button variant="outline" className="no-print" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print checklist</Button></>} />
      {tasks.isLoading && <Skeleton className="h-64" />}
      {tasks.error && <ErrorState error={tasks.error} retry={() => tasks.refetch()} />}
      {tasks.data && byProperty.length === 0 && <EmptyState icon={show === 'open' ? CheckCircle2 : Brush} title={show === 'open' ? 'All clean!' : 'Nothing finished recently'} description={show === 'open' ? 'Units appear here automatically when a guest checks out.' : undefined} />}
      {creating && <NewTask onClose={() => setCreating(false)} onDone={() => { setCreating(false); qc.invalidateQueries({ queryKey: ['hk'] }) }} />}
      <div className="grid gap-6">
        {byProperty.map(([pid, { name, rows }]) => (
          <section key={pid} aria-labelledby={`hk-${pid}`} className="break-inside-avoid">
            <h2 id={`hk-${pid}`} className="mb-2 text-lg font-semibold">{name} <span className="text-sm font-normal text-muted-foreground">({rows.length})</span></h2>
            <ul className="grid gap-3 md:grid-cols-2">
              {rows.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || Number(b.priority) - Number(a.priority)).map((t) => (
                <li key={t.id} className={`rounded-xl border bg-card p-4 ${t.priority ? 'border-danger/60' : ''}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div><p className="text-lg font-semibold">{t.unit.name}</p>{t.priority && <p className="text-xs font-semibold uppercase text-danger">Same-day turnover: guest arriving today</p>}
                      <p className={`text-xs ${t.due_date < today && ['dirty', 'in_progress'].includes(t.status) ? 'font-semibold text-danger' : 'text-muted-foreground'}`}>{t.due_date < today && ['dirty', 'in_progress'].includes(t.status) ? `Overdue: was due ${formatDate(t.due_date)}` : `Due ${formatDate(t.due_date)}`}</p></div>
                    <TaskBadge status={t.status} />
                  </div>
                  <p className="mt-1 hidden text-sm print:block">☐ Beds ☐ Bathroom ☐ Kitchen ☐ Floors ☐ Restock ☐ Check for damage</p>
                  <div className="no-print mt-3 flex flex-wrap items-center gap-2">
                    {photos.data?.get(t.id)?.map((p) => <a key={p.id} href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt={p.caption ?? 'Task photo'} loading="lazy" className="h-12 w-12 rounded-md border object-cover" /></a>)}
                    <label className="inline-flex"><input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) addPhoto.mutate({ taskId: t.id, file: f }); e.target.value = '' }} />
                      <span role="button" tabIndex={0} className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-md border bg-card px-3 text-sm hover:bg-muted"><Camera className="h-4 w-4" /> {addPhoto.isPending && addPhoto.variables?.taskId === t.id ? 'Uploading…' : 'Add photo'}</span></label>
                    <Button asChild variant="ghost" size="sm"><Link to="/admin/maintenance"><Wrench className="h-4 w-4" /> Report an issue</Link></Button>
                  </div>
                  <NoteField value={t.notes ?? ''} onSave={(notes) => update.mutate({ id: t.id, patch: { notes } })} />
                  {manager && (
                    <div className="no-print mt-3">
                      <Select aria-label="Assign cleaner" value={t.assigned_to ?? ''} onChange={(e) => update.mutate({ id: t.id, patch: { assigned_to: e.target.value || null } })}>
                        <option value="">Unassigned</option>
                        {cleaners.data?.filter((c) => c.props.includes(t.property.id)).map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
                      </Select>
                    </div>
                  )}
                  <div className="no-print mt-3 flex flex-wrap gap-2">
                    {t.status === 'dirty' && <Button size="lg" className="flex-1" loading={update.isPending && update.variables?.id === t.id} onClick={() => update.mutate({ id: t.id, patch: { status: 'in_progress', ...(t.assigned_to ? {} : { assigned_to: me.id }) } })}>Start cleaning</Button>}
                    {t.status === 'in_progress' && <Button size="lg" className="flex-1" loading={update.isPending && update.variables?.id === t.id} onClick={() => update.mutate({ id: t.id, patch: { status: 'clean' } })}>Mark clean</Button>}
                    {t.status === 'clean' && manager && <Button size="lg" className="flex-1" onClick={() => update.mutate({ id: t.id, patch: { status: 'inspected' } })}>Mark inspected</Button>}
                    {(t.status === 'clean' || t.status === 'in_progress') && <Button variant="outline" size="lg" onClick={() => update.mutate({ id: t.id, patch: { status: t.status === 'clean' ? 'in_progress' : 'dirty' } })}>Undo</Button>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}

function NoteField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return <Input aria-label="Note" className="no-print mt-3" placeholder="Add a note (e.g. broken lamp)" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} />
}

function NewTask({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { me } = useAdmin()
  const [prop, setProp] = useState(me.properties[0]?.id ?? '')
  const [unit, setUnit] = useState('')
  const [due, setDue] = useState(todayNairobi())
  const [priority, setPriority] = useState(false)
  const [notes, setNotes] = useState('')
  const [err, setErr] = useState('')
  const units = useQuery({ queryKey: ['units-of', prop], enabled: !!prop, queryFn: async () => (await sb().from('units').select('id, name').eq('property_id', prop).eq('active', true).order('sort').order('name')).data ?? [] })
  const save = useMutation({
    mutationFn: async () => {
      setErr('')
      if (!unit) throw new Error('Choose the room to clean.')
      const { error } = await sb().from('housekeeping_tasks').insert({ property_id: prop, unit_id: unit, due_date: due, priority, notes: notes.trim() || null, status: 'dirty' })
      if (error) throw error
    },
    onSuccess: () => { toast.success('Task created'); onDone() }, onError: (e) => setErr(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title="New cleaning task" description="For a deep clean, a spot check or anything outside a normal check-out.">
        <div className="grid gap-4">
          <Field label="Property" htmlFor="nt-prop"><Select id="nt-prop" value={prop} onChange={(e) => { setProp(e.target.value); setUnit('') }}>{me.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <Field label="Room" htmlFor="nt-unit"><Select id="nt-unit" value={unit} onChange={(e) => setUnit(e.target.value)}><option value="">Choose a room</option>{units.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
          <Field label="Deadline" htmlFor="nt-due"><Input id="nt-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={priority} onChange={(e) => setPriority(e.target.checked)} /> Priority (do this first)</label>
          <Field label="Instructions" htmlFor="nt-notes"><Input id="nt-notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <Button loading={save.isPending} onClick={() => save.mutate()}>Create task</Button>
        </div>
      </SheetContent>
    </Dialog>
  )
}
