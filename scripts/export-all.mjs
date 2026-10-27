// Backup helper: dumps every business table to CSV files in ./exports/<timestamp>/ using the service role.
// Complements (does not replace) Supabase daily backups / PITR. See DEPLOY.md.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { adminClient } from './_env.mjs'

const tables = ['properties', 'units', 'rate_overrides', 'guests', 'bookings', 'payments', 'housekeeping_tasks', 'expenses', 'message_log', 'settings', 'profiles', 'user_roles', 'staff_properties', 'audit_log']
const sb = await adminClient()
const dir = join('exports', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(dir, { recursive: true })
const esc = (v) => {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
for (const t of tables) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(t).select('*').range(from, from + 999)
    if (error) throw new Error(`${t}: ${error.message}`)
    rows.push(...data)
    if (data.length < 1000) break
  }
  const cols = rows.length ? Object.keys(rows[0]) : []
  writeFileSync(join(dir, `${t}.csv`), [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'))
  console.log(`${t}: ${rows.length} rows`)
}
console.log(`Exported to ${dir}`)
