// Supabase email links (verify email, reset password, change email) return to the site with tokens in the URL.
// Our client has detectSessionInUrl off (so it never runs on public pages), so the few pages that receive those links read them here.
export type LinkResult = { ok: true; type: string | null } | { ok: false; reason: string }

export async function sessionFromUrl(): Promise<LinkResult> {
  const { sb } = await import('./supabase')
  const c = sb()
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const query = new URLSearchParams(window.location.search)
  const err = hash.get('error_description') || query.get('error_description')
  if (err) return { ok: false, reason: err }
  const code = query.get('code')
  const at = hash.get('access_token')
  const rt = hash.get('refresh_token')
  const type = hash.get('type') || query.get('type')
  if (code) {
    const { error } = await c.auth.exchangeCodeForSession(code)
    if (error) return { ok: false, reason: error.message }
  } else if (at && rt) {
    const { error } = await c.auth.setSession({ access_token: at, refresh_token: rt })
    if (error) return { ok: false, reason: error.message }
  } else {
    // No token in the URL: fine if the visitor already has a session (for example they reloaded the page).
    const { data } = await c.auth.getSession()
    if (!data.session) return { ok: false, reason: 'This link is not valid any more.' }
  }
  // Keep tokens out of the address bar and browser history.
  window.history.replaceState(null, '', window.location.pathname)
  return { ok: true, type }
}
