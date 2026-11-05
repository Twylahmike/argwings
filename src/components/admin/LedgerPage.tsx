import { useQuery } from '@tanstack/react-query'
import { adminRpc } from '~/lib/membership-admin'
import { EmptyState, ErrorState, PageHeader, Skeleton, TableWrap, td, th } from '~/components/ui/misc'

type Col<T> = { head: string; cell: (r: T) => React.ReactNode }

/** A read-only table backed by one permission-checked database function. */
export function LedgerPage<T extends { id: string }>({ title, description, fn, cols, empty }: { title: string; description: string; fn: string; cols: Col<T>[]; empty: string }) {
  const q = useQuery({ queryKey: ['ledger', fn], queryFn: () => adminRpc<T[]>(fn) })
  return (
    <div>
      <PageHeader title={title} description={description} />
      {q.isLoading && <Skeleton className="h-48" />}
      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && !q.data.length && <EmptyState title={empty} />}
      {!!q.data?.length && (
        <TableWrap>
          <thead><tr>{cols.map((c) => <th key={c.head} className={th}>{c.head}</th>)}</tr></thead>
          <tbody className="divide-y">{q.data.map((r) => <tr key={r.id}>{cols.map((c) => <td key={c.head} className={td}>{c.cell(r)}</td>)}</tr>)}</tbody>
        </TableWrap>
      )}
    </div>
  )
}
