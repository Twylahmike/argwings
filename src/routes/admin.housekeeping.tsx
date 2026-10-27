import { useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Brush, CheckCircle2, Printer } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { canManage } from '~/lib/auth'
import type { HousekeepingTask, TaskStatus } from '~/lib/types'
import { formatDate, todayNairobi } from '~/lib/dates'
import { errMessage } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { TaskBadge } from '~/components/ui/badge'
import { Input, Select } from '~/components/ui/form'
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
        actions={<><Tabs label="Show" value={show} onChange={setShow} tabs={[{ value: 'open', label: 'To do' }, { value: 'done', label: 'Done (7 days)' }]} />
          <Button variant="outline" className="no-print" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print checklist</Button></>} />
      {tasks.isLoading && <Skeleton className="h-64" />}
      {tasks.error && <ErrorState error={tasks.error} retry={() => tasks.refetch()} />}
      {tasks.data && byProperty.length === 0 && <EmptyState icon={show === 'open' ? CheckCircle2 : Brush} title={show === 'open' ? 'All clean!' : 'Nothing finished recently'} description={show === 'open' ? 'Units appear here automatically when a guest checks out.' : undefined} />}
      <div className="grid gap-6">
        {byProperty.map(([pid, { name, rows }]) => (
          <section key={pid} aria-labelledby={`hk-${pid}`} className="break-inside-avoid">
            <h2 id={`hk-${pid}`} className="mb-2 text-lg font-semibold">{name} <span className="text-sm font-normal text-muted-foreground">({rows.length})</span></h2>
            <ul className="grid gap-3 md:grid-cols-2">
              {rows.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || Number(b.priority) - Number(a.priority)).map((t) => (
                <li key={t.id} className={`rounded-xl border bg-card p-4 ${t.priority ? 'border-danger/60' : ''}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div><p className="text-lg font-semibold">{t.unit.name}</p>{t.priority && <p className="text-xs font-semibold uppercase text-danger">Same-day turnover: guest arriving today</p>}</div>
                    <TaskBadge status={t.status} />
                  </div>
                  <p className="mt-1 hidden text-sm print:block">☐ Beds ☐ Bathroom ☐ Kitchen ☐ Floors ☐ Restock ☐ Check for damage</p>
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
