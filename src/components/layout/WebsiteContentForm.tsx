import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ImagePlus } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { uploadImage } from '~/lib/images'
import { errMessage } from '~/lib/utils'
import { DEFAULT_SITE_CONTENT, HOME_SECTIONS, parseHeadline, sanitizeSiteContent, type SiteContent } from '~/lib/site-content'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Field, Input, Textarea } from '~/components/ui/form'
import { ErrorState, Skeleton } from '~/components/ui/misc'

const KEY = 'site_content'

/** Admin > Settings > Website: edits the marketing copy shown on the public site (stored as settings.site_content). */
export function WebsiteContentForm() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['site-content'],
    queryFn: async () => {
      const { data, error } = await sb().from('settings').select('value').eq('key', KEY).maybeSingle()
      if (error) throw error
      return sanitizeSiteContent(data?.value)
    },
  })
  const [c, setC] = useState<SiteContent>(DEFAULT_SITE_CONTENT)
  const [ticker, setTicker] = useState('')
  const [busyImg, setBusyImg] = useState(false)
  useEffect(() => { if (q.data) { setC(q.data); setTicker(q.data.tickerItems.join('\n')) } }, [q.data])

  const set = <K extends keyof SiteContent>(k: K, v: SiteContent[K]) => setC((s) => ({ ...s, [k]: v }))

  const history = useQuery({
    queryKey: ['site-content-versions'],
    queryFn: async () => {
      const { data, error } = await sb().from('site_content_versions').select('id, content, status, note, created_at, published_at').order('created_at', { ascending: false }).limit(20)
      if (error) throw error
      return data as { id: string; content: unknown; status: 'draft' | 'published' | 'archived'; note: string | null; created_at: string; published_at: string | null }[]
    },
  })
  const [note, setNote] = useState('')
  const draft = () => sanitizeSiteContent({ ...c, tickerItems: ticker.split('\n') })
  async function newVersion() {
    const { data: u } = await sb().auth.getUser()
    const { data, error } = await sb().from('site_content_versions').insert({ content: draft(), note: note.trim() || null, created_by: u.user?.id }).select('id').single()
    if (error) throw error
    return data.id as string
  }
  const saveDraft = useMutation({
    mutationFn: newVersion,
    onSuccess: () => { toast.success('Draft saved. The website has not changed yet.'); setNote(''); qc.invalidateQueries({ queryKey: ['site-content-versions'] }) },
    onError: (e) => toast.error(errMessage(e)),
  })
  const publish = useMutation({
    mutationFn: async (existing?: string) => {
      const id = existing ?? (await newVersion())
      const { error } = await sb().rpc('publish_site_content', { p_version: id })
      if (error) throw error
    },
    onSuccess: () => { toast.success('Published. The website now shows this content.'); setNote(''); qc.invalidateQueries({ queryKey: ['site-content'] }); qc.invalidateQueries({ queryKey: ['site-content-versions'] }); setTimeout(() => window.location.reload(), 800) },
    onError: (e) => toast.error(errMessage(e)),
  })
  const load = (content: unknown) => { const v = sanitizeSiteContent(content); setC(v); setTicker(v.tickerItems.join('\n')); toast.success('Loaded into the editor. Save a draft or publish when ready.') }

  async function image(file?: File) {
    if (!file) return
    setBusyImg(true)
    try { set('facility', { ...c.facility, image: await uploadImage(file, 'branding') }); toast.success('Image uploaded. Press Save to apply it.') } catch (e) { toast.error(errMessage(e)) } finally { setBusyImg(false) }
  }

  if (q.isLoading) return <Skeleton className="h-96" />
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const t = (id: string, label: string, value: string, onChange: (v: string) => void, hint?: string, placeholder?: string) => (
    <Field label={label} htmlFor={id} hint={hint}><Input id={id} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} /></Field>
  )
  return (
    <div className="grid max-w-3xl gap-5">
      <p className="text-sm text-muted-foreground">Text and links shown on your public website. Leave a field empty to hide that part of the page. Name, logo, colour, WhatsApp and prices are in the Business tab and on each property. Announcements and guest reviews have their own pages in the sidebar.</p>
      <Card><CardHeader><CardTitle>Home page top</CardTitle></CardHeader><CardContent className="grid gap-4">
        {t('w-head', 'Headline', c.heroHeadline, (v) => set('heroHeadline', v), 'Put one word in *stars* to highlight it, e.g. Stay *well*.')}
        {t('w-sub', 'Line under the headline', c.heroSubline, (v) => set('heroSubline', v))}
        {t('w-tag', 'Tagline', c.tagline, (v) => set('tagline', v), 'Shown in the website footer.', 'e.g. Stay, relax, feel at home')}
        <Field label="Scrolling strip (one short point per line)" htmlFor="w-ticker" hint="Up to 8 lines. Only write things that are true."><Textarea id="w-ticker" rows={4} value={ticker} onChange={(e) => setTicker(e.target.value)} /></Field>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Contact and links</CardTitle></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2">
        {t('w-loc', 'Where you are', c.location, (v) => set('location', v), 'City or neighbourhoods.', 'e.g. Nairobi')}
        {t('w-mail', 'Contact email', c.contactEmail, (v) => set('contactEmail', v))}
        {t('w-ig', 'Instagram link', c.social.instagram, (v) => set('social', { ...c.social, instagram: v }), 'Full link starting with https://')}
        {t('w-fb', 'Facebook link', c.social.facebook, (v) => set('social', { ...c.social, facebook: v }))}
        {t('w-tt', 'TikTok link', c.social.tiktok, (v) => set('social', { ...c.social, tiktok: v }))}
        {t('w-x', 'X link', c.social.x, (v) => set('social', { ...c.social, x: v }))}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Feature band (optional)</CardTitle></CardHeader><CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">A full-width highlight such as a pool, rooftop or gym. Empty title = hidden.</p>
        {t('w-fe', 'Small label', c.facility.eyebrow, (v) => set('facility', { ...c.facility, eyebrow: v }))}
        {t('w-ft', 'Title', c.facility.title, (v) => set('facility', { ...c.facility, title: v }))}
        <Field label="Text" htmlFor="w-fb2"><Textarea id="w-fb2" rows={2} value={c.facility.body} onChange={(e) => set('facility', { ...c.facility, body: e.target.value })} /></Field>
        <div className="flex flex-wrap items-center gap-3">
          {c.facility.image && <img src={c.facility.image} alt="Feature band" className="h-16 w-24 rounded border object-cover" />}
          <label className="inline-flex"><input type="file" accept="image/*" hidden onChange={(e) => image(e.target.files?.[0])} /><span role="button" tabIndex={0} className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-md border bg-card px-4 text-sm font-medium hover:bg-muted"><ImagePlus className="h-4 w-4" /> {busyImg ? 'Uploading…' : 'Upload image'}</span></label>
          {c.facility.image && <Button variant="ghost" size="sm" onClick={() => set('facility', { ...c.facility, image: '' })}>Remove</Button>}
        </div>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Sharing and search</CardTitle></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2">
        {t('w-url', 'Website address', c.siteUrl, (v) => set('siteUrl', v), 'e.g. https://yourdomain.co.ke (used for share links).')}
        {t('w-og', 'Share image link', c.ogImage, (v) => set('ogImage', v), 'Picture shown when the site link is shared (1200x630).')}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Home page sections</CardTitle></CardHeader><CardContent className="grid gap-2">
        <p className="text-sm text-muted-foreground">Choose the order of the sections under the top banner, and hide the ones you do not want. Takes effect when you publish.</p>
        <ol className="divide-y text-sm">{c.sections.order.map((id, i) => {
          const label = HOME_SECTIONS.find((x) => x.id === id)?.label ?? id
          const hidden = c.sections.hidden.includes(id)
          const move = (d: -1 | 1) => { const o = [...c.sections.order]; const j = i + d; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; set('sections', { ...c.sections, order: o }) }
          return (
            <li key={id} className="flex items-center justify-between gap-2 py-2">
              <span className={hidden ? 'text-muted-foreground line-through' : ''}>{i + 1}. {label}</span>
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" aria-label={`Move ${label} up`} disabled={i === 0} onClick={() => move(-1)}>↑</Button>
                <Button size="sm" variant="ghost" aria-label={`Move ${label} down`} disabled={i === c.sections.order.length - 1} onClick={() => move(1)}>↓</Button>
                <Button size="sm" variant="outline" onClick={() => set('sections', { ...c.sections, hidden: hidden ? c.sections.hidden.filter((x) => x !== id) : [...c.sections.hidden, id] })}>{hidden ? 'Show' : 'Hide'}</Button>
              </span>
            </li>)
        })}</ol>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Preview</CardTitle></CardHeader><CardContent>
        <div className="rounded-xl bg-neutral-900 p-6 text-center text-white" aria-label="Preview of the home page top">
          <p className="font-display text-3xl">{parseHeadline(c.heroHeadline).map((p, i) => p.accent ? <em key={i}>{p.text}</em> : <span key={i}>{p.text}</span>)}</p>
          {c.heroSubline && <p className="mt-2 text-sm text-white/80">{c.heroSubline}</p>}
          {c.tagline && <p className="mt-4 text-xs italic text-white/60">{c.tagline}</p>}
        </div>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Save or publish</CardTitle></CardHeader><CardContent className="grid gap-3">
        <p className="text-sm text-muted-foreground">A draft is stored privately. Publishing puts this content on the live website and keeps the previous version in the history below.</p>
        <Field label="Note for the history (optional)" htmlFor="w-note"><Input id="w-note" maxLength={200} placeholder="e.g. New Christmas headline" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="flex flex-wrap gap-2"><Button variant="outline" loading={saveDraft.isPending} onClick={() => saveDraft.mutate()}>Save draft</Button><Button size="lg" loading={publish.isPending && !publish.variables} onClick={() => publish.mutate(undefined)}>Publish to website</Button></div>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Version history</CardTitle></CardHeader><CardContent>
        {history.isLoading && <Skeleton className="h-16" />}
        {history.data?.length === 0 && <p className="text-sm text-muted-foreground">No saved versions yet. Publishing or saving a draft creates one.</p>}
        <ul className="divide-y text-sm">{history.data?.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span><b className="capitalize">{v.status}</b> · {new Date(v.published_at ?? v.created_at).toLocaleString('en-KE')}{v.note ? ` · ${v.note}` : ''}</span>
            <span className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => load(v.content)}>Load</Button>{v.status !== 'published' && <Button size="sm" variant="outline" loading={publish.isPending && publish.variables === v.id} onClick={() => publish.mutate(v.id)}>Publish this</Button>}</span>
          </li>))}</ul>
      </CardContent></Card>
    </div>
  )
}
