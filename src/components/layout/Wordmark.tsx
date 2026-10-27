import { useBrand } from '~/lib/brand'

/** Logo if one is uploaded in Settings, otherwise a plain wordmark. Swap brand colours in styles/theme.css. */
export function Wordmark({ className = '', compact = false }: { className?: string; compact?: boolean }) {
  const { businessName, logoUrl } = useBrand()
  if (logoUrl) return <img src={logoUrl} alt={businessName} className={`h-8 w-auto ${className}`} />
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <span aria-hidden className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-sm font-bold text-brand-foreground">
        {businessName.trim().charAt(0).toUpperCase() || 'B'}
      </span>
      <span className={compact ? 'sr-only sm:not-sr-only sm:truncate' : 'truncate'}>{businessName}</span>
    </span>
  )
}
