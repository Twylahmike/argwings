// The web app manifest, built from the owner's settings (name, colours) so branding changes need no code change.
// Icons are the fixed files in /public (192 and 512, plus maskable versions with a safe zone).
import type { AppInstallSettings } from './pwa'

export const DEFAULT_THEME = '#a9761f'
export const DEFAULT_BACKGROUND = '#f7f1ec'

const shortOf = (name: string) => (name.length <= 12 ? name : name.split(/\s+/).slice(0, 2).join(' ').slice(0, 12).trim())

export function buildManifest(origin: string, opts: { businessName: string; brandColor?: string; app: AppInstallSettings }) {
  const name = opts.app.appName || opts.businessName || 'RG Wings Stays'
  const theme = opts.app.themeColor || (/^#[0-9a-fA-F]{6}$/.test(opts.brandColor ?? '') ? (opts.brandColor as string) : DEFAULT_THEME)
  return {
    name,
    short_name: opts.app.shortName || shortOf(name),
    description: `Premium ${name} accommodation booking application.`,
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'portrait',
    background_color: opts.app.backgroundColor || DEFAULT_BACKGROUND,
    theme_color: theme,
    lang: 'en',
    categories: ['travel', 'lifestyle'],
    icons: [
      { src: '/app-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/app-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/app-icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/app-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Search availability', url: '/search', icons: [{ src: '/app-icon-192.png', sizes: '192x192' }] },
      { name: 'My account', url: '/account', icons: [{ src: '/app-icon-192.png', sizes: '192x192' }] },
      { name: 'Staff dashboard', url: '/admin', icons: [{ src: '/app-icon-192.png', sizes: '192x192' }] },
    ],
    // Lets Chromium tell us (getInstalledRelatedApps) that this very app is already installed.
    related_applications: [{ platform: 'webapp', url: `${origin}/manifest.webmanifest` }],
    prefer_related_applications: false,
  }
}
