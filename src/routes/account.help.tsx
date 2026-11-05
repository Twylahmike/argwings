import { createFileRoute, Link } from '@tanstack/react-router'
import { useBrand, waLink } from '~/lib/brand'
import { Button } from '~/components/ui/button'

export const Route = createFileRoute('/account/help')({ component: Help })

function Help() {
  const brand = useBrand()
  const email = brand.businessEmail || brand.site.contactEmail
  return (
    <div className="grid max-w-2xl gap-6">
      <h1 className="font-display text-4xl">Help and support</h1>
      <section className="grid gap-3 rounded-xl border bg-card p-5 text-sm">
        <h2 className="font-display text-2xl">Talk to us</h2>
        {brand.supportWhatsapp && <Button asChild className="justify-self-start"><a href={waLink(brand.supportWhatsapp, `Hello ${brand.businessName}, I need help with my account.`)} target="_blank" rel="noopener noreferrer">Chat on WhatsApp</a></Button>}
        {brand.contacts.map((c) => <p key={c.id}><b>{c.label}:</b> <a className="underline" href={`tel:+${c.phone}`}>+{c.phone}</a>{c.note ? <span className="text-muted-foreground"> · {c.note}</span> : null}</p>)}
        {email && <p><b>Email:</b> <a className="underline" href={`mailto:${email}`}>{email}</a></p>}
        {brand.businessAddress && <p className="text-muted-foreground">{brand.businessAddress}</p>}
      </section>
      <section className="grid gap-2 rounded-xl border bg-card p-5 text-sm">
        <h2 className="font-display text-2xl">Good to know</h2>
        <p><b>Changing or cancelling a booking:</b> use <Link to="/account/bookings" search={{ tab: 'upcoming' }} className="underline">Upcoming stays</Link> and tap Request change or Request cancellation.</p>
        <p><b>Cancellation policy:</b> {brand.cancellationPolicy}</p>
        <p><b>Offers:</b> member offers are applied at checkout when you are signed in. Each has its own conditions and expiry, shown in <Link to="/account/offers" className="underline">My offers</Link>.</p>
        <p><b>Booked earlier without an account?</b> Add it from <Link to="/account/bookings" search={{ tab: 'all' }} className="underline">My bookings</Link> with its reference and phone number.</p>
      </section>
    </div>
  )
}
