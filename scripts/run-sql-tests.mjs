// Runs tests/sql/*.test.mjs.
//  * With DATABASE_URL set: runs against that database (e.g. `supabase start`, which has migrations applied).
//    The database must be disposable: tests create their own rows but the P&L test also reads seed data.
//  * Without it: boots a temporary local PostgreSQL, applies the shim + migrations + seed, runs the tests, tears down.
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { startTempPostgres } from './pg-temp.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let url = process.env.DATABASE_URL
let tmp = null

async function applyFiles(client, files) {
  for (const f of files) {
    try { await client.query(readFileSync(f, 'utf8')) } catch (e) { throw new Error(`${f}: ${e.message}`) }
  }
}

try {
  if (!url) {
    tmp = startTempPostgres()
    url = tmp.url
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    const migs = readdirSync(join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort()
    await applyFiles(client, [
      join(root, 'tests/sql/00_supabase_shim.sql'),
      ...migs.map((f) => join(root, 'supabase/migrations', f)),
      join(root, 'supabase/seed.sql'),
    ])
    await client.end()
  }
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', join(root, 'tests/sql/db.test.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  })
  process.exitCode = r.status ?? 1
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
} finally {
  tmp?.stop()
}
