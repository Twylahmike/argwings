import { Link } from '@tanstack/react-router'
import { Mail, MapPin, MessageCircle } from 'lucide-react'
import { useBrand } from '~/lib/brand'
import { useWhatsApp } from '~/lib/contact'
import { siteContent, safeUrl } from '~/lib/site-content'

export function SiteFooter() {
  const brand = useBrand()
  const wa = useWhatsApp()
  const waHref = wa('Hello!')
  const c = siteContent
  const socialLinks = [
    { label: 'Instagram', href: safeUrl(c.social.instagram), icon: <span className="text-xs font-bold" aria-hidden>IG</span> },
    { label: 'Facebook', href: safeUrl(c.social.facebook), icon: <span className="text-xs font-bold" aria-hidden>FB</span> },
    { label: 'TikTok', href: safeUrl(c.social.tiktok), icon: <span className="text-xs font-bold" aria-hidden>TT</span> },
    { label: 'X', href: safeUrl(c.social.x), icon: <span className="text-xs font-bold" aria-hidden>X</span> },
  ].filter((s) => s.href)
  return (
    <footer className="relative overflow-hidden bg-ink text-ink-foreground">
      <div className="absolute inset-0 opacity-[0.05]" aria-hidden style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)', backgroundSize: '24px 24px' }} />
      <div className="relative mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-3">
        <div>
          <p className="font-display text-3xl font-medium">{brand.businessName}</p>
          {c.tagline && <p className="mt-2 text-sm italic opacity-70">{c.tagline}</p>}
          <div className="mt-4 h-1 w-16 rounded-full bg-brand" aria-hidden />
          {socialLinks.length > 0 && (
            <div className="mt-5 flex gap-3">
              {socialLinks.map((s) => (
                <a key={s.label} href={s.href!} target="_blank" rel="noreferrer" aria-label={s.label} className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-brand hover:text-brand-foreground">{s.icon}</a>
              ))}
            </div>
          )}
        </div>
        <div>
          <h2 className="font-display text-xl opacity-90">Explore</h2>
          <ul className="mt-4 space-y-1 text-sm opacity-80">
            <li><Link to="/" className="inline-flex h-9 items-center hover:underline">Home</Link></li>
            <li><Link to="/search" className="inline-flex h-9 items-center hover:underline">Search availability</Link></li>
            <li><Link to="/gallery" className="inline-flex h-9 items-center hover:underline">Gallery</Link></li>
            <li><Link to="/login" className="inline-flex h-9 items-center hover:underline">Staff login</Link></li>
          </ul>
        </div>
        <div>
          <h2 className="font-display text-xl opacity-90">Contact</h2>
          <ul className="mt-4 space-y-3 text-sm opacity-80">
            {c.location && <li className="flex items-center gap-2"><MapPin className="h-4 w-4 shrink-0" aria-hidden /> {c.location}</li>}
            {waHref && <li><a href={waHref} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 hover:underline"><MessageCircle className="h-4 w-4 shrink-0" aria-hidden /> Chat on WhatsApp</a></li>}
            {c.contactEmail && <li><a href={`mailto:${c.contactEmail}`} className="inline-flex items-center gap-2 break-all hover:underline"><Mail className="h-4 w-4 shrink-0" aria-hidden /> {c.contactEmail}</a></li>}
            <li className="opacity-80">Pay securely with M-Pesa</li>
          </ul>
        </div>
      </div>
      <div className="relative border-t border-white/10 py-5 text-center text-xs opacity-60">&copy; {new Date().getFullYear()} {brand.businessName}</div>
    </footer>
  )
}
