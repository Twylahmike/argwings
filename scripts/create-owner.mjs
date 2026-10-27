// Creates the first owner account (auth user + profile + owner role) using the service role key.
// Usage:  OWNER_EMAIL=you@example.com OWNER_PASSWORD='a-strong-password' OWNER_NAME='Your Name' npm run create-owner
// (or put them in .env, or pass --email --password --name). No default password exists anywhere in the repo.
import { adminClient, need } from './_env.mjs'

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`)
  return i > -1 ? process.argv[i + 1] : undefined
}
const email = arg('email') || need('OWNER_EMAIL')
const password = arg('password') || need('OWNER_PASSWORD')
const name = arg('name') || process.env.OWNER_NAME || 'Owner'
if (password.length < 10) {
  console.error('Use a password of at least 10 characters.')
  process.exit(1)
}

const sb = await adminClient()
let userId
const created = await sb.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name } })
if (created.error) {
  if (!/already|registered|exists/i.test(created.error.message)) throw created.error
  const list = await sb.auth.admin.listUsers({ perPage: 1000 })
  userId = list.data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())?.id
  if (!userId) throw created.error
  console.log('User already exists, making sure the owner role is set.')
} else {
  userId = created.data.user.id
}
const p = await sb.from('profiles').upsert({ id: userId, full_name: name, active: true })
if (p.error) throw p.error
const r = await sb.from('user_roles').upsert({ user_id: userId, role: 'owner' })
if (r.error) throw r.error
console.log(`Owner ready: ${email}. Sign in at /login.`)
