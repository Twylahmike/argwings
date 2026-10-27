import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { HttpError } from './http.ts'

declare const Deno: { env: { get(k: string): string | undefined } }

/** Service-role client. Bypasses RLS: only use after you have authorised the caller yourself. */
export function serviceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

export type Caller = { userId: string; roles: string[]; propertyIds: string[] }

/**
 * Resolves the staff member behind a user JWT. Returns null for a bad token, a deactivated user, or a user with no role.
 * Edge functions that act for staff call this and then re-check property access themselves.
 */
export async function staffFromRequest(req: Request, db: SupabaseClient): Promise<Caller | null> {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  const { data, error } = await db.auth.getUser(token)
  if (error || !data.user) return null
  const uid = data.user.id
  const [profile, roles, props] = await Promise.all([
    db.from('profiles').select('active').eq('id', uid).maybeSingle(),
    db.from('user_roles').select('role').eq('user_id', uid),
    db.from('staff_properties').select('property_id').eq('user_id', uid),
  ])
  if (!profile.data?.active || !roles.data?.length) return null
  return {
    userId: uid,
    roles: roles.data.map((r) => r.role as string),
    propertyIds: (props.data ?? []).map((p) => p.property_id as string),
  }
}

export function canManageProperty(c: Caller, propertyId: string): boolean {
  return c.roles.includes('owner') || (c.roles.includes('manager') && c.propertyIds.includes(propertyId))
}

export function requireOwner(c: Caller | null): Caller {
  if (!c || !c.roles.includes('owner')) throw new HttpError(403, 'forbidden', 'Only the owner can do this.')
  return c
}
