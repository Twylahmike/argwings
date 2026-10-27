import { Link } from '@tanstack/react-router'

export function NotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <p className="text-5xl font-semibold text-brand">404</p>
      <h1 className="mt-3 text-xl font-semibold">We couldn&apos;t find that page</h1>
      <p className="mt-2 text-sm text-muted-foreground">The link may be old or mistyped.</p>
      <Link to="/" className="mt-6 inline-flex h-11 items-center rounded-md bg-brand px-5 text-sm font-medium text-brand-foreground">
        Back to home
      </Link>
    </div>
  )
}

export function RouteError({ error }: { error: Error }) {
  // Never show stack traces to users; the console has the detail.
  console.error(error)
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted-foreground">Please refresh the page. If it keeps happening, contact support.</p>
      <button onClick={() => window.location.reload()} className="mt-6 inline-flex h-11 items-center rounded-md bg-brand px-5 text-sm font-medium text-brand-foreground">
        Refresh
      </button>
    </div>
  )
}
