import { useState } from 'react'
import { toast } from 'sonner'
import { pub } from '~/lib/public-client'
import { useBrand } from '~/lib/brand'
import { useWhatsApp } from '~/lib/contact'
import { errMessage } from '~/lib/utils'
import { todayNairobi } from '~/lib/dates'

const field = 'h-12 w-full rounded-lg border bg-card px-4 text-sm text-foreground placeholder:text-muted-foreground'

/** Contact form: creates a real inquiry that the team sees in Admin > Inquiries. */
export function InquiryForm() {
  const { spaces } = useBrand()
  const wa = useWhatsApp()
  const waHref = wa('Hi, I have a question about booking a stay.')
  const [v, setV] = useState({ name: '', phone: '', email: '', message: '', property: '', inDate: '', outDate: '', guests: '', website: '' })
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }))
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (v.inDate && v.outDate && v.outDate <= v.inDate) return toast.error('Check-out must be after check-in.')
    setBusy(true)
    try {
      const { error } = await pub().rpc('submit_inquiry', {
        p_name: v.name, p_phone: v.phone, p_email: v.email || null, p_message: v.message,
        p_property: v.property || null, p_in: v.inDate || null, p_out: v.outDate || null, p_guests: v.guests ? Number(v.guests) : null, p_website: v.website,
      })
      if (error) throw error
      setDone(true)
    } catch (err) { toast.error(errMessage(err)) } finally { setBusy(false) }
  }
  return (
    <section id="contact" className="scroll-mt-16 bg-background px-6 py-24" aria-labelledby="contact-h">
      <div className="mx-auto max-w-2xl">
        <div className="mb-10 text-center">
          <p className="eyebrow mb-3 text-muted-foreground">Contact</p>
          <h2 id="contact-h" className="section-title text-brand">Have a question?</h2>
          <p className="mt-4 text-muted-foreground">Send us a message and we will get back to you.{waHref && <> Prefer WhatsApp? <a className="text-brand underline" href={waHref} target="_blank" rel="noreferrer">Chat with us</a>.</>}</p>
        </div>
        {done ? (
          <div className="rounded-2xl border bg-card p-8 text-center" role="status">
            <p className="font-display text-2xl text-brand">Thank you!</p>
            <p className="mt-2 text-muted-foreground">We received your message and will reply on the number you gave.</p>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4 rounded-2xl border bg-card p-6 shadow-lg sm:p-8">
            <div className="grid gap-4 sm:grid-cols-2">
              <input className={field} placeholder="Your name" aria-label="Your name" required minLength={2} maxLength={80} value={v.name} onChange={set('name')} autoComplete="name" />
              <input className={field} placeholder="Phone (e.g. 0712 345 678)" aria-label="Phone number" required inputMode="tel" value={v.phone} onChange={set('phone')} autoComplete="tel" />
            </div>
            <input className={field} type="email" placeholder="Email (optional)" aria-label="Email" maxLength={120} value={v.email} onChange={set('email')} autoComplete="email" />
            <div className="grid gap-4 sm:grid-cols-3">
              {spaces.length > 0 && <select className={field} aria-label="Property" value={v.property} onChange={set('property')}><option value="">Any property</option>{spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
              <input className={field} type="date" aria-label="Check-in (optional)" min={todayNairobi()} value={v.inDate} onChange={set('inDate')} />
              <input className={field} type="date" aria-label="Check-out (optional)" min={v.inDate || todayNairobi()} value={v.outDate} onChange={set('outDate')} />
            </div>
            <textarea className="w-full rounded-lg border bg-card px-4 py-3 text-sm placeholder:text-muted-foreground" rows={4} placeholder="Your message" aria-label="Your message" required minLength={2} maxLength={2000} value={v.message} onChange={set('message')} />
            {/* Honeypot: real visitors never see or fill this. */}
            <input tabIndex={-1} autoComplete="off" aria-hidden className="absolute left-[-9999px] h-0 w-0 opacity-0" name="website" value={v.website} onChange={set('website')} />
            <button disabled={busy} className="btn-brand w-full rounded-full py-3.5 text-sm font-medium disabled:opacity-60">{busy ? 'Sending...' : 'Send message'}</button>
          </form>
        )}
      </div>
    </section>
  )
}
