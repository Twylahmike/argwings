import { useBrand } from '~/lib/brand'
import { cn } from '~/lib/utils'

/** Logo if one is uploaded in Settings, otherwise a plain wordmark. Swap brand colours in styles/theme.css. */
/** Bundled brand logo. Set to '' to fall back to the text wordmark. */
const DEFAULT_LOGO = '/logo.webp'

export function Wordmark({ className = '', compact = false }: { className?: string; compact?: boolean }) {
  const { businessName, logoUrl } = useBrand()
  // Logo uploaded in Admin > Settings wins; otherwise the bundled brand logo (public/logo.webp).
  const src = logoUrl || DEFAULT_LOGO
  if (src) return <img src={src} alt={businessName} className={cn('h-14 w-auto rounded-md', className)} />
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <span aria-hidden className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-sm font-bold text-brand-foreground">
        {businessName.trim().charAt(0).toUpperCase() || 'B'}
      </span>
      <span className={compact ? 'sr-only sm:not-sr-only sm:truncate' : 'truncate'}>{businessName}</span>
    </span>
  )
}
