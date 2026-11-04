import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Menu, X } from 'lucide-react'
import { Wordmark } from '~/components/layout/Wordmark'
import { ThemeToggle } from '~/components/layout/ThemeToggle'
import { AnnouncementBar } from './AnnouncementBar'
import { cn } from '~/lib/utils'

const links = [
  { to: '/', label: 'Home' },
  { to: '/spaces', label: 'Spaces' },
  { to: '/gallery', label: 'Gallery' },
] as const

/** Fixed header. With `overlay` it is transparent over the hero until the page scrolls. */
export function SiteHeader({ overlay = false }: { overlay?: boolean }) {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 30)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  const solid = !overlay || scrolled || open
  return (
    <header className={cn('inset-x-0 top-0 z-40 transition-colors duration-500', overlay ? 'fixed' : 'sticky', solid ? 'border-b bg-background/90 text-foreground backdrop-blur-md' : 'border-b border-transparent bg-transparent text-white')}>
      <AnnouncementBar />
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link to="/" className={cn('min-w-0 font-display text-2xl', !solid && 'drop-shadow')} onClick={() => setOpen(false)}><Wordmark /></Link>
        <nav className="hidden items-center gap-1 text-sm font-medium md:flex" aria-label="Main">
          {links.map((l) => (
            <Link key={l.label} to={l.to} className="inline-flex h-11 items-center rounded-md px-3 transition-opacity hover:opacity-70">{l.label}</Link>
          ))}
        </nav>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <Link to="/search" className="btn-brand hidden h-10 items-center rounded-full px-5 text-sm font-medium sm:inline-flex">Book direct</Link>
          <button type="button" className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-muted/30 md:hidden" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen((o) => !o)}>
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>
      {open && (
        <nav id="mobile-nav" aria-label="Mobile" className="border-t bg-background px-4 pb-4 pt-2 text-foreground md:hidden">
          {links.map((l) => (
            <Link key={l.label} to={l.to} onClick={() => setOpen(false)} className="flex h-12 items-center border-b text-base">{l.label}</Link>
          ))}
          <Link to="/search" onClick={() => setOpen(false)} className="btn-brand mt-4 flex h-12 w-full items-center justify-center rounded-full text-base font-medium">Book direct</Link>
        </nav>
      )}
    </header>
  )
}
