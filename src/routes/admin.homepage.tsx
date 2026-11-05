import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ImagePlus, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { errMessage } from '~/lib/utils'
import { formatDateTime } from '~/lib/dates'
import { MediaPicker } from '~/components/media/MediaPicker'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { Field, Input, Select } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/homepage')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: HomepageAdmin,
})

type Banner = { id: string; placement: 'hero' | 'promo'; title: string | null; subtitle: string | null; image_url: string; link_url: string | null; link_label: string | null; sort: number; published: boolean; starts_at: string | null; ends_at: string | null }
const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '')
const fromLocal = (s: string) => (s ? new Date(s).toISOString() : null)

function status(b: Banner): [string, string] {
  const now = Date.now()
  if (!b.published) return ['Draft', 'border-border bg-muted text-muted-foreground']
  if (b.starts_at && new Date(b.starts_at).getTime() > now) return ['Scheduled', 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300']
  if (b.ends_at && new Date(b.ends_at).getTime() <= now) return ['Ended', 'border-border bg-muted text-muted-foreground']
  return ['Live', 'border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300']
}

function HomepageAdmin() {
  const [editing, setEditing] = useState<Banner | 'new' | null>(null)
  const q = useQuery({ queryKey: ['banners-admin'], queryFn: async () => {
    const { data, error } = await sb().from('homepage_banners').select('*').order('placement').order('sort').order('created_at', { ascending: false })
    if (error) throw error
    return data as Banner[]
  } })
  return (
    <div>
      <PageHeader title="Homepage images" description="Hero banners replace the photo slideshow at the top of the homepage. Promotional banners appear as a strip under it. Both can be scheduled."
        actions={<Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden /> New banner</Button>} />
      {q.isLoading && <Skeleton className="h-48" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && q.data.length === 0 && <EmptyState icon={ImagePlus} title="No banners yet" description="Until a hero banner is live, the homepage uses your property photos." />}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {q.data?.map((b) => {
          const [label, tone] = status(b)
          return (
            <li key={b.id}>
              <button type="button" onClick={() => setEditing(b)} className="block w-full overflow-hidden rounded-xl border text-left hover:border-brand">
                <img src={b.image_url} alt="" loading="lazy" className="aspect-[16/9] w-full object-cover" />
                <div className="p-3 text-sm">
                  <p className="flex items-center justify-between gap-2"><span className="font-medium">{b.title || (b.placement === 'hero' ? 'Hero banner' : 'Promotion')}</span><Badge className={tone}>{label}</Badge></p>
                  <p className="text-xs text-muted-foreground">{b.placement === 'hero' ? 'Hero' : 'Promo strip'}{b.starts_at ? ` · from ${formatDateTime(b.starts_at)}` : ''}{b.ends_at ? ` · until ${formatDateTime(b.ends_at)}` : ''}</p>
                </div>
              </button>
            </li>)
        })}
      </ul>
      {editing && <Editor banner={editing === 'new' ? null : editing} count={q.data?.length ?? 0} onClose={() => setEditing(null)} />}
    </div>
  )
}

function Editor({ banner, count, onClose }: { banner: Banner | null; count: number; onClose: () => void }) {
  const qc = useQueryClient()
  const [picking, setPicking] = useState(false)
  const [v, setV] = useState({
    placement: banner?.placement ?? 'hero', title: banner?.title ?? '', subtitle: banner?.subtitle ?? '', image_url: banner?.image_url ?? '',
    link_url: banner?.link_url ?? '', link_label: banner?.link_label ?? '', published: banner?.published ?? false, starts: toLocal(banner?.starts_at ?? null), ends: toLocal(banner?.ends_at ?? null), sort: String(banner?.sort ?? count + 1),
  })
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: async () => {
      setErr('')
      if (!v.image_url) throw new Error('Choose an image from the library.')
      if (v.link_url && !/^(https:\/\/|\/)/.test(v.link_url.trim())) throw new Error('A link must start with https:// or / (for a page on this site).')
      if (v.starts && v.ends && new Date(v.ends) <= new Date(v.starts)) throw new Error('The end must be after the start.')
      const row = { placement: v.placement, title: v.title.trim() || null, subtitle: v.subtitle.trim() || null, image_url: v.image_url, link_url: v.link_url.trim() || null, link_label: v.link_label.trim() || null, published: v.published, starts_at: fromLocal(v.starts), ends_at: fromLocal(v.ends), sort: Number(v.sort) || 0 }
      const { error } = banner ? await sb().from('homepage_banners').update(row).eq('id', banner.id) : await sb().from('homepage_banners').insert(row)
      if (error) throw error
    },
    onSuccess: () => { toast.success('Saved'); qc.invalidateQueries({ queryKey: ['banners-admin'] }); onClose() },
    onError: (e) => setErr(errMessage(e)),
  })
  const del = useMutation({
    mutationFn: async () => { const { error } = await sb().from('homepage_banners').delete().eq('id', banner!.id); if (error) throw error },
    onSuccess: () => { toast.success('Banner deleted'); qc.invalidateQueries({ queryKey: ['banners-admin'] }); onClose() },
    onError: (e) => toast.error(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={banner ? 'Edit banner' : 'New banner'} description="Choose where it shows, which image, and when.">
        <div className="grid gap-4">
          <div>
            {v.image_url ? <img src={v.image_url} alt="" className="mb-2 aspect-[16/9] w-full rounded-lg object-cover" /> : <p className="mb-2 text-sm text-muted-foreground">No image chosen.</p>}
            <Button variant="outline" onClick={() => setPicking(true)}><ImagePlus className="h-4 w-4" aria-hidden /> {v.image_url ? 'Change image' : 'Choose image'}</Button>
          </div>
          <Field label="Where" htmlFor="bn-place"><Select id="bn-place" value={v.placement} onChange={(e) => setV({ ...v, placement: e.target.value as 'hero' | 'promo' })}><option value="hero">Hero slideshow (top of homepage)</option><option value="promo">Promotional strip (under the hero)</option></Select></Field>
          <Field label="Title" htmlFor="bn-title"><Input id="bn-title" maxLength={100} value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
          <Field label="Subtitle" htmlFor="bn-sub"><Input id="bn-sub" maxLength={200} value={v.subtitle} onChange={(e) => setV({ ...v, subtitle: e.target.value })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Link" htmlFor="bn-link" hint="https://… or /spaces"><Input id="bn-link" value={v.link_url} onChange={(e) => setV({ ...v, link_url: e.target.value })} /></Field>
            <Field label="Button text" htmlFor="bn-label"><Input id="bn-label" maxLength={40} value={v.link_label} onChange={(e) => setV({ ...v, link_label: e.target.value })} /></Field>
            <Field label="Show from" htmlFor="bn-from"><Input id="bn-from" type="datetime-local" value={v.starts} onChange={(e) => setV({ ...v, starts: e.target.value })} /></Field>
            <Field label="Show until" htmlFor="bn-to"><Input id="bn-to" type="datetime-local" value={v.ends} onChange={(e) => setV({ ...v, ends: e.target.value })} /></Field>
            <Field label="Order" htmlFor="bn-sort" hint="Lower numbers come first."><Input id="bn-sort" inputMode="numeric" value={v.sort} onChange={(e) => setV({ ...v, sort: e.target.value })} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.published} onChange={(e) => setV({ ...v, published: e.target.checked })} /> Published (shows within the dates above)</label>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <div className="flex flex-wrap gap-2">
            <Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
            {banner && <Button variant="outline" className="text-danger" loading={del.isPending} onClick={() => { if (confirm('Delete this banner?')) del.mutate() }}>Delete</Button>}
          </div>
        </div>
      </SheetContent>
      {picking && <MediaPicker kind="image" onClose={() => setPicking(false)} onPick={(m) => { setV((s) => ({ ...s, image_url: m.url })); setPicking(false) }} />}
    </Dialog>
  )
}
