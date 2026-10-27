import { redirect } from '@tanstack/react-router'
import { sb } from './supabase'
import type { AppRole } from './types'

export type StaffProperty = { id: string; name: string; slug: string; active: boolean; sort: number }
export type Me = {
  id: string
  email: string
  fullName: string
  roles: AppRole[]
  propertyIds: string[]
  properties: StaffProperty[]
  mustChangePassword: boolean
}

export const isOwner = (me: Me) => me.roles.includes('owner')
/** Owner or manager (anyone who can see bookings and money). */
export const canManage = (me: Me) => me.roles.includes('owner') || me.roles.includes('manager')
export const isCleanerOnly = (me: Me) => !canManage(me)
export const homePath = (me: Me) => (canManage(me) ? '/admin' : '/admin/housekeeping')

/**
 * Loads the signed-in staff member with roles and the properties they may work in.
 * Returns null (and signs out) for anonymous users, deactivated accounts and users with no role.
 * This only drives UI; the real enforcement is RLS in the database.
 */
export async function fetchMe(): Promise<Me | null> {
  const client = sb()
  const { data } = await client.auth.getSession()
  const user = data.session?.user
  if (!user) return null

  const [profile, roles, links] = await Promise.all([
    client.from('profiles').select('id, full_name, active').eq('id', user.id).maybeSingle(),
    client.from('user_roles').select('role').eq('user_id', user.id),
    client.from('staff_properties').select('property_id').eq('user_id', user.id),
  ])
  if (!profile.data || !profile.data.active || !roles.data?.length) {
    await client.auth.signOut()
    return null
  }
  const roleList = roles.data.map((r) => r.role as AppRole)
  const owner = roleList.includes('owner')
  const propertyIds = (links.data ?? []).map((l) => l.property_id as string)

  let q = client.from('properties').select('id, name, slug, active, sort').order('sort').order('name')
  if (!owner) q = q.in('id', propertyIds.length ? propertyIds : ['00000000-0000-0000-0000-000000000000'])
  const props = await q

  return {
    id: user.id,
    email: user.email ?? '',
    fullName: profile.data.full_name,
    roles: roleList,
    propertyIds,
    properties: (props.data ?? []) as StaffProperty[],
    mustChangePassword: user.user_metadata?.must_change_password === true,
  }
}

/** Use inside a route's beforeLoad. UI guard only; RLS is the real wall. */
export function requireRole(me: Me, allowed: AppRole[]) {
  if (!me.roles.some((r) => allowed.includes(r))) {
    throw redirect({ to: homePath(me) })
  }
}
