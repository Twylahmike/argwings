# Installable app (PWA)

The website installs as an app on Android, iPhone/iPad and desktop. A branded popup invites visitors to install it.

## How the invitation behaves

- It appears on public pages, about a second and a half after the page opens, on **every visit**, until installation is confirmed.
- Closing it (X, "Not now", Escape, a tap outside) hides it for that page view only. **Nothing is stored about dismissal**, so it returns next visit.
- It stays out of checkout (`/book`, `/booking`, `/receipt`), sign in, sign up, password reset, admin and the install page.
- **Android Chrome/Edge/Samsung and desktop Chrome/Edge**: when the browser fires `beforeinstallprompt` the popup shows INSTALL APP. The native prompt opens only from that click. If the visitor declines, nothing is marked installed and the invitation returns next visit. If they accept, the popup says "Finishing installation" and only the browser's `appinstalled` event produces "Installed".
- **iPhone/iPad (every browser)**: there is no install event, so the popup shows INSTALL APP and then the steps: Share, Add to Home Screen, Add. Reading the steps is never treated as an install. The invitation stops once the site is opened from the Home Screen (standalone).
- **Browsers that cannot install** (Firefox desktop, Safari on Mac): the popup explains how to install from Chrome/Edge or the browser menu. No button.
- **Chromium that offers no prompt** (already installed, or not installable): nothing is shown.

## Installed state

Signals used together: `beforeinstallprompt` (installable now, so not installed), `appinstalled`, `display-mode: standalone` / `navigator.standalone`, and `getInstalledRelatedApps` where it exists. The only thing stored is a flag that the browser reported an install; it is cleared again if the browser later offers installation (the app was uninstalled). Note: on iPhone/iPad the Home Screen app and Safari do not share storage, so a visitor who keeps using Safari after installing will still see the iOS invitation; that cannot be detected.

## Owner controls

Admin > Settings > **App installation**: on/off, headline, description, button text, small line, promotional image (media library), app name, short name, theme colour and splash background colour (empty = business name and brand colour). `{name}` in the text becomes the business name. The icons are fixed files in `public/`.

The manifest is served by the Worker from these settings (`/manifest.webmanifest`, cached 10 minutes). Run `docs/sql/apply_part11.sql` for the settings to be publicly readable and for the numbers below.

## Numbers (honest)

Anonymous counters: invitations shown, install button presses, accepted and declined in the browser's own prompt, installs the browser reported, iOS instruction views, and opens of the installed app, with a per-platform table. They count **page views, not people** (the visit id lives in memory for one page view). Browsers do not report every install and iOS reports none, so treat installs as a lower bound.

## Service worker

`public/sw.js` (cache version `v2`): hashed assets cache-first (bounded to 200), public pages network-first with an offline page, and it never touches `/admin`, `/booking`, `/receipt`, `/request`, `/login`, `/account`, `/auth`, password pages or API calls. The page checks for a new worker on load, hourly and when it becomes visible again. Bump `VERSION` when the worker's behaviour changes.

## Testing

`npx vite build && npx vite preview --port 4173` then `node tests/e2e/install.cjs` runs 40 checks in headless Chromium with simulated install events and user agents (Android, desktop Edge, iPhone Safari, standalone, Firefox). It proves our logic reacts correctly to each signal; it cannot perform a real install on a device, so do one real install on a phone and a computer after deploying (HTTPS is required; localhost also works).
