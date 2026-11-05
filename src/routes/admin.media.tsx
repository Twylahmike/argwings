import { useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Copy, ImagePlus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { errMessage } from '~/lib/utils'
import { uploadMedia } from '~/lib/images'
import { useMedia, type MediaRow } from '~/components/media/MediaPicker'
import { Button } from '~/components/ui/button'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { Field, Input, Select } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/media')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: MediaPage,
})

const CATEGORIES = ['general', 'rooms', 'lobby', 'exterior', 'amenities', 'food and drink', 'events', 'branding']

function MediaPage() {
  const qc = useQueryClient()
  const media = useMedia()
  const input = useRef<HTMLInputElement>(null)
  const [category, setCategory] = useState('general')
  const [filter, setFilter] = useState('all')
  const [term, setTerm] = useState('')
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState<MediaRow | null>(null)

  async function upload(files: FileList | null) {
    if (!files?.length) return
    setBusy(true)
    let ok = 0
    for (const file of Array.from(files)) {
      try {
        const up = await uploadMedia(file)
        const { error } = await sb().from('media_assets').insert({ url: up.url, storage_path: up.path, kind: up.kind, title: file.name.replace(/\.[^.]+$/, '').slice(0, 120), category, size_bytes: up.size, uploaded_by: (await sb().auth.getUser()).data.user?.id })
        if (error) { await sb().storage.from('property-images').remove([up.path]); throw error }
        ok++
      } catch (e) { toast.error(`${file.name}: ${errMessage(e)}`) }
    }
    setBusy(false)
    if (input.current) input.current.value = ''
    if (ok) { toast.success(`${ok} file${ok === 1 ? '' : 's'} uploaded`); qc.invalidateQueries({ queryKey: ['media'] }) }
  }
  const t = term.trim().toLowerCase()
  const rows = (media.data ?? []).filter((m) => (filter === 'all' || m.category === filter) && (!t || `${m.title ?? ''} ${m.alt_text ?? ''}`.toLowerCase().includes(t)))
  const cats = [...new Set([...(media.data ?? []).map((m) => m.category)])]
  return (
    <div>
      <PageHeader title="Media library" description="Upload photos and short videos once, then reuse them in the gallery, on the homepage and on listings. Photos are resized automatically."
        actions={<div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Category for new uploads" className="w-44" value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
          <input ref={input} type="file" accept="image/*,video/mp4,video/webm" multiple hidden onChange={(e) => upload(e.target.files)} />
          <Button loading={busy} onClick={() => input.current?.click()}><ImagePlus className="h-4 w-4" aria-hidden /> Upload</Button>
        </div>} />
      <div className="mb-4 flex flex-wrap gap-3">
        <Select aria-label="Filter by category" className="w-48" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">All categories</option>{cats.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
        <Input aria-label="Search media" className="max-w-xs" placeholder="Search by name" value={term} onChange={(e) => setTerm(e.target.value)} />
      </div>
      {media.isLoading && <Skeleton className="h-64" />}
      {media.error && <ErrorState error={media.error} retry={() => media.refetch()} />}
      {media.data && rows.length === 0 && <EmptyState icon={ImagePlus} title="No files yet" description="Upload your first photos to get started." />}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {rows.map((m) => (
          <li key={m.id}>
            <button type="button" onClick={() => setEdit(m)} className="block w-full overflow-hidden rounded-lg border text-left hover:border-brand">
              {m.kind === 'image' ? <img src={m.url} alt={m.alt_text ?? m.title ?? ''} loading="lazy" className="aspect-square w-full object-cover" /> : <video src={m.url} muted preload="metadata" className="aspect-square w-full object-cover" />}
              <span className="block truncate px-2 pt-1 text-sm font-medium">{m.title || 'Untitled'}</span>
              <span className="block px-2 pb-1 text-xs text-muted-foreground">{m.category}{m.size_bytes ? ` · ${(m.size_bytes / 1024).toFixed(0)} KB` : ''}</span>
            </button>
          </li>))}
      </ul>
      {edit && <Editor m={edit} onClose={() => setEdit(null)} />}
    </div>
  )
}

function Editor({ m, onClose }: { m: MediaRow; onClose: () => void }) {
  const qc = useQueryClient()
  const [v, setV] = useState({ title: m.title ?? '', alt_text: m.alt_text ?? '', category: m.category })
  const save = useMutation({
    mutationFn: async () => { const { error } = await sb().from('media_assets').update({ title: v.title.trim() || null, alt_text: v.alt_text.trim() || null, category: v.category.trim() || 'general' }).eq('id', m.id); if (error) throw error },
    onSuccess: () => { toast.success('Saved'); qc.invalidateQueries({ queryKey: ['media'] }); onClose() },
    onError: (e) => toast.error(errMessage(e)),
  })
  const del = useMutation({
    mutationFn: async () => {
      const { data, error } = await sb().rpc('delete_media_asset', { p_id: m.id })
      if (error) throw error
      await sb().storage.from('property-images').remove([data as string])
    },
    onSuccess: () => { toast.success('File deleted'); qc.invalidateQueries({ queryKey: ['media'] }); onClose() },
    onError: (e) => toast.error(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={m.title || 'Media file'} description={`Uploaded ${new Date(m.created_at).toLocaleDateString('en-KE')}`}>
        <div className="grid gap-4">
          {m.kind === 'image' ? <img src={m.url} alt={m.alt_text ?? ''} className="max-h-72 w-full rounded-lg object-contain" /> : <video src={m.url} controls className="max-h-72 w-full rounded-lg" />}
          <Field label="Name" htmlFor="md-title"><Input id="md-title" maxLength={120} value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
          <Field label="Description for screen readers and search" htmlFor="md-alt" hint="Describe what the photo shows."><Input id="md-alt" maxLength={200} value={v.alt_text} onChange={(e) => setV({ ...v, alt_text: e.target.value })} /></Field>
          <Field label="Category" htmlFor="md-cat"><Input id="md-cat" list="media-cats" maxLength={40} value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} /><datalist id="media-cats">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist></Field>
          <div className="flex flex-wrap gap-2">
            <Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
            <Button variant="outline" onClick={() => navigator.clipboard.writeText(m.url).then(() => toast.success('Link copied'))}><Copy className="h-4 w-4" /> Copy link</Button>
            <Button variant="outline" className="text-danger" loading={del.isPending} onClick={() => { if (confirm('Delete this file? This only works if it is not used on the website.')) del.mutate() }}><Trash2 className="h-4 w-4" /> Delete</Button>
          </div>
        </div>
      </SheetContent>
    </Dialog>
  )
}
