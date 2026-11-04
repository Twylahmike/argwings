import { useState } from 'react'
import { X } from 'lucide-react'
import { siteContent, safeUrl } from '~/lib/site-content'

/** Driven by site-content.ts. Renders nothing when there are no announcements. */
export function AnnouncementBar() {
  const [dismissed, setDismissed] = useState<string[]>([])
  const a = siteContent.announcements.find((x) => !dismissed.includes(x.id))
  if (!a) return null
  const href = a.href ? (a.href.startsWith('/') ? a.href : safeUrl(a.href)) : null
  const tone = a.variant === 'promo' ? 'bg-brand text-brand-foreground' : 'bg-ink text-ink-foreground'
  return (
    <div className={`${tone} relative px-10 py-2 text-center text-xs md:text-sm`} role="status">
      {href ? <a href={href} className="font-medium underline-offset-4 hover:underline">{a.text}</a> : <span className="font-medium">{a.text}</span>}
      <button type="button" onClick={() => setDismissed((d) => [...d, a.id])} aria-label="Dismiss announcement"
        className="absolute right-1 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center opacity-70 hover:opacity-100">
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  )
}
