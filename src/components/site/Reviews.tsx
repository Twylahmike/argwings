import { Star } from 'lucide-react'
import { useBrand } from '~/lib/brand'

/** Guest reviews from site-content.ts. Hidden when there are none (we never invent reviews). */
export function Reviews() {
  const list = useBrand().site.reviews
  if (!list.length) return null
  const marquee = list.length >= 3
  const card = (r: (typeof list)[number], key: string, hidden = false) => (
    <article key={key} aria-hidden={hidden || undefined} className="w-[300px] shrink-0 rounded-xl border-l-4 border-olive bg-card p-6 shadow-md sm:w-[340px]">
      <div className="mb-3 flex gap-1" aria-label={`${r.rating} out of 5`}>{Array.from({ length: r.rating }).map((_, j) => <Star key={j} className="h-4 w-4 fill-brand text-brand" aria-hidden />)}</div>
      <p className="text-sm italic leading-relaxed">&ldquo;{r.quote}&rdquo;</p>
      <p className="mt-4 text-sm font-medium">{r.guest}</p>
      {r.stay && <p className="text-xs text-muted-foreground">{r.stay}</p>}
    </article>
  )
  return (
    <section className="overflow-hidden bg-background py-24" aria-labelledby="rev-h">
      <div className="mx-auto mb-12 max-w-7xl px-4 text-center sm:px-6">
        <p className="eyebrow mb-3 text-olive">Guest book</p>
        <h2 id="rev-h" className="section-title text-brand">What our guests say.</h2>
      </div>
      {marquee
        ? <div className="scroll-reviews flex w-max gap-6 px-3">{[...list.map((r) => card(r, r.id)), ...list.map((r) => card(r, `${r.id}-d`, true))]}</div>
        : <div className="mx-auto flex max-w-5xl flex-wrap justify-center gap-6 px-4">{list.map((r) => card(r, r.id))}</div>}
    </section>
  )
}
