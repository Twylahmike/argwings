// Optional alternative to `supabase functions serve`: runs every edge function as a local Deno process and exposes
// them at http://127.0.0.1:54331/functions/v1/<name>. Useful where Docker cannot reach npm.org (corporate proxies)
// or when you want plain Deno stack traces. Uses the `deno` binary installed by `npm install`.
//   npm run dev:functions        then set VITE_FUNCTIONS_URL=http://127.0.0.1:54331/functions/v1 in .env
import { createServer, request as httpRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

config({ quiet: true })
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fnDir = join(root, 'supabase/functions')
const envFile = join(fnDir, '.env')
const fileEnv = existsSync(envFile)
  ? Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  : {}
const PORT = Number(process.env.FUNCTIONS_PORT ?? 54331)
const deno = join(root, 'node_modules/.bin', process.platform === 'win32' ? 'deno.cmd' : 'deno')
const names = readdirSync(fnDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_') && existsSync(join(fnDir, d.name, 'index.ts'))).map((d) => d.name)
const ports = new Map(names.map((n, i) => [n, PORT + 1 + i]))

const env = {
  ...process.env, ...fileEnv,
  SUPABASE_URL: process.env.SUPABASE_URL ?? fileEnv.SUPABASE_URL ?? 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? fileEnv.SUPABASE_SERVICE_ROLE_KEY ?? '',
  MPESA_CALLBACK_BASE_URL: process.env.MPESA_CALLBACK_BASE_URL ?? fileEnv.MPESA_CALLBACK_BASE_URL ?? `http://127.0.0.1:${PORT}`,
}
const children = [...ports].map(([name, port]) => {
  const c = spawn(deno, ['run', '--allow-all', '--no-lock', '--node-modules-dir=none', '--config', join(root, 'scripts/deno.check.json'), join(fnDir, name, 'index.ts')],
    { env: { ...env, DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${port}` }, stdio: ['ignore', 'inherit', 'inherit'] })
  c.on('exit', (code) => console.log(`[${name}] exited (${code})`))
  return c
})
createServer((req, res) => {
  const m = /^\/functions\/v1\/([\w-]+)/.exec(req.url ?? '')
  const port = m && ports.get(m[1])
  if (!port) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":{"code":"not_found","message":"Unknown function"}}'); return }
  const up = httpRequest({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res) })
  up.on('error', () => { res.writeHead(502); res.end('{"error":{"code":"upstream","message":"Function is starting, retry in a moment"}}') })
  req.pipe(up)
}).listen(PORT, '127.0.0.1', () => console.log(`Edge functions on http://127.0.0.1:${PORT}/functions/v1/<name>  (${names.join(', ')})`))
const stop = () => { children.forEach((c) => c.kill()); process.exit(0) }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
