// admin-users: owner-only user management that needs the service role (create users, deactivate, reset password).
// Service role key never leaves this function. Everything else in staff management goes straight through RLS.
import { z } from 'npm:zod@3.24.1'
import { HttpError, json, readJson, serve } from '../_shared/http.ts'
import { serviceClient, staffFromRequest, requireOwner } from '../_shared/supabase.ts'

declare const Deno: { serve(h: (r: Request) => Promise<Response>): void }

const Create = z.object({
  action: z.literal('create'),
  email: z.string().email(),
  full_name: z.string().trim().min(2).max(80),
  phone: z.string().trim().max(20).optional(),
  password: z.string().min(10).max(72),
  role: z.enum(['owner', 'manager', 'cleaner']),
  property_ids: z.array(z.string().uuid()).max(50).default([]),
})
const SetActive = z.object({ action: z.literal('set_active'), user_id: z.string().uuid(), active: z.boolean() })
const ResetPassword = z.object({ action: z.literal('reset_password'), user_id: z.string().uuid(), password: z.string().min(10).max(72) })
const Body = z.discriminatedUnion('action', [Create, SetActive, ResetPassword])

Deno.serve(serve('admin-users', async (req, log) => {
  const db = serviceClient()
  const caller = requireOwner(await staffFromRequest(req, db))
  const parsed = Body.safeParse(await readJson(req))
  if (!parsed.success) throw new HttpError(400, 'invalid_input', parsed.error.issues[0]?.message ?? 'Invalid input.')
  const b = parsed.data

  if (b.action === 'create') {
    const created = await db.auth.admin.createUser({
      email: b.email, password: b.password, email_confirm: true,
      // The new user must pick their own password at first login.
      user_metadata: { full_name: b.full_name, must_change_password: true },
    })
    if (created.error || !created.data.user) {
      throw new HttpError(409, 'create_failed', /already/i.test(created.error?.message ?? '') ? 'A user with that email already exists.' : 'Could not create the user.')
    }
    const id = created.data.user.id
    const p = await db.from('profiles').insert({ id, full_name: b.full_name, phone: b.phone ?? null, active: true })
    if (p.error) { await db.auth.admin.deleteUser(id); throw new HttpError(500, 'profile_failed', 'Could not create the profile.') }
    await db.from('user_roles').insert({ user_id: id, role: b.role })
    if (b.property_ids.length) await db.from('staff_properties').insert(b.property_ids.map((property_id) => ({ user_id: id, property_id })))
    await db.from('audit_log').insert({ user_id: caller.userId, action: 'staff.created', entity: 'staff', entity_id: id, diff: { role: b.role } })
    log.info('staff created', { id, role: b.role })
    return json(req, { id })
  }

  if (b.action === 'set_active') {
    if (b.user_id === caller.userId && !b.active) throw new HttpError(400, 'self_deactivate', 'You cannot deactivate your own account.')
    const u = await db.from('profiles').update({ active: b.active }).eq('id', b.user_id)
    if (u.error) throw new HttpError(500, 'update_failed', 'Could not update the user.')
    // Ban for ~100 years to kill refresh tokens, or lift the ban. RLS already blocks inactive profiles instantly.
    await db.auth.admin.updateUserById(b.user_id, { ban_duration: b.active ? 'none' : '876000h' })
    await db.from('audit_log').insert({ user_id: caller.userId, action: b.active ? 'staff.activated' : 'staff.deactivated', entity: 'staff', entity_id: b.user_id })
    return json(req, { ok: true })
  }

  const r = await db.auth.admin.updateUserById(b.user_id, { password: b.password, user_metadata: { must_change_password: true } })
  if (r.error) throw new HttpError(500, 'reset_failed', 'Could not reset the password.')
  await db.from('audit_log').insert({ user_id: caller.userId, action: 'staff.password_reset', entity: 'staff', entity_id: b.user_id })
  return json(req, { ok: true })
}))
