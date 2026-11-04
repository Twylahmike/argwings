import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { EyeOff, Flag, Star } from 'lucide-react'
import { toast } from 'sonner'
import { sb } from '~/lib/supabase'
import { requireRole } from '~/lib/auth'
import { errMessage } from '~/lib/utils'
import { formatDateTime } from '~/lib/dates'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Textarea } from '~/components/ui/form'
import { Card, CardContent } from '~/components/ui/card'
import { EmptyState, ErrorState, PageHeader, Skeleton, Tabs } from '~/components/ui/misc'

export const Route = createFileRoute('/admin/reviews')({
  beforeLoad: ({ context }) => requireRole(context.me, ['owner', 'manager']),
  component: ReviewsPage,
})

type ReviewStatus = 'pending' | 'approved' | 'hidden'
type Review = { id: string; guest_name: string; stay_label: string | null; property_id: string | null; rating: number; body: string; status: ReviewStatus; flagged: boolean; response: string | null; responded_at: string | null; created_at: string }

function Stars({ n }: { n: number }) {
  return <span className="inline-flex gap-0.5" role="img" aria-label={`${n} out of 5 stars`}>{[1, 2, 3, 4, 5].map((i) => <Star key={i} className={`h-4 w-4 ${i <= n ? 'fill-brand text-brand' : 'text-muted-foreground/40'}`} aria-hidden />)}</span>
}

function ReviewsPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'pending' | 'approved' | 'hidden' | 'flagged'>('pending')
  const q = useQuery({
    queryKey: ['reviews-admin'],
    queryFn: async () => {
      const [r, p] = await Promise.all([sb().from('reviews').select('*').order('created_at', { ascending: false }).limit(500), sb().from('properties').select('id, name')])
      if (r.error) throw r.error
      return { rows: r.data as Review[], props: new Map((p.data ?? []).map((x) => [x.id as string, x.name as string])) }
    },
  })
  const save = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Record<string, unknown> }) => {
      const { error } = await sb().from('reviews').update(patch).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['reviews-admin'] }); toast.success('Saved') },
    onError: (e) => toast.error(errMessage(e)),
  })
  const counts = useMemo(() => ({
    pending: q.data?.rows.filter((r) => r.status === 'pending').length ?? 0,
    approved: q.data?.rows.filter((r) => r.status === 'approved').length ?? 0,
    hidden: q.data?.rows.filter((r) => r.status === 'hidden').length ?? 0,
    flagged: q.data?.rows.filter((r) => r.flagged).length ?? 0,
  }), [q.data])
  const rows = (q.data?.rows ?? []).filter((r) => (tab === 'flagged' ? r.flagged : r.status === tab))
  const avg = q.data?.rows.filter((r) => r.status === 'approved').reduce((a, r, _, all) => a + r.rating / all.length, 0)
  return (
    <div>
      <PageHeader title="Reviews" description={`Guest reviews wait here until you approve them. Only approved reviews appear on your website.${counts.approved ? ` Average of approved: ${avg?.toFixed(1)} / 5.` : ''}`} />
      <div className="mb-4"><Tabs label="Review status" value={tab} onChange={setTab} tabs={[
        { value: 'pending', label: `Pending (${counts.pending})` }, { value: 'approved', label: `Approved (${counts.approved})` },
        { value: 'hidden', label: `Hidden (${counts.hidden})` }, { value: 'flagged', label: `Flagged (${counts.flagged})` }]} /></div>
      {q.isLoading && <Skeleton className="h-48" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && rows.length === 0 && <EmptyState icon={Star} title="No reviews here" description="Guests can leave a review at the bottom of your website's reviews section." />}
      <div className="grid gap-3">
        {rows.map((r) => <ReviewCard key={r.id} r={r} prop={r.property_id ? q.data?.props.get(r.property_id) : undefined} busy={save.isPending} onSave={(patch) => save.mutate({ id: r.id, patch })} />)}
      </div>
    </div>
  )
}

function ReviewCard({ r, prop, busy, onSave }: { r: Review; prop?: string; busy: boolean; onSave: (p: Record<string, unknown>) => void }) {
  const [reply, setReply] = useState(r.response ?? '')
  return (
    <Card><CardContent className="grid gap-3 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><p className="font-medium">{r.guest_name}{r.stay_label ? <span className="font-normal text-muted-foreground"> · {r.stay_label}</span> : null}{prop ? <span className="font-normal text-muted-foreground"> · {prop}</span> : null}</p>
          <p className="text-xs text-muted-foreground">{formatDateTime(r.created_at)}</p></div>
        <div className="flex items-center gap-2"><Stars n={r.rating} /><Badge className={r.status === 'approved' ? 'border-emerald-600/40 text-emerald-700 dark:text-emerald-300' : r.status === 'hidden' ? 'text-muted-foreground' : 'border-amber-500/40 text-amber-700 dark:text-amber-300'}>{r.status}</Badge>{r.flagged && <Badge className="border-danger/50 text-danger"><Flag className="mr-1 h-3 w-3" aria-hidden />Flagged</Badge>}</div>
      </div>
      <p className="whitespace-pre-line text-sm">{r.body}</p>
      <div className="grid gap-2">
        <label htmlFor={`rr-${r.id}`} className="text-sm font-medium">Your public reply (optional)</label>
        <Textarea id={`rr-${r.id}`} rows={2} maxLength={1000} value={reply} onChange={(e) => setReply(e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-2">
        {r.status !== 'approved' && <Button size="sm" loading={busy} onClick={() => onSave({ status: 'approved', flagged: false })}>Approve and publish</Button>}
        {r.status !== 'hidden' && <Button size="sm" variant="outline" loading={busy} onClick={() => onSave({ status: 'hidden' })}><EyeOff className="h-4 w-4" aria-hidden /> Hide</Button>}
        <Button size="sm" variant="outline" loading={busy} onClick={() => onSave({ flagged: !r.flagged })}><Flag className="h-4 w-4" aria-hidden /> {r.flagged ? 'Remove flag' : 'Flag'}</Button>
        <Button size="sm" variant="secondary" disabled={reply.trim() === (r.response ?? '')} loading={busy} onClick={async () => {
          const { data: u } = await sb().auth.getUser()
          onSave({ response: reply.trim() || null, responded_at: reply.trim() ? new Date().toISOString() : null, responded_by: reply.trim() ? u.user?.id : null })
        }}>Save reply</Button>
      </div>
    </CardContent></Card>
  )
}
