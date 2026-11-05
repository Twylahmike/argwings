import { Link } from '@tanstack/react-router'
import { Mail, MapPin, MessageCircle, Phone } from 'lucide-react'
import { Wordmark } from '~/components/layout/Wordmark'
import { InstallAppButton } from './InstallAppButton'
import { MembershipNudge } from './MembershipPromo'
import { useBrand } from '~/lib/brand'
import { useWhatsApp } from '~/lib/contact'
import { normalizePhone, formatPhoneLocal } from '~/lib/phone'
import { safeUrl } from '~/lib/site-content'

const dot = 'flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-xs font-bold transition hover:bg-brand hover:text-brand-foreground'

export function SiteFooter() {
  const brand = useBrand()
  const wa = useWhatsApp()
  const waHref = wa('Hello!')
  const c = brand.site
  const n = brand.supportWhatsapp ? normalizePhone(brand.supportWhatsapp) : null
  const shown = n && n.ok ? formatPhoneLocal(n.phone) : ''
  const socials = [
    { label: 'Instagram', short: 'IG', href: safeUrl(c.social.instagram) },
    { label: 'Facebook', short: 'FB', href: safeUrl(c.social.facebook) },
    { label: 'TikTok', short: 'TT', href: safeUrl(c.social.tiktok) },
    { label: 'X', short: 'X', href: safeUrl(c.social.x) },
  ].filter((s) => s.href)
  return (
    <footer className="relative overflow-hidden bg-ink text-ink-foreground">
      <div className="absolute inset-0 opacity-[0.04]" aria-hidden style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)', backgroundSize: '24px 24px' }} />
      <div className="relative mx-auto grid max-w-7xl gap-10 px-6 py-16 md:grid-cols-4">
        <div>
          <Wordmark className="h-20 rounded-lg" />
          <p className="sr-only">{brand.businessName}</p>
          {c.tagline && <p className="mt-3 text-sm italic opacity-70">{c.tagline}</p>}
          <div className="mt-4 h-1 w-16 rounded-full bg-brand" style={{ boxShadow: '0 0 20px hsl(var(--brand) / 0.7)' }} aria-hidden />
          {socials.length > 0 && <div className="mt-5 flex gap-3">{socials.map((s) => <a key={s.label} href={s.href!} target="_blank" rel="noreferrer" aria-label={s.label} className={dot}>{s.short}</a>)}</div>}
        </div>
        <div>
          <h2 className="mb-4 font-display text-lg text-brand-glow">Quick links</h2>
          <ul className="space-y-1 text-sm opacity-80">
            <li><Link to="/" className="inline-flex h-9 items-center hover:text-brand-glow">Home</Link></li>
            <li><Link to="/spaces" className="inline-flex h-9 items-center hover:text-brand-glow">Our spaces</Link></li>
            <li><Link to="/gallery" className="inline-flex h-9 items-center hover:text-brand-glow">Gallery</Link></li>
            {brand.pages.map((pg) => <li key={pg.slug}><Link to="/p/$slug" params={{ slug: pg.slug }} className="inline-flex h-9 items-center hover:text-brand-glow">{pg.title}</Link></li>)}
            <li><Link to="/login" className="inline-flex h-9 items-center hover:text-brand-glow">Staff login</Link></li>
          </ul>
        </div>
        <div>
          <h2 className="mb-4 font-display text-lg text-brand-glow">Our spaces</h2>
          <ul className="space-y-1 text-sm opacity-80">
            {brand.spaces.map((sp) => <li key={sp.slug}><Link to="/properties/$slug" params={{ slug: sp.slug }} className="inline-flex h-9 items-center hover:text-brand-glow">{sp.name}</Link></li>)}
            <li className="flex h-9 items-center">Direct Booking &middot; No Fees</li>
            <li><Link to="/search" className="inline-flex h-9 items-center hover:text-brand-glow">Check availability</Link></li>
            <li><InstallAppButton /></li>
            <li><Link to="/install" className="hover:underline">Get the app</Link></li>
          </ul>
        </div>
        <div>
          <h2 className="mb-4 font-display text-lg text-brand-glow">Contact</h2>
          <ul className="space-y-3 text-sm opacity-80">
            {c.location && <li className="flex items-center gap-2"><MapPin className="h-4 w-4 shrink-0 text-brand-glow" aria-hidden /> {c.location}</li>}
            {waHref && <li className="flex items-center gap-2"><MessageCircle className="animate-pulse-dot h-4 w-4 shrink-0 text-brand-glow" aria-hidden /><a href={waHref} target="_blank" rel="noreferrer" className="hover:text-brand-glow">{shown ? `${shown} (WhatsApp)` : 'Chat on WhatsApp'}</a></li>}
            {brand.contacts.filter((x) => x.kind !== 'whatsapp').map((x) => <li key={x.id} className="flex items-center gap-2"><Phone className="h-4 w-4 shrink-0 text-brand-glow" aria-hidden /><a href={`tel:+${x.phone}`} className="hover:text-brand-glow">{x.label}: {formatPhoneLocal(x.phone)}</a>{x.note && <span className="text-xs opacity-70">{x.note}</span>}</li>)}
            {!c.location && brand.businessAddress && <li className="flex items-center gap-2"><MapPin className="h-4 w-4 shrink-0 text-brand-glow" aria-hidden /> {brand.businessAddress}</li>}
            {(c.contactEmail || brand.businessEmail) && <li className="flex items-center gap-2"><Mail className="h-4 w-4 shrink-0 text-brand-glow" aria-hidden /><a href={`mailto:${c.contactEmail || brand.businessEmail}`} className="break-all hover:text-brand-glow">{c.contactEmail || brand.businessEmail}</a></li>}
          </ul>
        </div>
      </div>
      <div className="relative mx-auto max-w-7xl px-4 pb-6 sm:px-6"><MembershipNudge tone="dark" /></div>
      <div className="relative border-t border-white/10 py-6 text-center text-xs opacity-50">&copy; {new Date().getFullYear()} {brand.businessName}</div>
    </footer>
  )
}
