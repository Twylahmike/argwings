import { PostgrestClient } from '@supabase/postgrest-js'
import { supabaseAnonKey, supabaseUrl } from './config'

let client: PostgrestClient | null = null

/**
 * Light anonymous data client (PostgREST only, about 30KB) for the PUBLIC pages: properties, units, availability RPCs,
 * booking-by-token and receipts. The full supabase-js client (auth, realtime, storage) is only loaded for staff pages,
 * which keeps the guest site fast on mobile networks. Everything it can read is limited by RLS / SECURITY DEFINER RPCs.
 */
export function pub(): PostgrestClient {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example).')
  }
  client ??= new PostgrestClient(`${supabaseUrl}/rest/v1`, { headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` } })
  return client
}
