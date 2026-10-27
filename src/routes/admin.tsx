import { createFileRoute, redirect } from '@tanstack/react-router'
import { fetchMe, canManage } from '~/lib/auth'
import { AdminShell } from '~/components/layout/AdminShell'

// The whole admin area is client-rendered: the Supabase session lives in the browser.
export const Route = createFileRoute('/admin')({
  ssr: false,
  head: () => ({ meta: [{ title: 'Admin' }, { name: 'robots', content: 'noindex' }] }),
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.fetchQuery({ queryKey: ['me'], queryFn: fetchMe, staleTime: 30_000 })
    if (!me) throw redirect({ to: '/login', search: { redirect: location.href } })
    const path = location.pathname.replace(/\/$/, '')
    if (me.mustChangePassword && path !== '/admin/change-password') throw redirect({ to: '/admin/change-password' })
    // Cleaners only ever get housekeeping (RLS would block the data anyway).
    if (!canManage(me) && path !== '/admin/housekeeping' && path !== '/admin/change-password') {
      throw redirect({ to: '/admin/housekeeping' })
    }
    return { me }
  },
  component: AdminLayout,
})

function AdminLayout() {
  const { me } = Route.useRouteContext()
  return <AdminShell me={me} />
}
