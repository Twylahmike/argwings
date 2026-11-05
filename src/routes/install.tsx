import { createFileRoute } from '@tanstack/react-router'
import { DEFAULT_BRAND, type Brand } from '~/lib/brand'
import { pageMeta } from '~/lib/seo'
import { PublicLayout } from '~/components/layout/PublicLayout'
import { InstallAppButton } from '~/components/site/InstallAppButton'

export const Route = createFileRoute('/install')({
  head: ({ matches }) => {
    const brand = (matches[0]?.loaderData as { brand?: Brand } | undefined)?.brand ?? DEFAULT_BRAND
    return pageMeta({ brand: brand.businessName, site: brand.site, title: 'Get the app', description: `Install the ${brand.businessName} app on your phone or computer. No app store needed.`, path: '/install' })
  },
  component: InstallPage,
})

const STEPS: { title: string; steps: string[] }[] = [
  { title: 'Android (Chrome)', steps: ['Open this site in Chrome.', 'Tap Install app below, or the menu (⋮) then Install app.', 'Confirm. The icon appears on your home screen.'] },
  { title: 'iPhone and iPad (Safari)', steps: ['Open this site in Safari.', 'Tap the Share button.', 'Choose Add to Home Screen, then Add.'] },
  { title: 'Computer (Chrome or Edge)', steps: ['Open this site in Chrome or Edge.', 'Click the install icon at the right of the address bar, or Install app below.', 'The app opens in its own window.'] },
]

function InstallPage() {
  return (
    <PublicLayout>
      <section className="mx-auto max-w-3xl px-4 py-16">
        <p className="eyebrow text-brand">The app</p>
        <h1 className="section-title mt-3">Install on your device</h1>
        <p className="mt-4 text-muted-foreground">Book and manage your stay from your home screen. It opens full screen like any app, loads fast, and needs no app store. Staff can use the same app to sign in to the dashboard.</p>
        <div className="mt-6 text-lg"><InstallAppButton /></div>
        <div className="mt-10 grid gap-6 sm:grid-cols-3">
          {STEPS.map((g) => (
            <div key={g.title} className="rounded-xl border bg-card p-5">
              <h2 className="font-display text-xl">{g.title}</h2>
              <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-muted-foreground">{g.steps.map((s) => <li key={s}>{s}</li>)}</ol>
            </div>
          ))}
        </div>
      </section>
    </PublicLayout>
  )
}
