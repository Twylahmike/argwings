import { useEffect, useRef, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import * as Dialog from '@radix-ui/react-dialog'
import { CirclePlus, Download, Share, SquarePlus, X } from 'lucide-react'
import { useBrand } from '~/lib/brand'
import { fillName, inviteFor, promptInstall, trackInstall, usePwaState } from '~/lib/pwa'

/** Pages where an interruption would get in the way of paying, signing in or filling a form. The invitation waits for the next page. */
const QUIET = /^\/(admin|login|join|forgot-password|reset-password|auth|book|booking|receipt|request|install)(\/|$)/

type Step = 'invite' | 'installing' | 'cancelled' | 'done' | 'ios'

/**
 * The install invitation. Closing it (X, "Not now", Escape, a tap outside) only hides it for THIS page view: nothing is stored, so it
 * returns on the next visit until the browser reports a real installation. It never claims success from a click: "installed" comes only
 * from the browser's appinstalled event (or from being opened as the installed app).
 */
export function InstallInvite() {
  const brand = useBrand()
  const cfg = brand.appInstall
  const path = useRouterState({ select: (s) => s.location.pathname })
  const pwa = usePwaState()
  const kind = inviteFor(pwa)
  const [closed, setClosed] = useState(false)          // this page view only
  const [delayed, setDelayed] = useState(false)
  const [step, setStep] = useState<Step>('invite')
  const counted = useRef(false)
  const wasInstalled = useRef(false)

  useEffect(() => { const t = setTimeout(() => setDelayed(true), 1500); return () => clearTimeout(t) }, [])

  const wanted = cfg.enabled && kind !== 'none' && !closed && delayed && !QUIET.test(path)
  // Once the visitor has pressed INSTALL the browser prompt is spent, so "kind" turns to none: keep the panel for its follow-up message.
  const open = wanted || ((step === 'installing' || step === 'cancelled' || step === 'done') && !closed)

  // The moment the browser reports the install, show the confirmation (and nothing else).
  useEffect(() => {
    if (pwa.installedFlag && !wasInstalled.current && step === 'installing') setStep('done')
    wasInstalled.current = pwa.installedFlag
  }, [pwa.installedFlag, step])

  // Count one impression per page view, when the invitation is really shown.
  useEffect(() => { if (wanted && !counted.current) { counted.current = true; trackInstall('impression') } }, [wanted])

  if (!open) return null
  const name = brand.businessName
  const headline = fillName(cfg.headline, name)
  const description = fillName(cfg.description, name)
  const subtext = fillName(cfg.subtext, name)

  async function install() {
    trackInstall('click')
    if (kind === 'ios') { trackInstall('ios_instructions'); setStep('ios'); return }
    if (kind !== 'native') return
    const answer = await promptInstall()
    if (answer === 'accepted') { trackInstall('accepted'); setStep('installing') }     // wait for appinstalled before saying it worked
    else if (answer === 'dismissed') { trackInstall('declined'); setStep('cancelled') }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) { setClosed(true); setStep('invite') } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content style={{ background: 'hsl(var(--ink))', color: 'hsl(var(--ink-foreground))' }} className="fixed inset-x-3 bottom-3 z-[61] mx-auto max-w-md overflow-hidden rounded-3xl border border-white/10 shadow-2xl focus:outline-none sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:-translate-x-1/2 sm:-translate-y-1/2" aria-describedby="install-desc">
          {cfg.image && <img src={cfg.image} alt="" className="h-36 w-full object-cover opacity-90" />}
          <div className="relative p-6 pt-7">
            <Dialog.Close className="absolute right-3 top-3 inline-flex h-11 w-11 items-center justify-center rounded-full text-ink-foreground/70 hover:bg-white/10" aria-label="Close"><X className="h-5 w-5" /></Dialog.Close>
            <div className="flex items-center gap-3">
              <img src="/app-icon-192.png" alt="" className="h-14 w-14 rounded-2xl border border-brand/50" width={56} height={56} />
              <p className="eyebrow text-brand">{name}</p>
            </div>

            {step === 'ios' ? <IosSteps onDone={() => setStep('invite')} />
              : step === 'done' ? (
                <div role="status">
                  <Dialog.Title className="font-display mt-5 text-3xl leading-tight">Installed. Welcome aboard.</Dialog.Title>
                  <p id="install-desc" className="mt-3 text-sm text-ink-foreground/80">{name} is now on your device. Open it from your home screen or apps menu.</p>
                  <button type="button" onClick={() => setClosed(true)} className="btn-brand mt-6 inline-flex h-12 w-full items-center justify-center rounded-full text-sm font-semibold uppercase tracking-wider">Continue</button>
                </div>
              ) : (
                <>
                  <Dialog.Title className="font-display mt-5 text-3xl leading-tight sm:text-4xl">{headline}</Dialog.Title>
                  <p id="install-desc" className="mt-3 text-sm text-ink-foreground/80">{description}</p>
                  {step === 'cancelled' && <p role="status" className="mt-4 rounded-lg border border-brand/40 bg-brand/10 p-3 text-sm">No problem. You can still install any time from your browser menu (Install app), and we will invite you again next time.</p>}
                  {step === 'installing' && <p role="status" className="mt-4 rounded-lg border border-brand/40 bg-brand/10 p-3 text-sm">Finishing installation&hellip; this takes a moment.</p>}
                  {kind === 'instructions' ? <Unsupported />
                    : step !== 'cancelled' && step !== 'installing' && (
                      <button type="button" onClick={install} className="btn-brand mt-6 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full text-sm font-semibold uppercase tracking-wider">
                        <Download className="h-4 w-4" aria-hidden /> {cfg.buttonText}
                      </button>)}
                  <p className="mt-4 text-center text-xs text-ink-foreground/60">{subtext}</p>
                  <button type="button" onClick={() => setClosed(true)} className="mx-auto mt-2 flex h-11 items-center px-4 text-sm text-ink-foreground/70 underline underline-offset-4 hover:text-ink-foreground">Not now</button>
                </>
              )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function IosSteps({ onDone }: { onDone: () => void }) {
  const steps = [
    { icon: Share, title: 'Tap the Share button', text: 'The square with an arrow, at the bottom of Safari (top on iPad).' },
    { icon: SquarePlus, title: 'Choose "Add to Home Screen"', text: 'Scroll down the list of actions if you do not see it.' },
    { icon: CirclePlus, title: 'Tap "Add"', text: 'The app icon appears on your home screen.' },
  ]
  return (
    <div>
      <Dialog.Title className="font-display mt-5 text-3xl leading-tight">Add to your Home Screen</Dialog.Title>
      <p id="install-desc" className="mt-2 text-sm text-ink-foreground/80">iPhone and iPad install apps from Safari&rsquo;s Share menu. If you are in another browser, open this page in Safari first.</p>
      <ol className="mt-5 grid gap-3">
        {steps.map((s, i) => (
          <li key={s.title} className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand/20 text-brand"><s.icon className="h-5 w-5" aria-hidden /></span>
            <span className="text-sm"><b>{i + 1}. {s.title}</b><span className="block text-ink-foreground/70">{s.text}</span></span>
          </li>))}
      </ol>
      <p className="mt-4 text-xs text-ink-foreground/60">Once it is on your Home Screen, open it from there and this invitation stops.</p>
      <button type="button" onClick={onDone} className="btn-brand mt-5 inline-flex h-12 w-full items-center justify-center rounded-full text-sm font-semibold uppercase tracking-wider">Got it</button>
    </div>
  )
}

function Unsupported() {
  return (
    <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm">
      <p className="font-medium">Your browser cannot install apps directly.</p>
      <ul className="mt-2 grid gap-1 text-ink-foreground/75">
        <li>&bull; Open this site in <b>Chrome</b> or <b>Edge</b> and choose <b>Install app</b>.</li>
        <li>&bull; On a Mac with Safari: <b>File &rarr; Add to Dock</b>.</li>
        <li>&bull; On Android Firefox: menu &rarr; <b>Add app to Home screen</b>.</li>
      </ul>
    </div>
  )
}
