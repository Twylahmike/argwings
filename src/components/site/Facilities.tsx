import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useBrand } from '~/lib/brand'
import { parseHeadline } from '~/lib/site-content'
import { photoByLabel } from '~/lib/stay-photos'

/** Optional full-width feature band (pool, rooftop, gym...). Fully driven by site-content.ts; hidden when empty. */
export function Facilities() {
  const f = useBrand().site.facility
  const ref = useRef<HTMLElement>(null)
  const [y, setY] = useState(0)
  useEffect(() => {
    if (!f.title || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const on = () => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setY((r.top + r.height / 2 - window.innerHeight / 2) * -0.2)
    }
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [f.title])
  if (!f.title) return null
  const image = f.image || photoByLabel('Pool')
  return (
    <section ref={ref} className="relative isolate flex min-h-[70svh] items-center justify-center overflow-hidden bg-ink text-white">
      {image && <img src={image} alt="" className="absolute inset-0 -z-20 h-full w-full object-cover" style={{ transform: `translateY(${y}px) scale(1.2)` }} loading="lazy" />}
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-ink/30 via-ink/40 to-ink/80" aria-hidden />
      <span className="absolute left-1/4 top-1/2 -z-10 h-32 w-32 rounded-full border border-white/30" style={{ animation: 'ripple 6s ease-out infinite' }} aria-hidden />
      <span className="absolute right-1/3 top-1/3 -z-10 h-24 w-24 rounded-full border border-white/30" style={{ animation: 'ripple 7s 2s ease-out infinite' }} aria-hidden />
      <div className="px-6 py-24 text-center">
        {f.eyebrow && <p className="eyebrow mb-4 text-white/70">{f.eyebrow}</p>}
        <h2 className="font-display text-5xl font-light md:text-8xl">{parseHeadline(f.title).map((t, k) => t.accent ? <em key={k} className="italic text-brand-glow">{t.text}</em> : <span key={k}>{t.text}</span>)}</h2>
        {f.body && <p className="mx-auto mt-6 max-w-xl text-lg text-white/85">{f.body}</p>}
        <Link to="/search" className="btn-brand mt-8 inline-block rounded-full px-8 py-4 text-sm font-medium">Book direct &rarr;</Link>
      </div>
    </section>
  )
}
