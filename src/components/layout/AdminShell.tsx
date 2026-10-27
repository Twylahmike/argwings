import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  BarChart3, Brush, Building2, CalendarDays, ClipboardList, LayoutDashboard, LogOut, Menu, MessageCircle,
  Settings, UserCog, Users, Wallet, type LucideIcon,
} from 'lucide-react'
import { sb } from '~/lib/supabase'
import { canManage, isOwner, type Me } from '~/lib/auth'
import { Select } from '~/components/ui/form'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { cn } from '~/lib/utils'
import { Wordmark } from './Wordmark'
import { ThemeToggle } from './ThemeToggle'

type AdminCtx = {
  me: Me
  /** 'all' or a property id */
  propertyId: string
  setPropertyId: (id: string) => void
  /** Property ids to filter by (every property the user can access when 'all'). */
  scopeIds: string[]
}
const Ctx = createContext<AdminCtx | null>(null)
export function useAdmin(): AdminCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAdmin must be used inside <AdminShell>')
  return v
}

type NavItem = { to: string; label: string; icon: LucideIcon; show: (me: Me) => boolean; primary?: boolean }
const NAV: NavItem[] = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, show: canManage, primary: true },
  { to: '/admin/calendar', label: 'Calendar', icon: CalendarDays, show: canManage, primary: true },
  { to: '/admin/bookings', label: 'Bookings', icon: ClipboardList, show: canManage, primary: true },
  { to: '/admin/housekeeping', label: 'Housekeeping', icon: Brush, show: () => true, primary: true },
  { to: '/admin/properties', label: 'Properties', icon: Building2, show: canManage },
  { to: '/admin/guests', label: 'Guests', icon: Users, show: canManage },
  { to: '/admin/finance', label: 'Finance', icon: Wallet, show: canManage },
  { to: '/admin/reports', label: 'Reports', icon: BarChart3, show: canManage },
  { to: '/admin/messages', label: 'Messages', icon: MessageCircle, show: canManage },
  { to: '/admin/staff', label: 'Staff', icon: UserCog, show: isOwner },
  { to: '/admin/settings', label: 'Settings', icon: Settings, show: isOwner },
]

function useActive() {
  const path = useRouterState({ select: (s) => s.location.pathname })
  return (to: string) => (to === '/admin' ? path === '/admin' || path === '/admin/' : path === to || path.startsWith(to + '/'))
}

export function AdminShell({ me }: { me: Me }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const active = useActive()
  const [menuOpen, setMenuOpen] = useState(false)
  const [propertyId, setPid] = useState('all')

  useEffect(() => {
    try {
      const saved = localStorage.getItem('admin:property')
      if (saved && (saved === 'all' || me.properties.some((p) => p.id === saved))) setPid(saved)
    } catch { /* storage unavailable */ }
  }, [me.properties])
  const setPropertyId = useCallback((id: string) => {
    setPid(id)
    try { localStorage.setItem('admin:property', id) } catch { /* ignore */ }
  }, [])
  const scopeIds = useMemo(
    () => (propertyId === 'all' ? me.properties.map((p) => p.id) : [propertyId]),
    [propertyId, me.properties],
  )

  // A deactivated user must be thrown out immediately when the session ends or the account is disabled.
  useEffect(() => {
    const { data } = sb().auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        qc.clear()
        navigate({ to: '/login' })
      }
    })
    return () => data.subscription.unsubscribe()
  }, [navigate, qc])

  async function signOut() {
    await sb().auth.signOut()
    qc.clear()
    navigate({ to: '/login' })
  }

  const items = NAV.filter((n) => n.show(me))
  const primary = items.filter((n) => n.primary)
  const showFilter = canManage(me) && me.properties.length > 1

  return (
    <Ctx.Provider value={{ me, propertyId, setPropertyId, scopeIds }}>
      <div className="min-h-dvh md:flex">
        <aside className="no-print hidden w-60 shrink-0 flex-col border-r bg-card md:flex">
          <div className="flex h-16 items-center border-b px-4"><Wordmark /></div>
          <nav className="flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="Main">
            {items.map((n) => (
              <Link key={n.to} to={n.to} className={cn('flex h-11 items-center gap-3 rounded-md px-3 text-sm font-medium hover:bg-muted', active(n.to) && 'bg-muted text-brand')}>
                <n.icon className="h-5 w-5" aria-hidden /> {n.label}
              </Link>
            ))}
          </nav>
          <div className="border-t p-3 text-sm">
            <p className="truncate font-medium">{me.fullName}</p>
            <p className="truncate text-xs capitalize text-muted-foreground">{me.roles.join(', ')}</p>
            <button onClick={signOut} className="mt-2 inline-flex h-11 w-full items-center gap-2 rounded-md px-2 hover:bg-muted"><LogOut className="h-4 w-4" /> Sign out</button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="no-print sticky top-0 z-30 flex h-16 items-center justify-between gap-2 border-b bg-background/90 px-3 backdrop-blur md:px-6">
            <div className="md:hidden"><Wordmark compact /></div>
            <div className="hidden md:block" />
            <div className="flex items-center gap-2">
              {showFilter && (
                <Select aria-label="Filter by property" value={propertyId} onChange={(e) => setPropertyId(e.target.value)} className="h-11 w-36 sm:w-56">
                  <option value="all">All properties</option>
                  {me.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              )}
              <ThemeToggle />
              <button onClick={signOut} className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-muted md:hidden" aria-label="Sign out"><LogOut className="h-5 w-5" /></button>
            </div>
          </header>
          <main className="mx-auto w-full max-w-7xl flex-1 px-3 pb-28 pt-5 md:px-6 md:pb-10">
            <Outlet />
          </main>
        </div>

        <nav className="no-print fixed inset-x-0 bottom-0 z-40 grid border-t bg-card md:hidden" style={{ gridTemplateColumns: `repeat(${primary.length + (items.length > primary.length ? 1 : 0)}, minmax(0, 1fr))` }} aria-label="Main">
          {primary.map((n) => (
            <Link key={n.to} to={n.to} className={cn('flex h-16 flex-col items-center justify-center gap-0.5 text-[11px] font-medium', active(n.to) ? 'text-brand' : 'text-muted-foreground')}>
              <n.icon className="h-5 w-5" aria-hidden /> {n.label}
            </Link>
          ))}
          {items.length > primary.length && (
            <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
              <button onClick={() => setMenuOpen(true)} className="flex h-16 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted-foreground">
                <Menu className="h-5 w-5" aria-hidden /> More
              </button>
              <SheetContent title="More">
                <div className="grid gap-1">
                  {items.filter((n) => !n.primary).map((n) => (
                    <Link key={n.to} to={n.to} onClick={() => setMenuOpen(false)} className="flex h-12 items-center gap-3 rounded-md px-3 text-sm font-medium hover:bg-muted">
                      <n.icon className="h-5 w-5" aria-hidden /> {n.label}
                    </Link>
                  ))}
                </div>
              </SheetContent>
            </Dialog>
          )}
        </nav>
      </div>
    </Ctx.Provider>
  )
}
