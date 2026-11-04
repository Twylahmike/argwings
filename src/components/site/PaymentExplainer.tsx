import { useState } from 'react'
import { Landmark, Smartphone } from 'lucide-react'
import { useBrand } from '~/lib/brand'
import { SearchBar } from '~/components/booking/SearchBar'

type CardDef = { Icon: typeof Smartphone; title: string; front: string; back: string[] }

function FlipCard({ c }: { c: CardDef }) {
  const [flipped, setFlipped] = useState(false)
  return (
    <div className="flip-card h-60" data-flipped={flipped}>
      <button type="button" onClick={() => setFlipped((f) => !f)} aria-pressed={flipped} className="flip-inner block h-full w-full text-left" aria-label={`${c.title}: ${flipped ? 'show summary' : 'show details'}`}>
        <span className="flip-face flex flex-col items-center justify-center rounded-2xl bg-card p-8 text-center text-foreground shadow-xl">
          <c.Icon className="mb-3 h-10 w-10 text-brand" aria-hidden />
          <span className="font-display text-2xl">{c.title}</span>
          <span className="mt-2 text-sm text-muted-foreground">{c.front}</span>
          <span className="mt-4 text-xs text-brand">Tap or hover for details</span>
        </span>
        <span className="flip-face flip-back flex flex-col items-center justify-center rounded-2xl bg-ink p-8 text-center text-ink-foreground">
          <span className="mb-4 font-display text-2xl">{c.title}</span>
          <span className="space-y-2 text-sm">{c.back.map((b) => <span key={b} className="block">{b}</span>)}</span>
        </span>
      </button>
    </div>
  )
}

/** Explains how paying works (no card-payment claims: the backend only does M-Pesa) and hands off to the real search. */
export function PaymentExplainer() {
  const { depositPercent, holdMinutes, mpesaPaybillDisplay } = useBrand()
  const cards: CardDef[] = [
    { Icon: Smartphone, title: 'M-Pesa deposit', front: `Pay ${depositPercent}% to secure your dates`, back: [`Approve the prompt on your phone`, `Dates are held for ${holdMinutes} minutes while you pay`, 'Confirmed the moment it lands'] },
    { Icon: Landmark, title: 'Pay the balance', front: 'Settle the rest before you arrive', back: ['Pay from your booking page with M-Pesa', ...(mpesaPaybillDisplay ? [`Or Paybill/Till ${mpesaPaybillDisplay}, using your booking reference`] : ['Or pay manually using your booking reference']), 'A receipt is saved to your booking page'] },
  ]
  return (
    <section id="book-direct" className="scroll-mt-16 bg-brand px-4 py-20 text-brand-foreground sm:px-6 md:py-28" aria-labelledby="pay-h">
      <div className="mx-auto max-w-6xl">
        <div className="mb-12 text-center">
          <h2 id="pay-h" className="section-title mb-4">Reserve your stay.</h2>
          <p className="mx-auto max-w-xl opacity-85">Book directly with us. Pay on your phone, and see your confirmation immediately.</p>
        </div>
        <div className="mb-12 grid gap-6 md:grid-cols-2">{cards.map((c) => <FlipCard key={c.title} c={c} />)}</div>
        <div className="mx-auto max-w-4xl rounded-2xl bg-card p-5 text-foreground shadow-2xl sm:p-8">
          <h3 className="mb-4 text-center font-display text-2xl text-brand">Check availability</h3>
          <SearchBar />
        </div>
      </div>
    </section>
  )
}
