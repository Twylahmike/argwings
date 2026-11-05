import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { formatDateTime } from '~/lib/dates'
import { Badge } from '~/components/ui/badge'
import { Input, Select } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, Tabs, TableWrap, td, th } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/activity')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: ActivityPage,
})

type Audit = { id: number; user_id: string | null; action: string; entity: string; entity_id: string | null; diff: unknown; created_at: string }
type Login = { id: number; user_id: string | null; email: string; success: boolean; ip: string | null; user_agent: string | null; created_at: string }

function ActivityPage() {
  const [tab, setTab] = useState<'activity' | 'signins'>('activity')
  const [entity, setEntity] = useState('')
  const [who, setWho] = useState('')
  const [term, setTerm] = useState('')
  const q = useQuery({ queryKey: ['activity'], queryFn: async () => {
    const [a, l, p] = await Promise.all([
      sb().from('audit_log').select('*').order('created_at', { ascending: false }).limit(500),
      sb().from('login_events').select('*').order('created_at', { ascending: false }).limit(300),
      sb().from('profiles').select('id, full_name'),
    ])
    if (a.error) throw a.error
    return { audit: a.data as Audit[], logins: (l.data ?? []) as Login[], names: new Map((p.data ?? []).map((x) => [x.id as string, x.full_name as string])), loginError: l.error }
  } })
  const entities = useMemo(() => [...new Set((q.data?.audit ?? []).map((a) => a.entity))].sort(), [q.data])
  const t = term.trim().toLowerCase()
  const rows = (q.data?.audit ?? []).filter((a) => (!entity || a.entity === entity) && (!who || a.user_id === who) && (!t || `${a.action} ${a.entity} ${a.entity_id ?? ''} ${JSON.stringify(a.diff ?? '')}`.toLowerCase().includes(t)))
  const failed = (q.data?.logins ?? []).filter((l) => !l.success)
  return (
    <div>
      <PageHeader title="Activity log" description="Who did what and when. Entries cannot be edited or deleted by anyone with a login." />
      <div className="mb-4"><Tabs label="Activity" value={tab} onChange={setTab} tabs={[{ value: 'activity', label: 'Changes' }, { value: 'signins', label: `Sign-ins${failed.length ? ` (${failed.length} failed)` : ''}` }]} /></div>
      {q.isLoading && <Skeleton className="h-64" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && tab === 'activity' && (
        <>
          <div className="mb-3 flex flex-wrap gap-3">
            <Select aria-label="Type" className="w-48" value={entity} onChange={(e) => setEntity(e.target.value)}><option value="">All record types</option>{entities.map((x) => <option key={x}>{x}</option>)}</Select>
            <Select aria-label="Person" className="w-48" value={who} onChange={(e) => setWho(e.target.value)}><option value="">Everyone</option>{[...q.data.names].map(([id, n]) => <option key={id} value={id}>{n}</option>)}</Select>
            <Input aria-label="Search" className="max-w-xs" placeholder="Search action or details" value={term} onChange={(e) => setTerm(e.target.value)} />
          </div>
          {rows.length === 0 ? <EmptyState title="Nothing matches" /> : (
            <TableWrap>
              <thead><tr>{['When', 'Who', 'Module', 'Action', 'Record', 'Details'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
              <tbody className="divide-y">{rows.map((r) => (
                <tr key={r.id} className="align-top"><td className={`${td} whitespace-nowrap`}>{formatDateTime(r.created_at)}</td><td className={td}>{r.user_id ? q.data.names.get(r.user_id) ?? 'Unknown' : 'System'}</td>
                  <td className={`${td} capitalize`}>{r.entity.replace(/_/g, ' ')}</td><td className={td}>{r.action}</td><td className={`${td} font-mono text-xs`}>{r.entity_id?.slice(0, 8)}</td>
                  <td className={`${td} max-w-md`}><code className="line-clamp-2 break-all text-xs text-muted-foreground">{r.diff ? JSON.stringify(r.diff) : ''}</code></td></tr>))}</tbody>
            </TableWrap>)}
        </>
      )}
      {q.data && tab === 'signins' && (q.data.loginError ? <p className="rounded-xl border p-4 text-sm text-muted-foreground">Sign-in history is only visible to people with the “View the activity log” permission (the owner by default).</p>
        : q.data.logins.length === 0 ? <EmptyState title="No sign-ins recorded yet" /> : (
          <TableWrap>
            <thead><tr>{['When', 'Email', 'Result', 'Person', 'From'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
            <tbody className="divide-y">{q.data.logins.map((l) => (
              <tr key={l.id}><td className={`${td} whitespace-nowrap`}>{formatDateTime(l.created_at)}</td><td className={td}>{l.email}</td>
                <td className={td}>{l.success ? <Badge className="border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300">Signed in</Badge> : <Badge className="border-danger/40 bg-danger/10 text-danger">Failed</Badge>}</td>
                <td className={td}>{l.user_id ? q.data.names.get(l.user_id) : '—'}</td><td className={`${td} text-xs text-muted-foreground`}>{l.ip}<br />{l.user_agent?.slice(0, 50)}</td></tr>))}</tbody>
          </TableWrap>))}
    </div>
  )
}
