import { useEffect, useRef, useState } from 'react'
import { Clock, MessageCircle, Smartphone } from 'lucide-react'
import { useBrand } from '~/lib/brand'
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
        const p = Math.min(1, (t - t0) / 1200)
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

/** Facts only: every figure comes from Admin > Settings (deposit %, hold minutes), never from invented statistics. */
export function TrustBar() {
  const { depositPercent, holdMinutes } = useBrand()
  const wa = useWhatsApp()
  const items = [
    { Icon: Smartphone, value: <Counter to={depositPercent} suffix="%" />, label: 'Deposit secures your dates, paid by M-Pesa' },
    { Icon: Clock, value: <Counter to={holdMinutes} suffix=" min" />, label: 'Your dates are held while you pay' },
    ...(wa('') ? [{ Icon: MessageCircle, value: <span>WhatsApp</span>, label: 'Questions? Real people reply on WhatsApp' }] : []),
  ]
  return (
    <div className="border-y bg-muted/50">
      <div className={`mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:px-6 ${items.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
        {items.map((it, i) => (
          <div key={i} className="text-center">
            <it.Icon className="mx-auto mb-2 h-7 w-7 text-brand" aria-hidden />
            <div className="font-display text-3xl font-semibold text-brand">{it.value}</div>
            <div className="mt-1 text-sm text-muted-foreground">{it.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
