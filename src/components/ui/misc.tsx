import * as React from 'react'
import { Loader2, type LucideIcon } from 'lucide-react'
import { cn } from '~/lib/utils'

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-muted', className)} />
}
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-muted-foreground', className)} aria-label="Loading" />
}

export function EmptyState({
  icon: Icon, title, description, action,
}: { icon?: LucideIcon; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center">
      {Icon && <Icon className="h-8 w-8 text-muted-foreground" aria-hidden />}
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Could not load this. Please try again.'
  return (
    <div role="alert" className="rounded-xl border border-danger/40 bg-danger/5 p-4 text-sm">
      <p className="font-medium text-danger">Something went wrong</p>
      <p className="mt-1 text-muted-foreground">{msg}</p>
      {retry && <button onClick={retry} className="mt-3 h-10 rounded-md border px-3 text-sm font-medium hover:bg-muted">Try again</button>}
    </div>
  )
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Tabs<T extends string>({
  value, onChange, tabs, label,
}: { value: T; onChange: (v: T) => void; tabs: { value: T; label: string }[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex max-w-full gap-1 overflow-x-auto rounded-lg bg-muted p-1">
      {tabs.map((t) => (
        <button
          key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}
          className={cn('h-10 whitespace-nowrap rounded-md px-3 text-sm font-medium', value === t.value ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground')}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: string; tone?: 'warn' | 'danger' }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-1 whitespace-nowrap text-xl font-semibold tabular-nums sm:text-2xl', tone === 'danger' && 'text-danger')}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** Horizontally scrollable table wrapper (mobile friendly). */
export function TableWrap({ children }: { children: React.ReactNode }) {
  return <div className="overflow-x-auto rounded-xl border bg-card"><table className="w-full min-w-[640px] text-left text-sm">{children}</table></div>
}
export const th = 'whitespace-nowrap bg-muted/60 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground'
export const td = 'px-3 py-2.5 align-middle'
