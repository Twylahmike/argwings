import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'

type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true

/** "Install app" using the browser's native prompt; on iPhone/iPad shows the Add to Home Screen steps. Hidden once installed. */
export function InstallAppButton({ className = '' }: { className?: string }) {
  const [ev, setEv] = useState<BIPEvent | null>(null)
  const [ios, setIos] = useState(false)
  const [hint, setHint] = useState(false)
  const [installed, setInstalled] = useState(true) // hidden until we know (avoids SSR flash)
  useEffect(() => {
    setInstalled(standalone())
    setIos(/iPad|iPhone|iPod/.test(navigator.userAgent))
    const onPrompt = (e: Event) => { e.preventDefault(); setEv(e as BIPEvent) }
    const onDone = () => { setInstalled(true); setEv(null) }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onDone)
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onDone) }
  }, [])
  if (installed || (!ev && !ios)) return null
  return (
    <div className={className}>
      <button type="button" className="inline-flex h-10 items-center gap-2 text-sm hover:underline" onClick={async () => { if (ev) { await ev.prompt(); setEv(null) } else setHint((h) => !h) }}>
        <Download className="h-4 w-4" aria-hidden /> Install app
      </button>
      {hint && <p className="mt-1 max-w-xs text-xs opacity-80">Tap the Share button, then &ldquo;Add to Home Screen&rdquo;.</p>}
    </div>
  )
}
