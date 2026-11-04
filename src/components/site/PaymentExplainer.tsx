import { useState } from 'react'
import { SearchBar } from '~/components/booking/SearchBar'
import { useBrand } from '~/lib/brand'

type CardDef = { icon: string; title: string; front: string; back: string[] }

function FlipCard({ c }: { c: CardDef }) {
  const [flipped, setFlipped] = useState(false)
  return (
    <div className="flip-card h-56" data-flipped={flipped}>
      <button type="button" onClick={() => setFlipped((f) => !f)} aria-pressed={flipped} className="flip-inner block h-full w-full text-left" aria-label={`${c.title}: ${flipped ? 'show summary' : 'show details'}`}>
        <span className="flip-face flex flex-col items-center justify-center rounded-2xl bg-card p-8 text-center text-foreground shadow-xl">
          <span className="mb-3 text-5xl" aria-hidden>{c.icon}</span>
          <span className="font-display text-2xl">{c.title}</span>
          <span className="mt-2 text-sm text-muted-foreground">{c.front}</span>
          <span className="mt-4 text-xs text-brand">Tap or hover for details</span>
        </span>
        <span className="flip-face flip-back flex flex-col items-center justify-center rounded-2xl bg-ink p-8 text-center text-ink-foreground">
          <span className="mb-4 font-display text-2xl text-brand-glow">{c.title}</span>
          <span className="space-y-2 text-sm">{c.back.map((b) => <span key={b} className="block">{b}</span>)}</span>
        </span>
      </button>
    </div>
  )
}

/** The original's payment cards, with the real booking flow underneath (no personal send-money number is shown). */
export function PaymentExplainer() {
  const { depositPercent, holdMinutes, mpesaPaybillDisplay } = useBrand()
  const cards: CardDef[] = [
    { icon: '📱', title: 'M-Pesa', front: `Pay ${depositPercent}% to secure your dates`, back: ['Approve the M-Pesa prompt on your phone', `Dates are held for ${holdMinutes} minutes while you pay`, ...(mpesaPaybillDisplay ? [`Or Paybill/Till ${mpesaPaybillDisplay}`] : []), 'Instant confirmation'] },
    { icon: '💳', title: 'Card Payment', front: 'Visa, Mastercard accepted', back: ['Secure card link sent on WhatsApp', 'Instant confirmation', 'Receipt emailed'] },
  ]
  return (
    <section id="book-direct" className="scroll-mt-16 bg-brand px-6 py-24 text-brand-foreground" aria-labelledby="pay-h">
      <div className="mx-auto max-w-6xl">
        <div className="mb-14 text-center">
          <h2 id="pay-h" className="section-title mb-4">Reserve Your Stay.</h2>
          <p className="mx-auto max-w-xl opacity-85">Book directly with us for the best rates and a personal experience 😊</p>
        </div>
        <div className="mb-12 grid gap-6 md:grid-cols-2">{cards.map((c) => <FlipCard key={c.title} c={c} />)}</div>
        <div className="mx-auto max-w-3xl rounded-2xl bg-card p-6 text-foreground shadow-2xl sm:p-8">
          <h3 className="mb-6 text-center font-display text-2xl text-brand">Request Your Booking</h3>
          <SearchBar />
        </div>
      </div>
    </section>
  )
}
