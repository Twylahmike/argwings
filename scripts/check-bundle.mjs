// Fails if the browser bundle contains anything that looks like a Supabase service-role / secret key.
// Run after `npm run build` (CI should too). Scans every file in dist/client.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = 'dist/client'
const bad = []
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) { walk(p); continue }
    if (!/\.(js|mjs|css|html|json|map)$/.test(f)) continue
    const text = readFileSync(p, 'utf8')
    if (/sb_secret_[A-Za-z0-9_-]{10,}/.test(text)) bad.push(`${p}: sb_secret_ key`)
    for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)) {
      try {
        const payload = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'))
        if (payload.role === 'service_role') bad.push(`${p}: service_role JWT`)
      } catch { /* not a JWT */ }
    }
    if (/SUPABASE_SERVICE_ROLE_KEY|MPESA_CONSUMER_SECRET|MPESA_PASSKEY|WHATSAPP_TOKEN/.test(text)) bad.push(`${p}: secret variable name`)
  }
}
walk(root)
if (bad.length) { console.error('SECRET LEAK in browser bundle:\n' + bad.join('\n')); process.exit(1) }
console.log('Bundle check passed: no service-role key or secret names in dist/client.')
