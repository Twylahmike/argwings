import { ShieldCheck } from 'lucide-react'
import { useBrand } from '~/lib/brand'
import { useWhatsApp } from '~/lib/contact'

/** Kept from the existing home page: real answers about the real booking flow. */
export function Faq() {
  const brand = useBrand()
  const wa = useWhatsApp()
  const qa: [string, string][] = [
    ['How do I pay?', 'With M-Pesa. After you choose your dates we send a prompt to your phone; enter your PIN to pay the deposit. You can pay the balance the same way from your booking page, or by Paybill/Till.'],
    ['Is my booking confirmed straight away?', `Yes. As soon as the deposit arrives your booking turns Confirmed. Until then your dates are held for ${brand.holdMinutes} minutes.`],
    ['What if I need to cancel?', brand.cancellationPolicy],
    ...(wa('') ? [['Can I book on WhatsApp instead?', 'Of course. Tap "Book on WhatsApp" on any place and we will open a chat with your dates and price filled in.'] as [string, string]] : []),
    ['Is my information safe?', 'We only keep what we need to host you (name, phone, email) and never sell it. You can ask us to delete it at any time.'],
  ]
  return (
    <section className="bg-background px-4 py-20 sm:px-6 md:py-24" aria-labelledby="faq">
      <div className="mx-auto max-w-3xl">
        <h2 id="faq" className="section-title mb-8 text-center text-brand">Questions guests ask</h2>
        <div className="divide-y rounded-xl border bg-card">
          {qa.map(([q, a]) => (
            <details key={q} className="group px-4 py-3">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-medium">{q}<span aria-hidden className="text-xl text-muted-foreground transition-transform group-open:rotate-45">+</span></summary>
              <p className="pb-2 text-sm text-muted-foreground">{a}</p>
            </details>
          ))}
        </div>
        <p className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground"><ShieldCheck className="h-4 w-4" aria-hidden /> Payments go through Safaricom M-Pesa. We never see your PIN.</p>
      </div>
    </section>
  )
}
