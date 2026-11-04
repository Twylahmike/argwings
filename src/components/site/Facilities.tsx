import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { siteContent } from '~/lib/site-content'
import { buttonVariants } from '~/components/ui/button'
import { cn } from '~/lib/utils'

/** Optional full-width feature band (pool, rooftop, gym...). Fully driven by site-content.ts; hidden when empty. */
export function Facilities() {
  const f = siteContent.facility
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
  return (
    <section ref={ref} className="relative isolate flex min-h-[70svh] items-center justify-center overflow-hidden bg-ink text-white">
      {f.image && <img src={f.image} alt="" className="absolute inset-0 -z-20 h-full w-full object-cover" style={{ transform: `translateY(${y}px) scale(1.2)` }} loading="lazy" />}
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-ink/30 via-ink/40 to-ink/80" aria-hidden />
      <div className="px-6 py-24 text-center">
        {f.eyebrow && <p className="eyebrow mb-4 text-white/70">{f.eyebrow}</p>}
        <h2 className="font-display text-5xl font-medium md:text-7xl">{f.title}</h2>
        {f.body && <p className="mx-auto mt-6 max-w-xl text-lg text-white/85">{f.body}</p>}
        <Link to="/search" className={cn(buttonVariants({ size: 'lg' }), 'mt-8 rounded-full px-8')}>Book direct</Link>
      </div>
    </section>
  )
}
