import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { errMessage } from '~/lib/utils'
import { formatDateTime } from '~/lib/dates'
import { parseDoc, slugifyPage } from '~/lib/plain-doc'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { Field, Input, Textarea } from '~/components/ui/form'
import { EmptyState, ErrorState, PageHeader, Skeleton, TableWrap, td, th } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/pages')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: PagesAdmin,
})

type Page = { slug: string; title: string; body: string; published: boolean; show_in_footer: boolean; sort: number; updated_at: string }

function PagesAdmin() {
  const [editing, setEditing] = useState<Page | 'new' | null>(null)
  const q = useQuery({ queryKey: ['site-pages'], queryFn: async () => {
    const { data, error } = await sb().from('site_pages').select('*').order('sort').order('title')
    if (error) throw error
    return data as Page[]
  } })
  return (
    <div>
      <PageHeader title="Policy pages" description="Terms, privacy notice, house rules and other pages. A page is public only while it is published; the starter pages are drafts you must review first."
        actions={<Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" aria-hidden /> New page</Button>} />
      {q.isLoading && <Skeleton className="h-40" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data?.length === 0 && <EmptyState icon={FileText} title="No pages yet" />}
      {!!q.data?.length && (
        <TableWrap>
          <thead><tr>{['Page', 'Address', 'Status', 'Last edited'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
          <tbody className="divide-y">{q.data.map((p) => (
            <tr key={p.slug} className="cursor-pointer hover:bg-muted/40" onClick={() => setEditing(p)}>
              <td className={td}><button className="font-medium text-brand hover:underline" onClick={() => setEditing(p)}>{p.title}</button></td>
              <td className={`${td} font-mono text-xs`}>/p/{p.slug}</td>
              <td className={td}>{p.published ? <Badge className="border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300">Published</Badge> : <Badge className="border-border bg-muted text-muted-foreground">Draft</Badge>}</td>
              <td className={`${td} whitespace-nowrap`}>{formatDateTime(p.updated_at)}</td>
            </tr>))}</tbody>
        </TableWrap>
      )}
      {editing && <Editor page={editing === 'new' ? null : editing} count={q.data?.length ?? 0} onClose={() => setEditing(null)} />}
    </div>
  )
}

function Editor({ page, count, onClose }: { page: Page | null; count: number; onClose: () => void }) {
  const qc = useQueryClient()
  const [v, setV] = useState({ title: page?.title ?? '', slug: page?.slug ?? '', body: page?.body ?? '', published: page?.published ?? false, footer: page?.show_in_footer ?? true })
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: async () => {
      setErr('')
      if (v.title.trim().length < 2) throw new Error('Give the page a title.')
      const slug = page?.slug ?? slugifyPage(v.slug || v.title)
      if (slug.length < 3) throw new Error('The address needs at least 3 letters or numbers.')
      if (v.published && /review before publishing/i.test(v.body)) throw new Error('Remove the “Review before publishing” note and write your own text before publishing.')
      const row = { title: v.title.trim(), body: v.body, published: v.published, show_in_footer: v.footer }
      const { error } = page ? await sb().from('site_pages').update(row).eq('slug', page.slug) : await sb().from('site_pages').insert({ ...row, slug, sort: (count + 1) * 10 })
      if (error) throw new Error(error.code === '23505' ? 'A page with that address already exists.' : error.message)
    },
    onSuccess: () => { toast.success('Saved'); qc.invalidateQueries({ queryKey: ['site-pages'] }); onClose() },
    onError: (e) => setErr(errMessage(e)),
  })
  const del = useMutation({
    mutationFn: async () => { const { error } = await sb().from('site_pages').delete().eq('slug', page!.slug); if (error) throw error },
    onSuccess: () => { toast.success('Page deleted'); qc.invalidateQueries({ queryKey: ['site-pages'] }); onClose() },
    onError: (e) => toast.error(errMessage(e)),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={page ? page.title : 'New page'} description="Use “# Heading” for headings, “- item” for lists, and blank lines between paragraphs.">
        <div className="grid gap-4">
          <Field label="Title" htmlFor="pg-title"><Input id="pg-title" maxLength={80} value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
          {!page && <Field label="Web address" htmlFor="pg-slug" hint={`Will be /p/${slugifyPage(v.slug || v.title) || '...'}`}><Input id="pg-slug" maxLength={40} value={v.slug} onChange={(e) => setV({ ...v, slug: e.target.value })} /></Field>}
          <Field label="Text" htmlFor="pg-body"><Textarea id="pg-body" rows={12} maxLength={30000} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} /></Field>
          <div className="rounded-lg border p-3" aria-label="Preview">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Preview</p>
            <div className="space-y-2 text-sm">{parseDoc(v.body).slice(0, 12).map((b, i) => b.type === 'h' ? <p key={i} className="font-semibold">{b.text}</p> : b.type === 'ul' ? <ul key={i} className="list-disc pl-5">{b.items.map((it, j) => <li key={j}>{it}</li>)}</ul> : <p key={i}>{b.text}</p>)}</div>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.published} onChange={(e) => setV({ ...v, published: e.target.checked })} /> Published (visible to everyone)</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.footer} onChange={(e) => setV({ ...v, footer: e.target.checked })} /> Link from the website footer</label>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <div className="flex gap-2"><Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>{page && <Button variant="outline" className="text-danger" loading={del.isPending} onClick={() => { if (confirm('Delete this page?')) del.mutate() }}>Delete</Button>}</div>
        </div>
      </SheetContent>
    </Dialog>
  )
}
