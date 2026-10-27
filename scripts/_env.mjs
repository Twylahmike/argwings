// Tiny helper shared by the scripts: loads .env / .env.local and fails with a clear message.
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
config({ path: '.env', quiet: true })

export function need(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing ${name}. Set it in .env (see .env.example) or in your shell.`)
    process.exit(1)
  }
  return v
}

export async function adminClient() {
  const { createClient } = await import('@supabase/supabase-js')
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  if (!url) {
    console.error('Missing SUPABASE_URL (or VITE_SUPABASE_URL).')
    process.exit(1)
  }
  return createClient(url, need('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } })
}

export const LOCAL_DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
