import { CalendarSearch, CheckCircle2, Home, Smartphone } from 'lucide-react'

const steps = [
  { Icon: CalendarSearch, title: 'Choose your dates', text: 'Enter check-in, check-out and guests. We show what is free, with the full price.' },
  { Icon: Home, title: 'Pick your place', text: 'Choose the property and room that suits you and review the details.' },
  { Icon: Smartphone, title: 'Pay the deposit', text: 'Approve the M-Pesa prompt on your phone. Your dates are held while you pay.' },
  { Icon: CheckCircle2, title: 'Get confirmed', text: 'Your booking page and receipt are ready straight away. Pay the balance before you arrive.' },
]

export function HowToBook() {
  return (
    <section className="bg-background px-4 py-20 sm:px-6 md:py-28" aria-labelledby="how-h">
      <div className="mx-auto max-w-6xl text-center">
        <p className="eyebrow mb-3 text-brand">Process</p>
        <h2 id="how-h" className="section-title mb-16 text-brand">Booking is simple.</h2>
        <ol className="relative grid gap-12 md:grid-cols-4 md:gap-8">
          {steps.map(({ Icon, title, text }, i) => (
            <li key={title} className="animate-fade-up relative" style={{ animationDelay: `${i * 0.12}s` }}>
              <span className="relative mx-auto mb-5 grid h-20 w-20 place-items-center rounded-full bg-brand text-brand-foreground shadow-lg">
                <Icon className="h-8 w-8" aria-hidden />
                <span className="absolute -right-2 -top-2 grid h-8 w-8 place-items-center rounded-full bg-ink text-sm font-medium text-ink-foreground">{i + 1}</span>
              </span>
              {i < steps.length - 1 && <span className="absolute left-[calc(50%+3.5rem)] right-[-50%] top-10 hidden h-[2px] origin-left bg-brand/30 md:block" aria-hidden style={{ animation: `draw-line 1s ${0.4 + i * 0.15}s both` }} />}
              <h3 className="font-display text-2xl">{title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
