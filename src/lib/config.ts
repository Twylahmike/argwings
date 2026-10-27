export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)
export const functionsUrl =
  (import.meta.env.VITE_FUNCTIONS_URL as string | undefined) || (supabaseUrl ? `${supabaseUrl}/functions/v1` : '')
