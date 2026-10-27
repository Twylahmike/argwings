// Applies supabase/seed.sql (re-runnable). Needs a direct Postgres connection string.
//   Local Supabase default:  postgresql://postgres:postgres@127.0.0.1:54322/postgres
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { LOCAL_DB } from './_env.mjs'

const url = process.env.DATABASE_URL || LOCAL_DB
const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  await client.query(readFileSync(new URL('../supabase/seed.sql', import.meta.url), 'utf8'))
  const { rows } = await client.query(`select (select count(*) from properties) props, (select count(*) from bookings) bookings`)
  console.log(`Seed applied. ${rows[0].props} properties, ${rows[0].bookings} bookings.`)
} finally {
  await client.end()
}
