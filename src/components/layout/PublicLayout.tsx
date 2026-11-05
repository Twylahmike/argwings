import { useRouterState } from '@tanstack/react-router'
import { SiteHeader } from '~/components/site/SiteHeader'
import { SiteFooter } from '~/components/site/SiteFooter'
import { FloatingWA } from '~/components/site/FloatingWA'
import { useBrand } from '~/lib/brand'

/** Pages a guest with a booking link must always reach, even while the site is in maintenance mode. */
const ALWAYS_OPEN = /^\/(booking|receipt|request|login)(\/|$)/

/** Shared shell for every public page. `overlay` lets the hero run under a transparent header (home only). */
export function PublicLayout({ children, overlay = false }: { children: React.ReactNode; overlay?: boolean }) {
  const brand = useBrand()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const closed = brand.maintenanceMode && !ALWAYS_OPEN.test(path)
  return (
    <div className="site-theme flex min-h-dvh flex-col">
      <SiteHeader overlay={overlay && !closed} />
      <main className="flex-1">
        {closed ? (
          <section className="mx-auto flex max-w-xl flex-col items-center px-6 py-32 text-center" role="status">
            <h1 className="font-display text-4xl">We will be back soon</h1>
            <p className="mt-4 text-muted-foreground">{brand.businessName} is being updated. Guests with an existing booking can still use their booking link.</p>
          </section>
        ) : children}
      </main>
      <SiteFooter />
      <FloatingWA />
    </div>
  )
}
