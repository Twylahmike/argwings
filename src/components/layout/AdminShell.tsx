import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { usePermissions } from '~/lib/permissions'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BarChart3, BedDouble, Brush, Building2, CalendarCheck, CalendarDays, ClipboardList, Inbox, LayoutDashboard, LogOut, Megaphone, Menu, MessageCircle,
  Settings, Star, UserCog, Users, Wallet, type LucideIcon,
  Ban, Crown, PanelLeft, History, ShieldCheck, KeyRound, Wine, Phone, Send, DoorOpen, ImagePlus, Images, LifeBuoy, PanelTop, Tag, Wrench,
} from 'lucide-react'
import { sb } from '~/lib/supabase'
import { canManage, isOwner, type Me } from '~/lib/auth'
import { Select } from '~/components/ui/form'
import { Dialog, SheetContent } from '~/components/ui/dialog'
import { cn } from '~/lib/utils'
import { Wordmark } from './Wordmark'
import { ThemeToggle } from './ThemeToggle'
import { NotificationBell } from './NotificationBell'
import { GlobalSearch } from './GlobalSearch'
import { Breadcrumbs } from './Breadcrumbs'

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

type NavItem = { to: string; label: string; icon: LucideIcon; show: (me: Me) => boolean; primary?: boolean; group: string; perm?: string; module?: 'module_bar_menu' | 'module_bar_stock' }
const NAV: NavItem[] = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, show: canManage, primary: true, group: 'Operations', perm: 'dashboard.view' },
  { to: '/admin/calendar', label: 'Calendar', icon: CalendarDays, show: canManage, primary: true, group: 'Operations', perm: 'bookings.view' },
  { to: '/admin/bookings', label: 'Bookings', icon: ClipboardList, show: canManage, primary: true, group: 'Operations', perm: 'bookings.view' },
  { to: '/admin/requests', label: 'Requests', icon: CalendarCheck, show: canManage, group: 'Operations', perm: 'requests.manage' },
  { to: '/admin/frontdesk', label: 'Check-in & out', icon: DoorOpen, show: canManage, group: 'Operations', perm: 'checkin.manage' },
  { to: '/admin/blocked', label: 'Blocked dates', icon: Ban, show: canManage, group: 'Operations', perm: 'blocked.manage' },
  { to: '/admin/inquiries', label: 'Inquiries', icon: Inbox, show: canManage, group: 'Operations', perm: 'inquiries.manage' },
  { to: '/admin/support', label: 'Support', icon: LifeBuoy, show: canManage, group: 'Operations', perm: 'support.manage' },
  { to: '/admin/housekeeping', label: 'Housekeeping', icon: Brush, show: () => true, primary: true, group: 'Operations', perm: 'housekeeping.view' },
  { to: '/admin/maintenance', label: 'Maintenance', icon: Wrench, show: () => true, group: 'Operations', perm: 'maintenance.report' },
  { to: '/admin/properties', label: 'Properties', icon: Building2, show: canManage, group: 'Operations', perm: 'listings.manage' },
  { to: '/admin/rooms', label: 'Rooms', icon: BedDouble, show: canManage, group: 'Operations', perm: 'rooms.manage' },
  { to: '/admin/guests', label: 'Guests', icon: Users, show: canManage, group: 'Operations', perm: 'guests.view' },
  { to: '/admin/media', label: 'Media library', icon: ImagePlus, show: canManage, group: 'Website', perm: 'media.manage' },
  { to: '/admin/gallery', label: 'Gallery', icon: Images, show: canManage, group: 'Website', perm: 'media.manage' },
  { to: '/admin/homepage', label: 'Homepage images', icon: PanelTop, show: canManage, group: 'Website', perm: 'media.manage' },
  { to: '/admin/bar', label: 'Bar menu & stock', icon: Wine, show: canManage, group: 'Hospitality services', module: 'module_bar_menu', perm: 'bar.manage' },
  { to: '/admin/reviews', label: 'Reviews', icon: Star, show: canManage, group: 'Website', perm: 'cms.manage' },
  { to: '/admin/announcements', label: 'Announcements', icon: Megaphone, show: canManage, group: 'Website', perm: 'cms.manage' },
  { to: '/admin/owner', label: "Owner's overview", icon: Crown, show: canManage, group: 'Business', perm: 'owner.overview' },
  { to: '/admin/promotions', label: 'Promotions', icon: Tag, show: canManage, group: 'Business', perm: 'marketing.manage' },
  { to: '/admin/finance', label: 'Finance', icon: Wallet, show: canManage, group: 'Business', perm: 'finance.view' },
  { to: '/admin/reports', label: 'Reports', icon: BarChart3, show: canManage, group: 'Business', perm: 'reports.view' },
  { to: '/admin/communications', label: 'Guest communications', icon: Send, show: canManage, group: 'Guest experience', perm: 'comms.manage' },
  { to: '/admin/access', label: 'Smart access', icon: KeyRound, show: canManage, group: 'Guest experience', perm: 'access.manage' },
  { to: '/admin/contacts', label: 'Contact numbers', icon: Phone, show: canManage, group: 'System' },
  { to: '/admin/messages', label: 'Messages', icon: MessageCircle, show: canManage, group: 'Guest experience', perm: 'comms.manage' },
  { to: '/admin/staff', label: 'Users', icon: UserCog, show: isOwner, group: 'System' },
  { to: '/admin/roles', label: 'Team roles', icon: ShieldCheck, show: isOwner, group: 'System' },
  { to: '/admin/activity', label: 'Activity log', icon: History, show: canManage, group: 'System', perm: 'audit.view' },
  { to: '/admin/settings', label: 'Settings', icon: Settings, show: isOwner, group: 'System' },
]
const GROUPS = ['Operations', 'Hospitality services', 'Website', 'Business', 'Guest experience', 'System']

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
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => { try { setCollapsed(localStorage.getItem('admin:collapsed') === '1') } catch { /* ignore */ } }, [])
  const toggleCollapsed = () => setCollapsed((c) => { try { localStorage.setItem('admin:collapsed', c ? '0' : '1') } catch { /* ignore */ } return !c })

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

  const mods = useQuery({ queryKey: ['modules'], queryFn: async () => {
    const { data } = await sb().from('settings').select('key, value').in('key', ['module_bar_menu', 'module_bar_stock'])
    return Object.fromEntries((data ?? []).map((r) => [r.key as string, r.value === true]))
  }, staleTime: 60_000 })
  const modOn = (k?: string) => !k || mods.data?.module_bar_menu === true || mods.data?.module_bar_stock === true
  const perms = usePermissions()
  const items = NAV.filter((n) => n.show(me) && modOn(n.module) && perms.can(n.perm))
  const primary = items.filter((n) => n.primary)
  const showFilter = canManage(me) && me.properties.length > 1

  return (
    <Ctx.Provider value={{ me, propertyId, setPropertyId, scopeIds }}>
      <div className="min-h-dvh md:flex">
        <aside className={cn('no-print hidden shrink-0 flex-col border-r bg-card transition-[width] md:flex', collapsed ? 'w-16' : 'w-60')}>
          <div className="flex h-16 items-center justify-between border-b px-3">{!collapsed && <Wordmark />}<button type="button" onClick={toggleCollapsed} aria-label={collapsed ? 'Expand the menu' : 'Collapse the menu'} aria-expanded={!collapsed} className="inline-flex h-10 w-10 items-center justify-center rounded-md hover:bg-muted"><PanelLeft className="h-5 w-5" /></button></div>
          <nav className="flex-1 overflow-y-auto p-2" aria-label="Main">
            {GROUPS.map((g) => { const list = items.filter((n) => n.group === g); return list.length === 0 ? null : (
              <div key={g} className="mb-3">
                {!collapsed && <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">{g}</p>}
                <div className="space-y-0.5">{list.map((n) => (
                  <Link key={n.to} to={n.to} title={collapsed ? n.label : undefined} aria-label={collapsed ? n.label : undefined} className={cn('flex h-11 items-center gap-3 rounded-md px-3 text-sm font-medium hover:bg-muted', collapsed && 'justify-center px-0', active(n.to) && 'bg-muted text-brand')}>
                    <n.icon className="h-5 w-5 shrink-0" aria-hidden /> {!collapsed && n.label}
                  </Link>))}</div>
              </div>) })}
            <a href="/" className="mt-2 flex h-11 items-center gap-3 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-muted">Back to website</a>
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
            <div className="hidden min-w-0 shrink md:block md:w-64 lg:w-80"><Breadcrumbs /></div>
            {canManage(me) && <GlobalSearch />}
            <div className="flex items-center gap-2">
              {showFilter && (
                <Select aria-label="Filter by property" value={propertyId} onChange={(e) => setPropertyId(e.target.value)} className="h-11 w-36 sm:w-56">
                  <option value="all">All properties</option>
                  {me.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              )}
              {canManage(me) && <NotificationBell />}
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
