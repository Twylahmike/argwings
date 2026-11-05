import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { errMessage } from '~/lib/utils'
import { addDays, formatDate, todayNairobi } from '~/lib/dates'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { Field, Input, Select } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, Tabs, TableWrap, td, th } from '~/components/ui/misc'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/blocked')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: BlockedPage,
})

type Range = { id: string; property_id: string; scope: string; reason: string; note: string | null; start_date: string; end_date: string; released_at: string | null }
const REASONS: [string, string][] = [['maintenance', 'Maintenance'], ['renovation', 'Renovation'], ['private_use', 'Private use'], ['closure', 'Operational closure'], ['other', 'Other']]
const reasonLabel = (r: string) => REASONS.find(([v]) => v === r)?.[1] ?? r

function BlockedPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'active' | 'past'>('active')
  const [creating, setCreating] = useState(false)
  const today = todayNairobi()
  const q = useQuery({
    queryKey: ['blocked-ranges'],
    queryFn: async () => {
      const [r, p, u] = await Promise.all([
        sb().from('blocked_ranges').select('*').order('start_date', { ascending: false }).limit(500),
        sb().from('properties').select('id, name'),
        sb().from('bookings').select('block_range_id, unit:units(name)').eq('status', 'blocked').not('block_range_id', 'is', null).limit(5000),
      ])
      if (r.error) throw r.error
      const units = new Map<string, string[]>()
      for (const x of (u.data ?? []) as unknown as { block_range_id: string; unit: { name: string } | null }[]) units.set(x.block_range_id, [...(units.get(x.block_range_id) ?? []), x.unit?.name ?? ''])
      return { rows: r.data as Range[], props: new Map((p.data ?? []).map((x) => [x.id as string, x.name as string])), units }
    },
  })
  const release = useMutation({
    mutationFn: async (id: string) => { const { error } = await sb().rpc('release_blocked_range', { p_range: id }); if (error) throw error },
    onSuccess: () => { toast.success('Dates are open for booking again'); qc.invalidateQueries({ queryKey: ['blocked-ranges'] }); qc.invalidateQueries({ queryKey: ['calendar'] }) },
    onError: (e) => toast.error(errMessage(e)),
  })
  const rows = (q.data?.rows ?? []).filter((r) => (tab === 'active' ? !r.released_at && r.end_date > today : !!r.released_at || r.end_date <= today))
  return (
    <div>
      <PageHeader title="Blocked dates" description="Take rooms or a whole property off sale. Blocked dates disappear from the website straight away. A block can never cover a real booking."
        actions={<Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Block dates</Button>} />
      <div className="mb-4"><Tabs label="Blocks" value={tab} onChange={setTab} tabs={[{ value: 'active', label: 'Current and upcoming' }, { value: 'past', label: 'Past and released' }]} /></div>
      {q.isLoading && <Skeleton className="h-48" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && rows.length === 0 && <EmptyState icon={Ban} title="Nothing blocked" description="Use Block dates for maintenance, renovation, private use or a closure." />}
      {rows.length > 0 && (
        <TableWrap>
          <thead><tr>{['Dates', 'Property', 'Rooms', 'Reason', ''].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">{rows.map((r) => (
            <tr key={r.id}>
              <td className={`${td} whitespace-nowrap`}>{formatDate(r.start_date)} to {formatDate(addDays(r.end_date, -1))}</td>
              <td className={td}>{q.data!.props.get(r.property_id)}</td>
              <td className={td}>{r.scope === 'property' ? 'Whole property' : (q.data!.units.get(r.id) ?? []).join(', ') || 'Released'}</td>
              <td className={td}><Badge className="border-border bg-muted">{reasonLabel(r.reason)}</Badge>{r.note && <p className="text-xs text-muted-foreground">{r.note}</p>}</td>
              <td className={td}>{r.released_at ? <span className="text-xs text-muted-foreground">Released</span> : <Button size="sm" variant="outline" loading={release.isPending && release.variables === r.id} onClick={() => { if (confirm('Open these dates for booking again?')) release.mutate(r.id) }}>Release</Button>}</td>
            </tr>))}</tbody>
        </TableWrap>
      )}
      {creating && <Create onClose={() => setCreating(false)} onDone={() => { setCreating(false); qc.invalidateQueries({ queryKey: ['blocked-ranges'] }); qc.invalidateQueries({ queryKey: ['calendar'] }) }} />}
    </div>
  )
}

function Create({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { me } = useAdmin()
  const [prop, setProp] = useState(me.properties[0]?.id ?? '')
  const [scope, setScope] = useState<'property' | 'rooms'>('property')
  const [picked, setPicked] = useState<string[]>([])
  const [from, setFrom] = useState(todayNairobi())
  const [to, setTo] = useState(addDays(todayNairobi(), 1))
  const [reason, setReason] = useState('maintenance')
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const units = useQuery({ queryKey: ['units-of', prop], enabled: !!prop, queryFn: async () => {
    const { data, error } = await sb().from('units').select('id, name').eq('property_id', prop).eq('active', true).order('sort').order('name')
    if (error) throw error
    return data as { id: string; name: string }[]
  } })
  const save = useMutation({
    mutationFn: async () => {
      setErr('')
      if (scope === 'rooms' && picked.length === 0) throw new Error('Choose at least one room.')
      if (to <= from) throw new Error('The last blocked night must be on or after the first.')
      const { error } = await sb().rpc('block_dates', { p_property: prop, p_units: scope === 'property' ? null : picked, p_in: from, p_out: addDays(to, 1), p_reason: reason, p_note: note || null })
      if (error) throw error
    },
    onSuccess: () => { toast.success('Dates blocked'); onDone() },
    onError: (e) => setErr(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title="Block dates" description="Dates are blocked from the first night to the last night you choose, inclusive.">
        <div className="grid gap-4">
          <Field label="Property" htmlFor="bl-prop"><Select id="bl-prop" value={prop} onChange={(e) => { setProp(e.target.value); setPicked([]) }}>{me.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <Field label="What to block" htmlFor="bl-scope"><Select id="bl-scope" value={scope} onChange={(e) => setScope(e.target.value as 'property' | 'rooms')}><option value="property">The whole property (every room)</option><option value="rooms">Selected rooms</option></Select></Field>
          {scope === 'rooms' && <fieldset className="grid gap-1 text-sm"><legend className="mb-1 font-medium">Rooms</legend>
            {units.data?.map((u) => <label key={u.id} className="flex items-center gap-2"><input type="checkbox" checked={picked.includes(u.id)} onChange={(e) => setPicked((p) => e.target.checked ? [...p, u.id] : p.filter((x) => x !== u.id))} /> {u.name}</label>)}</fieldset>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First night" htmlFor="bl-from"><Input id="bl-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="Last night" htmlFor="bl-to"><Input id="bl-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          </div>
          <Field label="Reason" htmlFor="bl-reason"><Select id="bl-reason" value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          <Field label="Note" htmlFor="bl-note"><Input id="bl-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <Button loading={save.isPending} onClick={() => save.mutate()}>Block these dates</Button>
        </div>
      </SheetContent>
    </Dialog>
  )
}
