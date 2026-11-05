// App installation state. Several signals, never one:
//   beforeinstallprompt  the browser says the app CAN be installed right now (so it is not installed), and hands us the native prompt
//   appinstalled         the browser says the app WAS installed
//   display-mode / navigator.standalone   we are running as an installed app
//   getInstalledRelatedApps (where it exists)   the browser lists the app as installed
// Nothing here stores "the visitor closed the popup": closing is forgotten when the page is left, so the invitation returns on the next
// visit until installation is confirmed. The only thing kept is "the browser reported an install" (cleared again if the browser later
// offers to install, which means the app was uninstalled). Analytics are anonymous counters with a random per-page-view id.
import { useSyncExternalStore } from 'react'
import { isSupabaseConfigured } from './config'

export type Platform = { os: 'android' | 'ios' | 'windows' | 'mac' | 'linux' | 'other'; browser: 'chrome' | 'edge' | 'samsung' | 'opera' | 'firefox' | 'safari' | 'other'; chromium: boolean; ios: boolean }
export type InviteKind = 'none' | 'native' | 'ios' | 'instructions'

/** Pure: what are we running in? `maxTouchPoints` catches iPadOS, which reports a Mac user agent. */
export function detectPlatform(ua: string, maxTouchPoints = 0): Platform {
  const iosDevice = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)
  const os: Platform['os'] = iosDevice ? 'ios' : /Android/.test(ua) ? 'android' : /Windows/.test(ua) ? 'windows' : /Mac OS X|Macintosh/.test(ua) ? 'mac' : /Linux|CrOS/.test(ua) ? 'linux' : 'other'
  let browser: Platform['browser'] = 'other'
  if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'edge'
  else if (/SamsungBrowser/.test(ua)) browser = 'samsung'
  else if (/OPR\/|Opera/.test(ua)) browser = 'opera'
  else if (/FxiOS|Firefox/.test(ua)) browser = 'firefox'
  else if (/CriOS|Chrome|Chromium/.test(ua)) browser = 'chrome'
  else if (/Safari/.test(ua)) browser = 'safari'
  // Every iPhone and iPad browser is WebKit underneath and uses the Share menu, whatever its name says.
  const chromium = !iosDevice && ['chrome', 'edge', 'samsung', 'opera'].includes(browser)
  return { os, browser, chromium, ios: iosDevice }
}

export const platformLabel = (p: Platform) => `${p.os}-${p.browser}`

export type InstallSnapshot = { standalone: boolean; installedFlag: boolean; installedByBrowser: boolean; hasPrompt: boolean; secure: boolean; platform: Platform }

/** Pure: should we invite this visitor, and how? */
export function decideInvite(s: InstallSnapshot): InviteKind {
  if (!s.secure) return 'none'                              // installation needs HTTPS (localhost counts)
  if (s.standalone) return 'none'                           // already running as the app
  if (s.hasPrompt) return 'native'                          // the browser itself says "installable now": proves it is not installed
  if (s.installedFlag || s.installedByBrowser) return 'none'
  if (s.platform.ios) return 'ios'                          // no install event on iPhone/iPad: show the Add to Home Screen steps
  if (s.platform.chromium) return 'none'                    // Chromium that offers no prompt is either installed or not installable: stay quiet
  return 'instructions'                                     // Firefox, desktop Safari...: explain, never show a button that cannot work
}

type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
type State = { prompt: BIPEvent | null; installedFlag: boolean; installedByBrowser: boolean; standalone: boolean; ready: boolean }

const FLAG = 'rgw-app-installed'
let state: State = { prompt: null, installedFlag: false, installedByBrowser: false, standalone: false, ready: false }
const listeners = new Set<() => void>()
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()) }

export const isStandalone = (): boolean =>
  typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || window.matchMedia?.('(display-mode: window-controls-overlay)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true)

function readFlag(): boolean { try { return window.localStorage.getItem(FLAG) === '1' } catch { return false } }
function writeFlag(on: boolean) { try { if (on) window.localStorage.setItem(FLAG, '1'); else window.localStorage.removeItem(FLAG) } catch { /* private mode: fine */ } }

// Visit id: random, in memory only, new on every page load. It only stops one page view being counted twice.
// Created on first use (never at module load: the Worker that imports this file forbids random values in global scope).
let visitId = ''
const visit = () => (visitId ||= typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '').slice(0, 24) : Math.random().toString(36).slice(2, 12) + Date.now().toString(36))

