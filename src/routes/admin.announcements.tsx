import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Megaphone, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { errMessage } from '~/lib/utils'
import { formatDateTime } from '~/lib/dates'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Dialog, DialogContent } from '~/components/ui/dialog'
import { Field, Input, Select } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, TableWrap, td, th } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/announcements')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: AnnouncementsPage,
})

type Ann = { id: string; text: string; link: string | null; variant: 'info' | 'promo'; starts_at: string | null; ends_at: string | null; active: boolean; created_at: string }
function stateOf(a: Ann): { label: string; tone: string } {
  const now = Date.now()
  if (!a.active) return { label: 'Archived', tone: 'text-muted-foreground' }
  if (a.starts_at && new Date(a.starts_at).getTime() > now) return { label: 'Scheduled', tone: 'border-sky-500/40 text-sky-700 dark:text-sky-300' }
  if (a.ends_at && new Date(a.ends_at).getTime() < now) return { label: 'Ended', tone: 'text-muted-foreground' }
  return { label: 'Live', tone: 'border-emerald-600/40 text-emerald-700 dark:text-emerald-300' }
}
/** ISO <-> value of <input type="datetime-local"> (browser local time) */
const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '')
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null)

function AnnouncementsPage() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Ann | 'new' | null>(null)
  const q = useQuery({ queryKey: ['announcements-admin'], queryFn: async () => {
    const { data, error } = await sb().from('announcements').select('*').order('created_at', { ascending: false }).limit(300)
    if (error) throw error
    return data as Ann[]
  } })
  const toggle = useMutation({
    mutationFn: async (a: Ann) => { const { error } = await sb().from('announcements').update({ active: !a.active }).eq('id', a.id); if (error) throw error },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['announcements-admin'] }); toast.success('Saved') },
    onError: (e) => toast.error(errMessage(e)),
  })
  return (
    <div>
      <PageHeader title="Announcements" description="A notice bar at the top of your website. Schedule it, publish it, or archive it. Past announcements are kept as history."
        actions={<Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden /> New announcement</Button>} />
      {q.isLoading && <Skeleton className="h-40" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data?.length === 0 && <EmptyState icon={Megaphone} title="No announcements yet" description="Add one to show a banner on your website, for example a seasonal offer." />}
      {!!q.data?.length && <TableWrap>
        <thead><tr>{['Message', 'Style', 'Shows', 'State', ''].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
        <tbody className="divide-y">{q.data.map((a) => { const s = stateOf(a); return (
          <tr key={a.id} className="align-top">
            <td className={`${td} max-w-sm`}><p className="font-medium">{a.text}</p>{a.link && <p className="truncate text-xs text-muted-foreground">{a.link}</p>}</td>
            <td className={td}>{a.variant === 'promo' ? 'Brand colour' : 'Dark'}</td>
            <td className={`${td} whitespace-nowrap text-xs text-muted-foreground`}>{a.starts_at ? formatDateTime(a.starts_at) : 'Now'}<br />to {a.ends_at ? formatDateTime(a.ends_at) : 'until archived'}</td>
            <td className={td}><Badge className={s.tone}>{s.label}</Badge></td>
            <td className={`${td} whitespace-nowrap`}><div className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => setEditing(a)}>Edit</Button>
              <Button size="sm" variant="ghost" loading={toggle.isPending} onClick={() => toggle.mutate(a)}>{a.active ? 'Archive' : 'Publish'}</Button></div></td>
          </tr>) })}</tbody>
      </TableWrap>}
      {editing && <Editor a={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function Editor({ a, onClose }: { a: Ann | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [text, setText] = useState(a?.text ?? '')
  const [link, setLink] = useState(a?.link ?? '')
  const [variant, setVariant] = useState<'info' | 'promo'>(a?.variant ?? 'info')
  const [starts, setStarts] = useState(toLocal(a?.starts_at ?? null))
  const [ends, setEnds] = useState(toLocal(a?.ends_at ?? null))
  const [error, setError] = useState('')
  const save = useMutation({
    mutationFn: async () => {
      const l = link.trim()
      if (l && !(l.startsWith('/') && !l.startsWith('//')) && !/^https:\/\//.test(l)) throw new Error('The link must start with https:// or be a page like /search.')
      if (starts && ends && new Date(ends) <= new Date(starts)) throw new Error('The end must be after the start.')
      const { data: u } = await sb().auth.getUser()
      const row = { text: text.trim(), link: l || null, variant, starts_at: fromLocal(starts), ends_at: fromLocal(ends) }
      const r = a ? await sb().from('announcements').update(row).eq('id', a.id) : await sb().from('announcements').insert({ ...row, created_by: u.user?.id, active: true })
      if (r.error) throw r.error
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['announcements-admin'] }); toast.success('Saved'); onClose() },
    onError: (e) => setError(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={a ? 'Edit announcement' : 'New announcement'} description="Shown as a bar at the top of the website.">
        <div className="grid gap-4">
          <Field label="Message" htmlFor="an-text" hint="Short and clear, up to 160 characters."><Input id="an-text" maxLength={160} value={text} onChange={(e) => setText(e.target.value)} /></Field>
          <Field label="Link (optional)" htmlFor="an-link" hint="https://... or a page such as /search"><Input id="an-link" value={link} onChange={(e) => setLink(e.target.value)} /></Field>
          <Field label="Style" htmlFor="an-var"><Select id="an-var" value={variant} onChange={(e) => setVariant(e.target.value as 'info' | 'promo')}><option value="info">Dark</option><option value="promo">Brand colour</option></Select></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Starts (optional)" htmlFor="an-s"><Input id="an-s" type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} /></Field>
            <Field label="Ends (optional)" htmlFor="an-e"><Input id="an-e" type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} /></Field>
          </div>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <Button loading={save.isPending} disabled={text.trim().length < 2} onClick={() => { setError(''); save.mutate() }}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
