import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { adminRpc } from '~/lib/membership-admin'
import { DEFAULT_APP_INSTALL, fillName, sanitizeAppInstall, type AppInstallSettings } from '~/lib/pwa'
import { DEFAULT_BACKGROUND, DEFAULT_THEME } from '~/lib/manifest'
import { errMessage } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Field, Input, Select, Textarea } from '~/components/ui/form'
import { ErrorState, Skeleton, Stat, TableWrap, td, th } from '~/components/ui/misc'
import { MediaPicker } from '~/components/media/MediaPicker'

type Stats = {
  impressions: number; clicks: number; accepted: number; declined: number; installed: number; ios_instructions: number; app_opens: number
  by_platform: { platform: string; impressions: number; clicks: number; installed: number }[]
}
const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—')

/** Settings > App installation: the invitation's text and switch, the app's branding, and what can honestly be measured. */
export function AppInstall() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['app-install-settings'], queryFn: async () => {
    const { data, error } = await sb().from('settings').select('value').eq('key', 'app_install').maybeSingle()
    if (error) throw error
    return sanitizeAppInstall(data?.value)
  } })
  const biz = useQuery({ queryKey: ['business-name'], queryFn: async () => {
    const { data } = await sb().from('settings').select('value').eq('key', 'business_name').maybeSingle()
    return typeof data?.value === 'string' && data.value ? (data.value as string) : 'RG Wings Stays'
  } })
  const [v, setV] = useState<AppInstallSettings>(DEFAULT_APP_INSTALL)
  const [picking, setPicking] = useState(false)
  const [err, setErr] = useState('')
  const [days, setDays] = useState('30')
  useEffect(() => { if (q.data) setV(q.data) }, [q.data])
  const set = (k: keyof AppInstallSettings) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }))
  const stats = useQuery({ queryKey: ['app-install-stats', days], queryFn: () => adminRpc<Stats>('app_install_stats', { p_days: Number(days) }) })
  const save = useMutation({
    mutationFn: async () => {
      setErr('')
      const hexOk = (x: string) => x === '' || /^#[0-9a-fA-F]{6}$/.test(x)
      if (!hexOk(v.themeColor) || !hexOk(v.backgroundColor)) throw new Error('Use colours like #a9761f.')
      if (v.headline.trim().length < 3 || v.description.trim().length < 10 || v.buttonText.trim().length < 2) throw new Error('Fill in the headline, description and button text.')
      const { error } = await sb().from('settings').upsert({ key: 'app_install', value: v, updated_at: new Date().toISOString() })
      if (error) throw error
    },
    onSuccess: () => { toast.success('Saved. The website and the app manifest pick this up within a few minutes.'); qc.invalidateQueries({ queryKey: ['app-install-settings'] }) },
    onError: (e) => setErr(errMessage(e)),
  })
  const name = biz.data ?? 'RG Wings Stays'
  const s = stats.data
  return (
    <div className="grid max-w-3xl gap-6">
      <Card><CardHeader><CardTitle>Install invitation</CardTitle></CardHeader><CardContent className="grid gap-4 text-sm">
        {q.isLoading && <Skeleton className="h-40" />}
        {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
        {q.data && <>
          <p className="text-muted-foreground">A popup that invites visitors to install the app. It appears on public pages every visit until the browser confirms the app is installed. Closing it never hides it for good. It stays out of the way on checkout, sign-in and sign-up pages. Use <code>{'{name}'}</code> to insert the business name.</p>
          <label className="flex items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={v.enabled} onChange={(e) => setV((x) => ({ ...x, enabled: e.target.checked }))} /> Show the install invitation</label>
          <Field label="Headline" htmlFor="ai-h"><Input id="ai-h" value={v.headline} onChange={set('headline')} maxLength={80} /></Field>
          <Field label="Description" htmlFor="ai-d"><Textarea id="ai-d" value={v.description} onChange={set('description')} maxLength={300} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Button text" htmlFor="ai-b"><Input id="ai-b" value={v.buttonText} onChange={set('buttonText')} maxLength={30} /></Field>
            <Field label="Small line under the button" htmlFor="ai-s"><Input id="ai-s" value={v.subtext} onChange={set('subtext')} maxLength={120} /></Field>
          </div>
          <div className="grid gap-2">
            <p className="font-medium">Promotional image (optional)</p>
            {v.image ? <img src={v.image} alt="" className="h-28 w-full max-w-sm rounded-lg border object-cover" /> : <p className="text-muted-foreground">No image. The popup shows the logo only.</p>}
            <div className="flex gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>Choose from media library</Button>{v.image && <Button type="button" variant="ghost" size="sm" onClick={() => setV((x) => ({ ...x, image: '' }))}>Remove</Button>}</div>
          </div>
          <div className="rounded-2xl p-5" style={{ background: 'hsl(var(--ink))', color: 'hsl(var(--ink-foreground))' }} aria-label="Preview">
            <p className="eyebrow text-brand">Preview · {name}</p>
            <p className="font-display mt-2 text-2xl">{fillName(v.headline, name)}</p>
            <p className="mt-2 text-xs opacity-80">{fillName(v.description, name)}</p>
            <span className="btn-brand mt-3 inline-flex h-10 items-center rounded-full px-6 text-xs font-semibold uppercase tracking-wider">{v.buttonText || 'Install app'}</span>
            <p className="mt-2 text-xs opacity-60">{fillName(v.subtext, name)}</p>
          </div>
          <h3 className="font-display text-xl">App branding</h3>
          <p className="text-muted-foreground">Shown on the home screen and in the app window. Leave a field empty to use the business name and brand colour. The app icons are fixed files (192 and 512 pixels, plus maskable versions); changing the icon image needs a new file in the website&rsquo;s <code>public</code> folder.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="App name" htmlFor="ai-n" hint={`Default: ${name}`}><Input id="ai-n" value={v.appName} onChange={set('appName')} maxLength={45} /></Field>
            <Field label="Short name (under the icon)" htmlFor="ai-sn" hint="Up to 12 characters."><Input id="ai-sn" value={v.shortName} onChange={set('shortName')} maxLength={12} /></Field>
            <Field label="Theme colour (status bar)" htmlFor="ai-t" hint={`Default: brand colour, else ${DEFAULT_THEME}`}><Input id="ai-t" value={v.themeColor} onChange={set('themeColor')} placeholder="#a9761f" /></Field>
            <Field label="Splash background colour" htmlFor="ai-bg" hint={`Default: ${DEFAULT_BACKGROUND}`}><Input id="ai-bg" value={v.backgroundColor} onChange={set('backgroundColor')} placeholder="#f7f1ec" /></Field>
          </div>
          {err && <p role="alert" className="text-danger">{err}</p>}
          <Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </>}
      </CardContent></Card>

      <Card><CardHeader><CardTitle>Installation numbers</CardTitle></CardHeader><CardContent className="grid gap-4 text-sm">
        <Field label="Period" htmlFor="ai-days"><Select id="ai-days" className="max-w-xs" value={days} onChange={(e) => setDays(e.target.value)}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></Select></Field>
        {stats.isLoading && <Skeleton className="h-24" />}
        {stats.error && <ErrorState error={stats.error} retry={() => stats.refetch()} />}
        {s && <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Invitations shown" value={s.impressions} hint="Page views where the popup appeared" />
            <Stat label="Install button presses" value={s.clicks} hint={`${pct(s.clicks, s.impressions)} of invitations`} />
            <Stat label="Installs reported by the browser" value={s.installed} hint="appinstalled event" />
            <Stat label="Accepted in the browser's prompt" value={s.accepted} hint="Android and desktop" />
            <Stat label="Declined in the browser's prompt" value={s.declined} />
            <Stat label="iPhone/iPad instruction views" value={s.ios_instructions} hint="Not installs" />
          </div>
          <p><b>Conversion:</b> {pct(s.installed, s.impressions)} of invitations shown and {pct(s.installed, s.clicks)} of button presses ended in an install the browser reported. People who opened the installed app: {s.app_opens} app opens.</p>
          {s.by_platform.length > 0 && <TableWrap>
            <thead><tr>{['Platform', 'Shown', 'Button presses', 'Installs reported'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
            <tbody className="divide-y">{s.by_platform.map((p) => <tr key={p.platform}><td className={td}>{p.platform}</td><td className={td}>{p.impressions}</td><td className={td}>{p.clicks}</td><td className={td}>{p.installed}</td></tr>)}</tbody>
          </TableWrap>}
          <p className="text-xs text-muted-foreground">These are anonymous counts of page views, not people. Browsers do not report every installation: iPhone and iPad never report one (so iOS installs cannot be counted, only instruction views and later app opens), and an install done from the browser menu without the popup is still reported by Chrome and Edge but not by every browser. Treat the install number as a lower bound.</p>
        </>}
      </CardContent></Card>
      {picking && <MediaPicker kind="image" onPick={(m) => { setV((x) => ({ ...x, image: m.url })); setPicking(false) }} onClose={() => setPicking(false)} />}
    </div>
  )
}
