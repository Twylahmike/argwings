import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ImagePlus } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { uploadImage } from '~/lib/images'
import { errMessage } from '~/lib/utils'
import { DEFAULT_SITE_CONTENT, sanitizeSiteContent, type SiteContent } from '~/lib/site-content'
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

  const save = useMutation({
    mutationFn: async () => {
      const clean = sanitizeSiteContent({
        ...c,
        tickerItems: ticker.split('\n'),
      })
      const { error } = await sb().from('settings').upsert({ key: KEY, value: clean, updated_at: new Date().toISOString() })
      if (error) throw error
    },
    onSuccess: () => { toast.success('Website content saved'); qc.invalidateQueries({ queryKey: ['site-content'] }); setTimeout(() => window.location.reload(), 600) },
    onError: (e) => toast.error(errMessage(e)),
  })

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
      <div><Button size="lg" loading={save.isPending} onClick={() => save.mutate()}>Save website content</Button></div>
    </div>
  )
}