export function trackInstall(kind: 'impression' | 'click' | 'accepted' | 'declined' | 'installed' | 'app_open' | 'ios_instructions') {
  if (!isSupabaseConfigured || typeof window === 'undefined') return
  const label = platformLabel(detectPlatform(navigator.userAgent, navigator.maxTouchPoints))
  void import('./public-client').then(({ pub }) => Promise.resolve(pub().rpc('record_install_event', { p_kind: kind, p_platform: label, p_visit: visit() })).catch(() => undefined)).catch(() => undefined)
}

if (typeof window !== 'undefined') {
  // Registered when the bundle loads, so an early beforeinstallprompt is never missed.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()                                      // keep the event: the native prompt is only opened from the visitor's click
    writeFlag(false)                                        // the browser offers installation, so the app is not installed (it may have been uninstalled)
    set({ prompt: e as BIPEvent, installedFlag: false, installedByBrowser: false })
  })
  window.addEventListener('appinstalled', () => {
    writeFlag(true)
    set({ prompt: null, installedFlag: true })
    trackInstall('installed')
  })
  const sync = () => set({ standalone: isStandalone() })
  window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', sync)
  state = { ...state, installedFlag: readFlag(), standalone: isStandalone(), ready: true }
  // Extra signal where the browser can list installed apps (Chromium). Only ever used to SUPPRESS the invitation.
  const nav = navigator as unknown as { getInstalledRelatedApps?: () => Promise<unknown[]> }
  void nav.getInstalledRelatedApps?.().then((apps) => { if (apps.length > 0) set({ installedByBrowser: true }) }).catch(() => undefined)
  if (state.standalone) trackInstall('app_open')
}

const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l) }
const getSnapshot = () => state
const serverSnapshot: State = { prompt: null, installedFlag: false, installedByBrowser: false, standalone: false, ready: false }

export function usePwaState(): State & { platform: Platform; secure: boolean } {
  const s = useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot)
  const platform = typeof navigator === 'undefined' ? detectPlatform('') : detectPlatform(navigator.userAgent, navigator.maxTouchPoints)
  const secure = typeof window !== 'undefined' && (window.isSecureContext || ['localhost', '127.0.0.1'].includes(window.location.hostname))
  return { ...s, platform, secure }
}

export const inviteFor = (s: ReturnType<typeof usePwaState>): InviteKind =>
  s.ready ? decideInvite({ standalone: s.standalone, installedFlag: s.installedFlag, installedByBrowser: s.installedByBrowser, hasPrompt: !!s.prompt, secure: s.secure, platform: s.platform }) : 'none'

/** Open the browser's own install prompt. Must be called from a click. Returns what the visitor answered; "installed" is only ever set by appinstalled. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const p = state.prompt
  if (!p) return 'unavailable'
  set({ prompt: null })                                     // a deferred prompt can be used once
  await p.prompt()
  const { outcome } = await p.userChoice
  return outcome
}

/** Settings written by the owner (Admin > Settings > App installation). Every field has a safe default. */
export type AppInstallSettings = { enabled: boolean; headline: string; description: string; buttonText: string; subtext: string; image: string; appName: string; shortName: string; themeColor: string; backgroundColor: string }
export const DEFAULT_APP_INSTALL: AppInstallSettings = {
  enabled: true,
  headline: 'Take {name} With You',
  description: 'Install our app for a smoother booking experience. Explore accommodations, manage your reservations and enjoy exclusive member offers wherever you go.',
  buttonText: 'Install app',
  subtext: 'Enjoy a better stay experience with {name}.',
  image: '', appName: '', shortName: '', themeColor: '', backgroundColor: '',
}
const text = (v: unknown, max: number, d: string) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : d)
const hex = (v: unknown, d: string) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim() : d)
export function sanitizeAppInstall(raw: unknown): AppInstallSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_APP_INSTALL
  return {
    enabled: r.enabled !== false,
    headline: text(r.headline, 80, d.headline), description: text(r.description, 300, d.description), buttonText: text(r.buttonText, 30, d.buttonText), subtext: text(r.subtext, 120, d.subtext),
    image: typeof r.image === 'string' && /^https:\/\//.test(r.image) ? r.image : '', appName: text(r.appName, 45, ''), shortName: text(r.shortName, 12, ''),
    themeColor: hex(r.themeColor, ''), backgroundColor: hex(r.backgroundColor, ''),
  }
}
/** {name} in the owner's text becomes the business name. */
export const fillName = (s: string, name: string) => s.replace(/\{name\}/gi, name)
