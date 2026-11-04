import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Bell } from 'lucide-react'
import { sb } from '~/lib/supabase'

/** Unread count for the signed-in staff member (their own read state; preferences already applied by the database). */
export function NotificationBell() {
  const q = useQuery({
    queryKey: ['notif-count'],
    queryFn: async () => { const { data, error } = await sb().rpc('unread_notification_count'); if (error) throw error; return data as number },
    refetchInterval: 30_000,
    retry: false,
  })
  const n = q.data ?? 0
  return (
    <Link to="/admin/notifications" className="relative inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-muted" aria-label={n ? `Notifications, ${n} unread` : 'Notifications'}>
      <Bell className="h-5 w-5" aria-hidden />
      {n > 0 && <span className="absolute right-1 top-1 inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold leading-4 text-brand-foreground">{n > 99 ? '99+' : n}</span>}
    </Link>
  )
}
