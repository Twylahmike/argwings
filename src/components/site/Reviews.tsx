import { useState } from 'react'
import { Star } from 'lucide-react'
import { toast } from 'sonner'
import { useBrand } from '~/lib/brand'
import { pub } from '~/lib/public-client'
import { errMessage } from '~/lib/utils'

const field = 'h-12 w-full rounded-lg border bg-background px-4 text-sm placeholder:text-muted-foreground'

/** Approved guest reviews (managed in Admin > Reviews) plus a form for guests to add theirs (held for approval). */
export function Reviews() {
  const { site, spaces } = useBrand()
  const list = site.reviews
  const [open, setOpen] = useState(false)
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [v, setV] = useState({ name: '', stay: '', property: '', rating: 5, body: '', website: '' })
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const { error } = await pub().rpc('submit_review', { p_name: v.name, p_stay: v.stay || null, p_property: v.property || null, p_rating: v.rating, p_body: v.body, p_website: v.website })
      if (error) throw error
      setSent(true); setOpen(false)
      toast.success('Thank you! Your review will appear after we approve it.')
    } catch (err) { toast.error(errMessage(err)) } finally { setBusy(false) }
  }
  const marquee = list.length >= 3
  const card = (r: (typeof list)[number], key: string, hidden = false) => (
    <article key={key} aria-hidden={hidden || undefined} className="w-[300px] shrink-0 rounded-xl border-l-4 border-brand bg-card p-6 shadow-md sm:w-[340px]">
      <div className="mb-3 flex gap-1" aria-label={`${r.rating} out of 5`}>{Array.from({ length: r.rating }).map((_, j) => <Star key={j} className="h-4 w-4 fill-brand text-brand" aria-hidden />)}</div>
      <p className="text-sm italic leading-relaxed">&ldquo;{r.quote}&rdquo;</p>
      <p className="mt-4 text-sm font-medium">{r.guest}</p>
      {r.stay && <p className="text-xs text-muted-foreground">{r.stay}</p>}
      {r.response && <p className="mt-3 rounded-md bg-muted p-2 text-xs"><b>Our reply:</b> {r.response}</p>}
    </article>
  )
  return (
    <section className="overflow-hidden bg-background py-24" aria-labelledby="rev-h">
      <div className="mx-auto mb-12 max-w-7xl px-6 text-center">
        <p className="eyebrow mb-3 text-muted-foreground">Guest book</p>
        <h2 id="rev-h" className="section-title text-brand">What our guests say.</h2>
      </div>
      {list.length > 0 && (marquee
        ? <div className="scroll-reviews flex w-max gap-6 px-3">{[...list.map((r) => card(r, r.id)), ...list.map((r) => card(r, `${r.id}-d`, true))]}</div>
        : <div className="mx-auto flex max-w-5xl flex-wrap justify-center gap-6 px-4">{list.map((r) => card(r, r.id))}</div>)}
      <div className="mt-10 text-center">
        {sent ? <p className="text-sm text-muted-foreground" role="status">Thanks, we will review it shortly.</p>
          : <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="btn-olive rounded-full px-8 py-3 text-sm">{open ? 'Close form' : list.length ? 'Leave a review' : 'Be the first to leave a review'}</button>}
      </div>
      {open && (
        <form onSubmit={submit} className="mx-auto mt-8 grid max-w-xl gap-4 rounded-2xl border bg-card p-6" style={{ animation: 'fade-up .5s both' }}>
          <input className={field} placeholder="Your name" aria-label="Your name" required minLength={2} maxLength={60} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
          <div className="grid gap-4 sm:grid-cols-2">
            <input className={field} placeholder="When you stayed (optional)" aria-label="When you stayed" maxLength={80} value={v.stay} onChange={(e) => setV({ ...v, stay: e.target.value })} />
            {spaces.length > 0 && <select className={field} aria-label="Property" value={v.property} onChange={(e) => setV({ ...v, property: e.target.value })}><option value="">Which property?</option>{spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
          </div>
          <div className="flex gap-1" role="radiogroup" aria-label="Rating">
            {[1, 2, 3, 4, 5].map((n) => <button type="button" key={n} role="radio" aria-checked={v.rating === n} aria-label={`${n} star${n === 1 ? '' : 's'}`} onClick={() => setV({ ...v, rating: n })} className="p-1"><Star className={`h-7 w-7 ${n <= v.rating ? 'fill-brand text-brand' : 'text-muted-foreground'}`} aria-hidden /></button>)}
          </div>
          <textarea className="w-full rounded-lg border bg-background px-4 py-3 text-sm placeholder:text-muted-foreground" rows={4} placeholder="Share your experience" aria-label="Your review" required minLength={5} maxLength={1000} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} />
          <input tabIndex={-1} autoComplete="off" aria-hidden className="absolute left-[-9999px] h-0 w-0 opacity-0" name="website" value={v.website} onChange={(e) => setV({ ...v, website: e.target.value })} />
          <button disabled={busy} className="btn-brand w-full rounded-full py-3 text-sm disabled:opacity-60">{busy ? 'Sending...' : 'Submit review'}</button>
        </form>
      )}
    </section>
  )
}
