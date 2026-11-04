import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useBrand } from '~/lib/brand'
import { SearchBar } from '~/components/booking/SearchBar'
import { buttonVariants } from '~/components/ui/button'
import { cn } from '~/lib/utils'
import { parseHeadline, siteContent } from '~/lib/site-content'
import { heroSlides } from '~/lib/gallery'
import type { PropertyWithUnits } from '~/lib/public-api'

export function Hero({ properties }: { properties: PropertyWithUnits[] }) {
  const brand = useBrand()
  const slides = heroSlides(properties)
  const [i, setI] = useState(0)
  useEffect(() => {
    if (slides.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = setInterval(() => setI((p) => (p + 1) % slides.length), 5500)
    return () => clearInterval(t)
  }, [slides.length])
  // Word-by-word entrance, with the accent word in italics.
  const words = parseHeadline(siteContent.heroHeadline).flatMap((part) => part.text.split(/\s+/).filter(Boolean).map((w) => ({ w, accent: part.accent })))
  const ticker = siteContent.tickerItems
  return (
    <section className="relative isolate flex min-h-[100svh] w-full flex-col justify-center overflow-hidden bg-ink text-white">
      {slides.map((s, idx) => (
        <div key={s.src} className={cn('absolute inset-0 -z-20 transition-opacity duration-[2000ms]', i === idx ? 'opacity-100' : 'opacity-0')} aria-hidden={i !== idx}>
          <img src={s.src} alt="" className={cn('h-full w-full object-cover', i === idx && 'animate-ken')} loading={idx === 0 ? 'eager' : 'lazy'} fetchPriority={idx === 0 ? 'high' : undefined} />
        </div>
      ))}
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-ink/60 via-ink/40 to-ink/80" aria-hidden />
      <div className="relative mx-auto flex w-full max-w-5xl flex-col items-center px-4 pb-24 pt-28 text-center sm:px-6">
        <p className="eyebrow animate-fade-in mb-5 text-white/80" style={{ animationDelay: '.2s' }}>{brand.businessName}</p>
        <h1 className="font-display text-5xl font-medium leading-[1.05] sm:text-6xl md:text-7xl lg:text-8xl">
          {words.map((x, idx) => (
            <span key={idx} className={cn('word-in mr-[0.25em] inline-block', x.accent && 'italic text-brand-glow')} style={{ animationDelay: `${0.35 + idx * 0.18}s` }}>{x.w}</span>
          ))}
        </h1>
        <div className="mt-3 h-[3px] w-40 origin-left scale-x-0 bg-brand-glow" style={{ animation: 'draw-line 1s 1.2s cubic-bezier(.16,1,.3,1) forwards' }} aria-hidden />
        {siteContent.heroSubline && <p className="animate-fade-in mt-6 max-w-2xl text-base text-white/85 md:text-lg" style={{ animationDelay: '1.4s' }}>{siteContent.heroSubline}</p>}
        <div className="animate-fade-up mt-8 flex flex-col gap-3 sm:flex-row" style={{ animationDelay: '1.6s' }}>
          <Link to="/" hash="properties" className={cn(buttonVariants({ size: 'lg' }), 'rounded-full bg-white px-8 text-ink hover:bg-white/90')}>View our properties</Link>
          <Link to="/search" className={cn(buttonVariants({ size: 'lg' }), 'rounded-full px-8')}>Book direct</Link>
        </div>
        <div className="animate-fade-up mt-10 w-full max-w-4xl text-left text-foreground" style={{ animationDelay: '1.8s' }}><SearchBar /></div>
      </div>
      {ticker.length > 0 && (
        <div className="absolute inset-x-0 bottom-0 overflow-hidden border-t border-white/10 bg-ink/60 py-3 backdrop-blur-sm" aria-hidden>
          <div className="scroll-ticker flex w-max whitespace-nowrap">
            {[0, 1].map((k) => (
              <div key={k} className="flex items-center gap-8 px-4 text-sm tracking-wider text-white/80">
                {[...ticker, ...ticker].map((t, j) => <span key={j} className="flex items-center gap-8"><span className="text-brand-glow">&#10022;</span>{t}</span>)}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
