// Boots a throwaway PostgreSQL cluster for the SQL tests (no Docker needed).
// Used by run-sql-tests.mjs when DATABASE_URL is not set. Works with any local PostgreSQL 14+ install.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function findPgBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN
  try {
    const dir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim()
    if (existsSync(join(dir, process.platform === 'win32' ? 'initdb.exe' : 'initdb'))) return dir
  } catch { /* fall through */ }
  const roots = ['/usr/lib/postgresql', '/opt/homebrew/opt', 'C:/Program Files/PostgreSQL']
  for (const r of roots) {
    if (!existsSync(r)) continue
    for (const v of readdirSync(r).sort().reverse()) {
      for (const sub of ['bin', 'libexec/bin']) {
        const d = join(r, v, sub)
        if (existsSync(join(d, process.platform === 'win32' ? 'initdb.exe' : 'initdb'))) return d
      }
    }
  }
  throw new Error('PostgreSQL binaries not found. Install PostgreSQL, set PG_BIN, or set DATABASE_URL to a Supabase/Postgres database.')
}

export function startTempPostgres(port = 54329) {
  const bin = findPgBin()
  const exe = (n) => join(bin, process.platform === 'win32' ? `${n}.exe` : n)
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
  const dir = mkdtempSync(join(tmpdir(), 'bnb-pg-'))
  const wrap = (cmd, args) => (asRoot ? ['runuser', ['-u', 'postgres', '--', cmd, ...args]] : [cmd, args])
  if (asRoot) execFileSync('chown', ['postgres', dir])
  const run = (cmd, args) => {
    const [c, a] = wrap(cmd, args)
    const r = spawnSync(c, a, { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`)
  }
  run(exe('initdb'), ['-D', join(dir, 'data'), '-U', 'postgres', '--auth=trust', '-E', 'UTF8'])
  run(exe('pg_ctl'), ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, '-l', join(dir, 'log'), '-w', 'start'])
  const stop = () => {
    try { run(exe('pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', 'stop']) } catch { /* already stopped */ }
    rmSync(dir, { recursive: true, force: true })
  }
  return { url: `postgresql://postgres@127.0.0.1:${port}/postgres`, stop }
}
