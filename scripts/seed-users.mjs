// Creates demo users owner@/manager@/cleaner@example.com. Requires DEMO_PASSWORD in the environment (never committed).
// Run `npm run seed` first so the properties exist. Re-runnable.
import { adminClient, need } from './_env.mjs'

const password = need('DEMO_PASSWORD')
if (password.length < 10) {
  console.error('DEMO_PASSWORD must be at least 10 characters.')
  process.exit(1)
}
const sb = await adminClient()
const props = (await sb.from('properties').select('id, slug').order('sort')).data ?? []
if (!props.length) {
  console.error('No properties found. Run `npm run seed` first.')
  process.exit(1)
}
const users = [
  { email: 'owner@example.com', name: 'Demo Owner', role: 'owner', props: [] },
  { email: 'manager@example.com', name: 'Demo Manager', role: 'manager', props: props.slice(0, 3) },
  { email: 'cleaner@example.com', name: 'Demo Cleaner', role: 'cleaner', props: props.slice(0, 2) },
]
const existing = (await sb.auth.admin.listUsers({ perPage: 1000 })).data.users
for (const u of users) {
  let id = existing.find((x) => x.email === u.email)?.id
  if (id) await sb.auth.admin.updateUserById(id, { password, email_confirm: true })
  else {
    const c = await sb.auth.admin.createUser({ email: u.email, password, email_confirm: true, user_metadata: { full_name: u.name } })
    if (c.error) throw c.error
    id = c.data.user.id
  }
  await sb.from('profiles').upsert({ id, full_name: u.name, active: true })
  await sb.from('user_roles').delete().eq('user_id', id)
  await sb.from('user_roles').insert({ user_id: id, role: u.role })
  await sb.from('staff_properties').delete().eq('user_id', id)
  if (u.props.length) await sb.from('staff_properties').insert(u.props.map((p) => ({ user_id: id, property_id: p.id })))
  console.log(`${u.role.padEnd(8)} ${u.email}`)
}
