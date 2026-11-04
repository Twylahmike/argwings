const steps: [string, string, string][] = [
  ['🏠', 'Book Direct', 'Click the Book Direct button'],
  ['📅', 'Choose Your Dates', 'Select your preferred check-in and check-out dates'],
  ['✅', 'Check Availability', 'Confirm your dates are open'],
  ['🔑', 'Reserve Your Stay', 'Complete your booking'],
]

export function HowToBook() {
  return (
    <section className="bg-background px-6 py-24" aria-labelledby="how-h">
      <div className="mx-auto max-w-6xl text-center">
        <p className="eyebrow mb-3 text-muted-foreground">Process</p>
        <h2 id="how-h" className="section-title mb-16 text-brand">Booking Is Simple.</h2>
        <ol className="relative grid gap-12 md:grid-cols-4 md:gap-8">
          {steps.map(([icon, title, desc], i) => (
            <li key={title} className="animate-fade-up relative" style={{ animationDelay: `${i * 0.15}s` }}>
              <span className="relative mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-brand text-3xl text-brand-foreground shadow-lg" aria-hidden>
                {icon}
                <span className="absolute -right-2 -top-2 flex h-8 w-8 items-center justify-center rounded-full bg-olive text-sm font-medium text-white">{i + 1}</span>
              </span>
              {i < steps.length - 1 && <span className="absolute left-[calc(50%+50px)] right-[-50%] top-10 hidden h-[2px] origin-left bg-olive/40 md:block" aria-hidden style={{ animation: `draw-line 1s ${0.4 + i * 0.15}s both` }} />}
              <h3 className="mb-2 font-display text-xl">{title}</h3>
              <p className="text-sm text-muted-foreground">{desc}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
