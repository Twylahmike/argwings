import { SiteHeader } from '~/components/site/SiteHeader'
import { SiteFooter } from '~/components/site/SiteFooter'
import { FloatingWA } from '~/components/site/FloatingWA'

/** Shared shell for every public page. `overlay` lets the hero run under a transparent header (home only). */
export function PublicLayout({ children, overlay = false }: { children: React.ReactNode; overlay?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader overlay={overlay} />
      <main className="flex-1">{children}</main>
      <SiteFooter />
      <FloatingWA />
    </div>
  )
}
