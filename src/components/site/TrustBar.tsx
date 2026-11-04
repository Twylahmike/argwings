import { useEffect, useRef, useState } from 'react'
import { KeyRound, MessageCircle } from 'lucide-react'
import { useWhatsApp } from '~/lib/contact'

function Counter({ to, suffix = '' }: { to: number; suffix?: string }) {
  const [n, setN] = useState(to)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return
      io.disconnect()
      const t0 = performance.now()
      const tick = (t: number) => {
        const p = Math.min(1, (t - t0) / 1400)
        setN(Math.round(to * (1 - Math.pow(1 - p, 3))))
        if (p < 1) raf = requestAnimationFrame(tick)
      }
      setN(0)
      raf = requestAnimationFrame(tick)
    }, { threshold: 0.4 })
    io.observe(el)
    return () => { io.disconnect(); cancelAnimationFrame(raf) }
  }, [to])
  return <span ref={ref}>{n}{suffix}</span>
}

export function TrustBar() {
  const wa = useWhatsApp()
  const items = [
    { Icon: KeyRound, value: <Counter to={24} suffix="/7" />, label: 'Flexible Check-in & Check-out' },
    ...(wa('') ? [{ Icon: MessageCircle, value: <Counter to={100} suffix="%" />, label: 'Instant WhatsApp Response' }] : []),
  ]
  return (
    <div className="border-y bg-background">
      <div className={`mx-auto grid max-w-7xl gap-4 px-6 py-10 ${items.length > 1 ? 'md:grid-cols-2' : ''}`}>
        {items.map((it, i) => (
          <div key={i} className="text-center">
            <it.Icon className="mx-auto mb-2 h-8 w-8 text-brand" aria-hidden />
            <div className="font-display text-2xl font-semibold text-brand">{it.value}</div>
            <div className="mt-1 text-xs text-muted-foreground md:text-sm">{it.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
