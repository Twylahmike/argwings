import { Link } from '@tanstack/react-router'
import { MessageCircle } from 'lucide-react'
import { useBrand, waLink } from '~/lib/brand'
import { Wordmark } from './Wordmark'

export function PublicLayout({ children }: { children: React.ReactNode }) {
  const brand = useBrand()
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
          <Link to="/" className="min-w-0"><Wordmark /></Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link to="/search" className="inline-flex h-11 items-center rounded-md px-3 hover:bg-muted">Search</Link>
            {brand.supportWhatsapp && (
              <a href={waLink(brand.supportWhatsapp, 'Hi, I have a question about booking.')} target="_blank" rel="noreferrer"
                className="inline-flex h-11 items-center gap-1.5 rounded-md px-3 hover:bg-muted">
                <MessageCircle className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">WhatsApp us</span><span className="sm:hidden sr-only">WhatsApp us</span>
              </a>
            )}
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t py-8 text-sm text-muted-foreground">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 sm:flex-row sm:items-center sm:justify-between">
          <p>&copy; {new Date().getFullYear()} {brand.businessName}</p>
          <p className="flex gap-4">
            <span>Pay securely with M-Pesa</span>
            <Link to="/login" className="underline-offset-4 hover:underline">Staff login</Link>
          </p>
        </div>
      </footer>
    </div>
  )
}
