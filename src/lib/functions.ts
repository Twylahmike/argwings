import { functionsUrl, supabaseAnonKey } from './config'

/** Edge-function errors come back as { error: { code, message } } and are thrown as FunctionError. */
export class FunctionError extends Error {
  constructor(message: string, public code: string, public status: number) {
    super(message)
  }
}

type TokenProvider = () => Promise<string | undefined>
let tokenProvider: TokenProvider | null = null
/** The staff auth client registers itself here when it is loaded, so this module never imports it (keeps the guest bundle small). */
export function registerTokenProvider(fn: TokenProvider) {
  tokenProvider = fn
}

/**
 * Calls an edge function. Guests (no login) pass { auth: false } so the heavy auth client is never loaded;
 * staff calls (default) send the signed-in user's access token.
 */
export async function callFunction<T>(name: string, body: unknown, opts: { auth?: boolean } = {}): Promise<T> {
  let token = supabaseAnonKey
  if (opts.auth !== false && tokenProvider) token = (await tokenProvider()) ?? supabaseAnonKey
  const res = await fetch(`${functionsUrl}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: supabaseAnonKey ?? '', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  let json: unknown = null
  try { json = await res.json() } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string } } | null)?.error
    throw new FunctionError(e?.message ?? 'Request failed. Please try again.', e?.code ?? 'error', res.status)
  }
  return json as T
}
