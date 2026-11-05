import { Link, useRouterState } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

const LABELS: Record<string, string> = {
  admin: 'Dashboard', bookings: 'Bookings', calendar: 'Calendar', requests: 'Requests', frontdesk: 'Check-in & out', blocked: 'Blocked dates', inquiries: 'Inquiries', support: 'Support',
  housekeeping: 'Housekeeping', maintenance: 'Maintenance', properties: 'Properties', rooms: 'Rooms', guests: 'Guests', media: 'Media library', gallery: 'Gallery', homepage: 'Homepage images',
  reviews: 'Reviews', announcements: 'Announcements', promotions: 'Promotions', finance: 'Finance', reports: 'Reports', owner: "Owner's overview", communications: 'Guest communications',
  access: 'Smart access', messages: 'Messages', contacts: 'Contact numbers', bar: 'Bar menu & stock', staff: 'Users', roles: 'Team roles', activity: 'Activity log', settings: 'Settings',
  notifications: 'Notifications', statement: 'Statement', new: 'New booking', 'change-password': 'Change password',
}

/** "Dashboard / Bookings / BNB-2611-0001" built from the address. Detail pages show a short id until opened. */
export function Breadcrumbs() {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2) return <p className="text-sm font-medium">Dashboard</p>
  const crumbs = parts.map((p, i) => ({ label: LABELS[p] ?? (p.length > 12 ? `${p.slice(0, 8)}…` : p), to: '/' + parts.slice(0, i + 1).join('/') }))
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1 truncate text-sm text-muted-foreground">
        {crumbs.map((c, i) => (
          <li key={c.to} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />}
            {i === crumbs.length - 1 ? <span aria-current="page" className="truncate font-medium text-foreground">{c.label}</span>
              : <Link to={c.to} className="hover:text-foreground hover:underline">{c.label}</Link>}
          </li>))}
      </ol>
    </nav>
  )
}
