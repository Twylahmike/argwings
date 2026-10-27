import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseConfigured = Boolean(url && anon)

let browserClient: SupabaseClient | null = null
let serverClient: SupabaseClient | null = null

/**
 * Browser: one persistent-session client (staff login). Server (SSR of public pages): a stateless anon client.
 * Only the anon key ever reaches this file. The service role key lives in edge functions and scripts only.
 */
export function sb(): SupabaseClient {
  if (!url || !anon) {
    throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example).')
  }
  if (typeof window === 'undefined') {
    serverClient ??= createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } })
    return serverClient
  }
  browserClient ??= createClient(url, anon, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } })
  return browserClient
}

export const functionsUrl = url ? `${url}/functions/v1` : ''

/** Calls an edge function. Errors come back as { error: { code, message } } and are thrown as Error with .code/.status. */
export class FunctionError extends Error {
  constructor(message: string, public code: string, public status: number) {
    super(message)
  }
}

export async function callFunction<T>(name: string, body: unknown): Promise<T> {
  const client = sb()
  const { data: sess } = await client.auth.getSession()
  const res = await fetch(`${functionsUrl}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anon!,
      Authorization: `Bearer ${sess.session?.access_token ?? anon}`,
    },
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
