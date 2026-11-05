import { useState } from 'react'
import { Download } from 'lucide-react'
import { inviteFor, promptInstall, trackInstall, usePwaState } from '~/lib/pwa'

/**
 * "Install app" link (footer, install page, admin header). Uses the same install state as the popup, so it never shows once the app is
 * installed. Native browsers open their own prompt from the click; iPhone and iPad show the Add to Home Screen steps.
 */
export function InstallAppButton({ className = '', compact = false }: { className?: string; compact?: boolean }) {
  const pwa = usePwaState()
  const kind = inviteFor(pwa)
  const [hint, setHint] = useState('')
  if (kind === 'none' || kind === 'instructions') return null
  async function onClick() {
    trackInstall('click')
    if (kind === 'ios') { trackInstall('ios_instructions'); setHint((h) => (h ? '' : 'Tap the Share button, then "Add to Home Screen", then "Add".')); return }
    const a = await promptInstall()
    if (a === 'accepted') trackInstall('accepted')
    if (a === 'dismissed') { trackInstall('declined'); setHint('Installation was cancelled. You can try again from your browser menu.') }
  }
  return (
    <div className={`${compact ? 'relative' : ''} ${className}`.trim()}>
      <button type="button" aria-label="Install app" className={compact ? 'inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-muted' : 'inline-flex h-10 items-center gap-2 text-sm hover:underline'} onClick={onClick}>
        <Download className="h-4 w-4" aria-hidden />{!compact && ' Install app'}
      </button>
      {hint && <p role="status" className={compact ? 'absolute right-2 top-14 z-50 w-56 rounded-md border bg-card p-3 text-xs shadow-lg' : 'mt-1 max-w-xs text-xs opacity-80'}>{hint}</p>}
    </div>
  )
}
