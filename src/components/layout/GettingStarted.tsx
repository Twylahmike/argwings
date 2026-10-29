import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Circle, X } from 'lucide-react'
import { sb } from '~/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'

type Step = { key: string; label: string; hint: string; to: string; done: boolean }

/** Owner-only setup checklist on the dashboard. It disappears when everything is done (or when dismissed on this device). */
export function GettingStarted() {
  const [hidden, setHidden] = useState(true)
  useEffect(() => { try { setHidden(localStorage.getItem('gs:dismissed') === '1') } catch { setHidden(false) } }, [])

  const q = useQuery({
    queryKey: ['getting-started'],
    enabled: !hidden,
    queryFn: async () => {
      const [props, units, settings, staff, bookings] = await Promise.all([
        sb().from('properties').select('id, gallery, whatsapp_number'),
        sb().from('units').select('id', { count: 'exact', head: true }),
        sb().from('settings').select('key, value'),
        sb().from('profiles').select('id', { count: 'exact', head: true }),
        sb().from('bookings').select('id', { count: 'exact', head: true }),
      ])
      for (const r of [props, units, settings, staff, bookings]) if (r.error) throw r.error
      const s = Object.fromEntries((settings.data ?? []).map((r) => [r.key as string, r.value]))
      const str = (k: string) => (typeof s[k] === 'string' ? (s[k] as string) : '')
      const steps: Step[] = [
        { key: 'brand', label: 'Name your business', hint: 'Business name, logo and brand colour', to: '/admin/settings', done: !!str('business_name') && str('business_name') !== 'Your BNB Brand' },
        { key: 'property', label: 'Add your first property', hint: 'Name, address, house rules', to: '/admin/properties', done: (props.data?.length ?? 0) > 0 },
        { key: 'unit', label: 'Add a unit with its rates', hint: 'Nightly and weekend rate, cleaning fee', to: '/admin/properties', done: (units.count ?? 0) > 0 },
        { key: 'photos', label: 'Upload photos', hint: 'Guests book what they can see', to: '/admin/properties', done: (props.data ?? []).some((p) => (p.gallery as string[] | null)?.length) },
        { key: 'whatsapp', label: 'Add your WhatsApp number', hint: 'For "Book on WhatsApp" and alerts', to: '/admin/settings', done: !!str('support_whatsapp') || (props.data ?? []).some((p) => !!p.whatsapp_number) },
        { key: 'paybill', label: 'Add your Paybill or Till', hint: 'Shown to guests who pay manually', to: '/admin/settings', done: !!str('mpesa_paybill_display') },
        { key: 'staff', label: 'Invite a manager or cleaner', hint: 'Each person gets their own login', to: '/admin/staff', done: (staff.count ?? 0) > 1 },
        { key: 'booking', label: 'Make a test booking', hint: 'Try the calendar and the guest page', to: '/admin/bookings/new', done: (bookings.count ?? 0) > 0 },
      ]
      return steps
    },
  })
  if (hidden || !q.data) return null
  const steps = q.data
  const done = steps.filter((s) => s.done).length
  if (done === steps.length) return null
  const pct = Math.round((done / steps.length) * 100)

  return (
    <Card className="border-brand/30 bg-brand/5">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Let&apos;s get you set up</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{done} of {steps.length} done. About 10 minutes in total.</p>
        </div>
        <button aria-label="Hide setup checklist" className="-mr-2 -mt-2 inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-muted"
          onClick={() => { try { localStorage.setItem('gs:dismissed', '1') } catch { /* ignore */ } setHidden(true) }}><X className="h-4 w-4" /></button>
      </CardHeader>
      <CardContent>
        <div className="mb-3 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Setup progress">
          <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
        </div>
        <ul className="grid gap-1 sm:grid-cols-2">
          {steps.map((s) => (
            <li key={s.key}>
              <Link to={s.to} className="flex min-h-12 items-start gap-3 rounded-md p-2 hover:bg-card">
                {s.done ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-label="Done" /> : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-label="To do" />}
                <span><span className={`block text-sm font-medium ${s.done ? 'text-muted-foreground line-through' : ''}`}>{s.label}</span><span className="block text-xs text-muted-foreground">{s.hint}</span></span>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
