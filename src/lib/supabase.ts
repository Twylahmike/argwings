import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { supabaseAnonKey as anon, supabaseUrl as url } from './config'

export { isSupabaseConfigured, functionsUrl } from './config'
import { registerTokenProvider } from './functions'
export { callFunction, FunctionError } from './functions'

let browserClient: SupabaseClient | null = null
let serverClient: SupabaseClient | null = null

/**
 * Full client for STAFF pages (auth, realtime, storage). Public pages use ./public-client instead.
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

registerTokenProvider(async () => (await sb().auth.getSession()).data.session?.access_token)
