import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Eye, EyeOff, Images, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { errMessage } from '~/lib/utils'
import { MediaPicker } from '~/components/media/MediaPicker'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/gallery')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: GalleryAdmin,
})

type Cat = { id: string; name: string; sort: number; published: boolean }
type Item = { id: string; category_id: string; url: string; kind: 'image' | 'video'; alt_text: string | null; caption: string | null; sort: number; published: boolean }

function GalleryAdmin() {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [picking, setPicking] = useState<string | null>(null)
  const q = useQuery({ queryKey: ['gallery-admin'], queryFn: async () => {
    const [c, i] = await Promise.all([
      sb().from('gallery_categories').select('*').order('sort').order('name'),
      sb().from('gallery_items').select('*').order('sort').order('created_at'),
    ])
    if (c.error) throw c.error
    if (i.error) throw i.error
    return { cats: c.data as Cat[], items: i.data as Item[] }
  } })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['gallery-admin'] }) }
  const run = useMutation({
    mutationFn: async (fn: () => PromiseLike<{ error: { message: string } | null }>) => { const { error } = await fn(); if (error) throw new Error(error.message.includes('duplicate') ? 'That category already exists.' : error.message) },
    onSuccess: refresh, onError: (e) => toast.error(errMessage(e)),
  })
  /** Swap sort values with the neighbour so the order is stable and saved. */
  function move<T extends { id: string; sort: number }>(table: 'gallery_items' | 'gallery_categories', list: T[], idx: number, dir: -1 | 1) {
    const a = list[idx]; const b = list[idx + dir]
    if (!b) return
    const sa = a.sort === b.sort ? idx : a.sort; const sbv = a.sort === b.sort ? idx + dir : b.sort
    run.mutate(async () => { const r1 = await sb().from(table).update({ sort: sbv }).eq('id', a.id); if (r1.error) return r1; return sb().from(table).update({ sort: sa }).eq('id', b.id) })
  }
  return (
    <div>
      <PageHeader title="Gallery" description="Organise the photos on the public gallery page into categories. Unpublished items and categories stay hidden." />
      <form className="mb-5 flex max-w-md gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim().length < 2) return; run.mutate(() => sb().from('gallery_categories').insert({ name: name.trim(), sort: (q.data?.cats.length ?? 0) + 1 }).then((r) => { if (!r.error) setName(''); return r })) }}>
        <Input aria-label="New category name" placeholder="New category, e.g. Lounge" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="outline"><Plus className="h-4 w-4" aria-hidden /> Add</Button>
      </form>
      {q.isLoading && <Skeleton className="h-48" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && q.data.cats.length === 0 && <EmptyState icon={Images} title="No gallery categories" description="Until you create categories, the website shows your property photos automatically." />}
      <div className="grid gap-5">
        {q.data?.cats.map((cat, ci) => {
          const items = q.data.items.filter((i) => i.category_id === cat.id)
          return (
            <Card key={cat.id}>
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle>{cat.name}{!cat.published && <span className="ml-2 text-xs font-normal text-muted-foreground">(hidden)</span>}</CardTitle>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" aria-label="Move category up" disabled={ci === 0} onClick={() => move('gallery_categories', q.data.cats, ci, -1)}><ArrowUp className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" aria-label="Move category down" disabled={ci === q.data.cats.length - 1} onClick={() => move('gallery_categories', q.data.cats, ci, 1)}><ArrowDown className="h-4 w-4" /></Button>
                  <Button size="sm" variant="outline" onClick={() => run.mutate(() => sb().from('gallery_categories').update({ published: !cat.published }).eq('id', cat.id))}>{cat.published ? 'Hide' : 'Publish'}</Button>
                  <Button size="sm" onClick={() => setPicking(cat.id)}><Plus className="h-4 w-4" aria-hidden /> Add photos</Button>
                  {items.length === 0 && <Button size="sm" variant="ghost" className="text-danger" onClick={() => { if (confirm(`Delete the empty category "${cat.name}"?`)) run.mutate(() => sb().from('gallery_categories').delete().eq('id', cat.id)) }}><Trash2 className="h-4 w-4" /></Button>}
                </div>
              </CardHeader>
              <CardContent>
                {items.length === 0 ? <p className="text-sm text-muted-foreground">No photos in this category yet.</p> : (
                  <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {items.map((it, ii) => (
                      <li key={it.id} className="rounded-lg border p-2">
                        {it.kind === 'image' ? <img src={it.url} alt={it.alt_text ?? ''} loading="lazy" className={`aspect-video w-full rounded object-cover ${it.published ? '' : 'opacity-40'}`} /> : <video src={it.url} muted preload="metadata" className="aspect-video w-full rounded object-cover" />}
                        <Input aria-label="Caption" className="mt-2" placeholder="Caption" maxLength={140} defaultValue={it.caption ?? ''} onBlur={(e) => e.target.value !== (it.caption ?? '') && run.mutate(() => sb().from('gallery_items').update({ caption: e.target.value.trim() || null }).eq('id', it.id))} />
                        <div className="mt-2 flex items-center justify-between">
                          <div className="flex">
                            <Button size="sm" variant="ghost" aria-label="Move earlier" disabled={ii === 0} onClick={() => move('gallery_items', items, ii, -1)}><ArrowUp className="h-4 w-4" /></Button>
                            <Button size="sm" variant="ghost" aria-label="Move later" disabled={ii === items.length - 1} onClick={() => move('gallery_items', items, ii, 1)}><ArrowDown className="h-4 w-4" /></Button>
                          </div>
                          <div className="flex">
                            <Button size="sm" variant="ghost" aria-label={it.published ? 'Hide photo' : 'Publish photo'} onClick={() => run.mutate(() => sb().from('gallery_items').update({ published: !it.published }).eq('id', it.id))}>{it.published ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}</Button>
                            <Button size="sm" variant="ghost" aria-label="Remove from gallery" className="text-danger" onClick={() => run.mutate(() => sb().from('gallery_items').delete().eq('id', it.id))}><Trash2 className="h-4 w-4" /></Button>
                          </div>
                        </div>
                      </li>))}
                  </ul>
                )}
              </CardContent>
            </Card>)
        })}
      </div>
      {picking && <MediaPicker kind="any" onClose={() => setPicking(null)} onPick={(m) => {
        const count = q.data?.items.filter((i) => i.category_id === picking).length ?? 0
        run.mutate(() => sb().from('gallery_items').insert({ category_id: picking, url: m.url, kind: m.kind, alt_text: m.alt_text, caption: m.title, sort: count + 1 }))
        setPicking(null)
      }} />}
    </div>
  )
}
