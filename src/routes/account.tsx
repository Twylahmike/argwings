import { createFileRoute, Link, Outlet, redirect, useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarCheck, Gift, History, Home, LifeBuoy, LogOut, Settings, Sparkles, User } from 'lucide-react'
import { fetchCustomer, hasStoredSession, type Customer } from '~/lib/customer'
import { useBrand } from '~/lib/brand'
import { PublicLayout } from '~/components/layout/PublicLayout'
import { Button } from '~/components/ui/button'
import { cn } from '~/lib/utils'

// The member area is client-rendered: the session lives in the browser. All data is read through functions that work from the
// signed-in user's id, so a customer can only ever see their own records.
export const Route = createFileRoute('/account')({
  ssr: false,
  validateSearch: (s: Record<string, unknown>): { welcome?: string } => (s.welcome === '1' ? { welcome: '1' } : {}),
  head: () => ({ meta: [{ title: 'My account' }, { name: 'robots', content: 'noindex' }] }),
  beforeLoad: async ({ context, location }) => {
    if (!hasStoredSession()) throw redirect({ to: '/login', search: { redirect: location.pathname } })
    const cs = await context.queryClient.fetchQuery({ queryKey: ['customer'], queryFn: fetchCustomer, staleTime: 30_000 })
    if (cs.state === 'anonymous') throw redirect({ to: '/login', search: { redirect: location.pathname } })
    if (cs.state === 'staff') throw redirect({ to: '/admin' })
  },
  component: AccountLayout,
})

const NAV = [
  { to: '/account', label: 'Overview', icon: Home, search: {}, match: (p: string, t?: string) => p === '/account' && !t },
  { to: '/account/bookings', label: 'My Bookings', icon: CalendarCheck, search: { tab: 'all' }, match: (p: string, t?: string) => p === '/account/bookings' && (!t || t === 'all' || t === 'cancelled') },
  { to: '/account/bookings', label: 'Upcoming Stays', icon: CalendarCheck, search: { tab: 'upcoming' }, match: (p: string, t?: string) => p === '/account/bookings' && t === 'upcoming' },
  { to: '/account/bookings', label: 'Booking History', icon: History, search: { tab: 'history' }, match: (p: string, t?: string) => p === '/account/bookings' && t === 'history' },
  { to: '/account/offers', label: 'My Offers', icon: Gift, search: {}, match: (p: string) => p === '/account/offers' },
  { to: '/account/rewards', label: 'Rewards', icon: Sparkles, search: {}, match: (p: string) => p === '/account/rewards' },
  { to: '/account/profile', label: 'My Profile', icon: User, search: {}, match: (p: string) => p === '/account/profile' },
  { to: '/account/settings', label: 'Account Settings', icon: Settings, search: {}, match: (p: string) => p === '/account/settings' },
  { to: '/account/help', label: 'Help and Support', icon: LifeBuoy, search: {}, match: (p: string) => p === '/account/help' },
] as const

export function useCustomer(): Customer | null {
  const q = useQuery({ queryKey: ['customer'], queryFn: fetchCustomer, staleTime: 30_000 })
  return q.data?.state === 'ready' ? q.data.customer! : null
}

function AccountLayout() {
  const brand = useBrand()
  const nav = useNavigate()
  const qc = useQueryClient()
  const loc = useRouterState({ select: (s) => s.location })
  const q = useQuery({ queryKey: ['customer'], queryFn: fetchCustomer, staleTime: 30_000 })
  const tab = new URLSearchParams(loc.searchStr).get('tab') ?? undefined

  async function signOut() {
    const { sb } = await import('~/lib/supabase')
    await sb().auth.signOut()
    qc.clear()
    nav({ to: '/' })
  }

  const cs = q.data
  if (cs?.state === 'unverified') {
    return (
      <PublicLayout><div className="mx-auto max-w-md px-4 py-20 text-center">
        <h1 className="font-display text-3xl">Verify your email</h1>
        <p className="mt-3 text-sm text-muted-foreground">Open the link we sent to <b>{cs.email}</b> to activate your membership.</p>
        <Button className="mt-6" variant="outline" onClick={signOut}>Sign out</Button>
      </div></PublicLayout>
    )
  }
  const c = cs?.state === 'ready' ? cs.customer! : null
  return (
    <PublicLayout>
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 sm:px-6 md:grid-cols-[15rem_1fr] md:py-12">
        <aside className="md:sticky md:top-24 md:self-start">
          <div className="mb-3 hidden md:block">
            <p className="eyebrow text-brand">{c?.tier.name ?? 'Member'}</p>
            <p className="font-display mt-1 text-2xl">{c?.full_name ?? '…'}</p>
          </div>
          <nav aria-label="Account" className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 md:mx-0 md:grid md:overflow-visible md:px-0">
            {NAV.map((n) => {
              const active = n.match(loc.pathname.replace(/\/$/, ''), tab)
              return (
                <Link key={n.label} to={n.to} search={n.search as never} className={cn('inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 text-sm', active ? 'bg-ink text-ink-foreground' : 'hover:bg-muted')}>
                  <n.icon className="h-4 w-4" aria-hidden />{n.label}
                </Link>
              )
            })}
            <button type="button" onClick={signOut} className="inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 text-sm hover:bg-muted"><LogOut className="h-4 w-4" aria-hidden />Sign out</button>
          </nav>
        </aside>
        <div className="min-w-0">
          {c?.status === 'suspended' && (
            <p role="alert" className="mb-5 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm">Your membership is paused, so offers are unavailable. Please contact {brand.businessName} for help.</p>
          )}
          <Outlet />
        </div>
      </div>
    </PublicLayout>
  )
}
