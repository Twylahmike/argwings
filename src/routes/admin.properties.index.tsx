import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Building2, Plus } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { isOwner } from '~/lib/auth'
import type { Property, Unit } from '~/lib/types'
import { formatKES } from '~/lib/money'
import { fromRate } from '~/lib/pricing'
import { Button } from '~/components/ui/button'
import { Badge } from '~/components/ui/badge'
import { Card } from '~/components/ui/card'
import { EmptyState, ErrorState, PageHeader, Skeleton } from '~/components/ui/misc'
import { useAdmin } from '~/components/layout/AdminShell'

export const Route = createFileRoute('/admin/properties/')({ component: PropertiesPage })

function PropertiesPage() {
  const { me, scopeIds } = useAdmin()
  const q = useQuery({
    queryKey: ['admin-properties', scopeIds],
    queryFn: async () => {
      const [p, u] = await Promise.all([
        sb().from('properties').select('*').in('id', scopeIds).order('sort').order('name'),
        sb().from('units').select('*').in('property_id', scopeIds).order('sort'),
      ])
      if (p.error) throw p.error
      if (u.error) throw u.error
      return { props: p.data as Property[], units: u.data as Unit[] }
    },
  })
  return (
    <div>
      <PageHeader title="Properties" description="Rates, photos, rules and availability for each BNB."
        actions={isOwner(me) && <Button asChild><Link to="/admin/properties/$id" params={{ id: 'new' }}><Plus className="h-4 w-4" /> Add property</Link></Button>} />
      {q.isLoading && <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-64" />)}</div>}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && q.data.props.length === 0 && <EmptyState icon={Building2} title="No properties yet" description="Add your first property to start taking bookings." />}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {q.data?.props.map((p) => {
          const units = q.data.units.filter((u) => u.property_id === p.id)
          const from = units.length ? Math.min(...units.map(fromRate)) : null
          return (
            <Link key={p.id} to="/admin/properties/$id" params={{ id: p.id }} className="group block">
              <Card className="overflow-hidden transition-shadow group-hover:shadow-md">
                {p.cover_image ? <img src={p.cover_image} alt="" className="aspect-[16/9] w-full object-cover" loading="lazy" /> : <div className="aspect-[16/9] bg-muted" />}
                <div className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-semibold">{p.name}</h2>
                    {!p.active && <Badge className="text-muted-foreground">Hidden</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground">{p.area || p.city}</p>
                  <p className="mt-2 text-sm">{units.length} unit{units.length === 1 ? '' : 's'}{from != null && <> · from {formatKES(from)}/night</>}</p>
                </div>
              </Card>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
