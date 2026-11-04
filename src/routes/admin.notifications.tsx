import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, CheckCheck } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { errMessage, cn } from '~/lib/utils'
import { formatDateTime } from '~/lib/dates'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { EmptyState, ErrorState, PageHeader, Skeleton, Tabs } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/notifications')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: NotificationsPage,
})

type Notif = { id: string; kind: string; title: string; body: string | null; link: string | null; property_id: string | null; created_at: string; is_read: boolean }
const KINDS: { kind: string; label: string }[] = [
  { kind: 'booking_request', label: 'New booking requests' }, { kind: 'request_update', label: 'Guest accepted other dates' },
  { kind: 'inquiry', label: 'New inquiries' }, { kind: 'review', label: 'New reviews' }, { kind: 'payment', label: 'Payments received' },
  { kind: 'payment_review', label: 'Payments needing review' }, { kind: 'cancellation', label: 'Cancellations' },
  { kind: 'checkin_soon', label: 'Arrivals tomorrow' }, { kind: 'checkout_today', label: 'Departures today' }, { kind: 'balance_due', label: 'Unpaid balances' },
]

function NotificationsPage() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [tab, setTab] = useState<'all' | 'unread'>('unread')
  const list = useQuery({
    queryKey: ['notifications', tab],
    queryFn: async () => {
      const { data, error } = await sb().rpc('my_notifications', { p_limit: 100, p_only_unread: tab === 'unread' })
      if (error) throw error
      return data as Notif[]
    },
    refetchInterval: 30_000,
  })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['notifications'] }); qc.invalidateQueries({ queryKey: ['notif-count'] }) }
  const markRead = useMutation({
    mutationFn: async (ids: string[] | null) => { const { error } = await sb().rpc('mark_notifications_read', { p_ids: ids }); if (error) throw error },
    onSuccess: refresh, onError: (e) => toast.error(errMessage(e)),
  })
  const prefs = useQuery({ queryKey: ['notif-prefs'], queryFn: async () => {
    const { data, error } = await sb().from('notification_prefs').select('kind, enabled')
    if (error) throw error
    return new Map((data ?? []).map((p) => [p.kind as string, p.enabled as boolean]))
  } })
  const setPref = useMutation({
    mutationFn: async ({ kind, enabled }: { kind: string; enabled: boolean }) => {
      const { data: u } = await sb().auth.getUser()
      const { error } = await sb().from('notification_prefs').upsert({ user_id: u.user?.id, kind, enabled })
      if (error) throw error
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['notif-prefs'] }); refresh() }, onError: (e) => toast.error(errMessage(e)),
  })
  const open = (n: Notif) => {
    if (!n.is_read) markRead.mutate([n.id])
    if (n.link) nav({ to: n.link as '/admin' })
  }
  return (
    <div>
      <PageHeader title="Notifications" description="What needs your attention. Read state is yours alone; other team members keep their own."
        actions={<Button variant="outline" loading={markRead.isPending} onClick={() => markRead.mutate(null)}><CheckCheck className="h-4 w-4" aria-hidden /> Mark all read</Button>} />
      <div className="mb-4"><Tabs label="Show" value={tab} onChange={setTab} tabs={[{ value: 'unread', label: 'Unread' }, { value: 'all', label: 'All' }]} /></div>
      {list.isLoading && <Skeleton className="h-48" />}
      {list.error && <ErrorState error={list.error} retry={() => list.refetch()} />}
      {list.data?.length === 0 && <EmptyState icon={Bell} title={tab === 'unread' ? 'You are all caught up' : 'No notifications yet'} description="New requests, inquiries, payments, arrivals and more appear here." />}
      <ul className="grid gap-2">
        {list.data?.map((n) => (
          <li key={n.id}>
            <button onClick={() => open(n)} className={cn('flex w-full items-start gap-3 rounded-lg border p-3 text-left hover:bg-muted/50', !n.is_read && 'border-brand/40 bg-brand/5')}>
              <span aria-hidden className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', n.is_read ? 'bg-transparent' : 'bg-brand')} />
              <span className="min-w-0 flex-1"><span className="block font-medium">{n.title}</span>{n.body && <span className="block truncate text-sm text-muted-foreground">{n.body}</span>}
                <span className="mt-0.5 block text-xs text-muted-foreground">{formatDateTime(n.created_at)}</span></span>
            </button>
          </li>
        ))}
      </ul>
      <Card className="mt-8 max-w-xl">
        <CardHeader><CardTitle>What should alert me?</CardTitle><p className="text-sm text-muted-foreground">Switch off the kinds you do not want. This only affects your own notification list.</p></CardHeader>
        <CardContent className="grid gap-1">
          {KINDS.map((k) => {
            const on = prefs.data?.get(k.kind) ?? true
            return <label key={k.kind} className="flex h-11 items-center gap-3 text-sm"><input type="checkbox" className="h-5 w-5" checked={on} disabled={prefs.isLoading || setPref.isPending} onChange={(e) => setPref.mutate({ kind: k.kind, enabled: e.target.checked })} /> {k.label}</label>
          })}
        </CardContent>
      </Card>
    </div>
  )
}
