// Regenerates the paste-ready SQL bundles from supabase/migrations (0009 and later):
//   docs/sql/apply_pending.sql  - for the LIVE project that already has 0001-0008. Each part is skipped if its marker exists.
//   docs/sql/ALL_IN_ONE.sql     - the fresh-install block for 0009+ is refreshed in place.
// Add a marker for every new migration: a table ('t:name'), a function ('f:name(args)') or a column ('c:table.column').
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'

const MARKERS = {
  '0009': 't:booking_requests', '0010': 'f:dashboard_overview(date,date,uuid)', '0011': 't:support_tickets', '0012': 't:discount_codes',
  '0013': 'c:guests.vip', '0014': 't:booking_charges', '0015': 't:blocked_ranges', '0016': 't:media_assets', '0017': 't:expense_categories',
  '0018': 't:contact_numbers', '0019': 't:bar_products', '0020': 't:permissions_catalog', '0021': 'f:global_search(text)', '0022': "s:position('elsif tg_table_name = ''message_log'' then' in pg_get_functiondef('public.trg_notify_more()'::regprocedure)) = 0", '0023': 't:booking_changes', '0024': 't:stay_discounts', '0025': 't:housekeeping_task_photos', '0026': 't:site_pages', '0027': 'c:properties.video_url',
}
const dir = 'supabase/migrations'
const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f) && f.slice(0, 4) >= '0009').sort()
const cond = (m) => {
  if (m.startsWith('s:')) return m.slice(2)
  const [k, v] = m.split(':')
  if (k === 't') return `to_regclass('public.${v}') is null`
  if (k === 'f') return `to_regprocedure('public.${v}') is null`
  const [t, c] = v.split('.')
  return `not exists (select 1 from information_schema.columns where table_schema='public' and table_name='${t}' and column_name='${c}')`
}
let pending = `-- apply_pending.sql: paste into the Supabase SQL Editor of project "bnb-system" (ref bxpgpzrtoxjmynyjnfkg) and press Run.
-- Applies migrations ${files[0].slice(0, 4)} to ${files.at(-1).slice(0, 4)}. Safe to re-run: each part is skipped if it is already there.
-- Stops without changes if this is the wrong project or migration 0008 is missing.
do $apply$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'STOP: this is not the RG Wings project (no bookings table). Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='units' and column_name='maintenance_status') then
    raise exception 'STOP: apply migration 0008 first. Nothing was changed.';
  end if;
`
let fresh = ''
for (const f of files) {
  const n = f.slice(0, 4)
  const body = readFileSync(`${dir}/${f}`, 'utf8').trimEnd()
  if (!MARKERS[n]) throw new Error(`No marker for ${f}`)
  if (body.includes(`$m${n}$`) || body.includes(`$mig${Number(n)}$`)) throw new Error(`${f} contains the bundle quote tag`)
  pending += `  if ${cond(MARKERS[n])} then\n    execute $m${n}$\n${body}\n\n$m${n}$;\n    raise notice 'Applied ${n}';\n  else\n    raise notice '${n} already applied, skipped';\n  end if;\n`
  fresh += `    -- ---- ${f} ----\n    execute $mig${Number(n)}$\n${body}\n\n$mig${Number(n)}$;\n`
}
pending += 'end\n$apply$;\n'
writeFileSync('docs/sql/apply_pending.sql', pending)
// The same thing in four smaller pastes (a phone's SQL editor copes better). Run them in order; each is guarded and re-runnable.
const header = pending.slice(0, pending.indexOf('  if ' + cond(MARKERS[files[0].slice(0, 4)])))
const parts = [['0009', '0011'], ['0012', '0014'], ['0015', '0018'], ['0019', '0021'], ['0022', '0027']]
const blocks = new Map()
for (const f of files) {
  const n = f.slice(0, 4)
  const a = pending.indexOf('  if ' + cond(MARKERS[n]) + ' then\n    execute $m' + n + '$')
  const b = pending.indexOf("    raise notice '" + n + " already applied, skipped';\n  end if;\n", a) + ("    raise notice '" + n + " already applied, skipped';\n  end if;\n").length
  blocks.set(n, pending.slice(a, b))
}
parts.forEach(([from, to], i) => {
  const body = [...blocks].filter(([n]) => n >= from && n <= to).map(([, t]) => t).join('')
  writeFileSync(`docs/sql/apply_part${i + 1}.sql`, header.replace(/-- Applies migrations[^\n]*/, `-- PART ${i + 1} of ${parts.length}: migrations ${from} to ${to}. Run the parts in order.`) + body + 'end\n$apply$;\n')
})
let all = readFileSync('docs/sql/ALL_IN_ONE.sql', 'utf8')
const start = all.indexOf('    -- ---- 0009_')
const end = all.indexOf('end\n$install$;')
if (start < 0 || end < 0) throw new Error('ALL_IN_ONE markers not found')
all = all.slice(0, start) + fresh + all.slice(end)
writeFileSync('docs/sql/ALL_IN_ONE.sql', all)
console.log(`bundled ${files.length} migrations`)
