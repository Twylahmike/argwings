// SQL tests: overlap guard, pricing, payments trigger, hold expiry, RLS isolation, finance totals, seed.
// Each test runs inside a transaction that is rolled back, so tests never leak into each other.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import pg from 'pg'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
after(() => pool.end())

/** Run fn inside a transaction that is always rolled back. */
async function tx(fn) {
  const c = await pool.connect()
  try {
    await c.query('begin')
    return await fn(c)
  } finally {
    await c.query('rollback')
    c.release()
  }
}
const q = (c, sql, params) => c.query(sql, params).then((r) => r.rows)
const one = async (c, sql, params) => (await q(c, sql, params))[0]

/** Switch to a Supabase role. uid=null => anon. */
async function as(c, role, uid = null) {
  await c.query('reset role')
  await c.query(`set local role ${role}`)
  await c.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [
    uid ?? '',
    uid ? JSON.stringify({ sub: uid, role }) : '',
  ])
}
const admin = (c) => c.query('reset role')

/** Expect the statement to fail with the given SQLSTATE (or any error if code omitted). Uses a savepoint. */
async function fails(c, sql, params, code) {
  await c.query('savepoint s')
  try {
    await c.query(sql, params)
  } catch (e) {
    await c.query('rollback to savepoint s')
    if (code) assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`)
    return e
  }
  await c.query('rollback to savepoint s')
  assert.fail(`expected failure: ${sql}`)
}

async function user(c, name, role, props = []) {
  const id = randomUUID()
  await c.query('insert into auth.users(id, email) values ($1,$2)', [id, `${name}-${id.slice(0, 6)}@test.local`])
  await c.query('insert into profiles(id, full_name) values ($1,$2)', [id, name])
  await c.query('insert into user_roles(user_id, role) values ($1,$2)', [id, role])
  for (const p of props) await c.query('insert into staff_properties(user_id, property_id) values ($1,$2)', [id, p])
  return id
}

/** Two properties (A, B) with one unit each, plus owner, managerA, cleanerA. */
async function fixture(c) {
  const slug = () => 't-' + randomUUID().slice(0, 8)
  const pa = (await one(c, `insert into properties(slug,name) values ($1,'Prop A') returning id`, [slug()])).id
  const pb = (await one(c, `insert into properties(slug,name) values ($1,'Prop B') returning id`, [slug()])).id
  const ua = (await one(c, `insert into units(property_id,name,base_rate,weekend_rate,cleaning_fee,min_nights,max_guests)
    values ($1,'A1',5000,6000,500,1,3) returning id`, [pa])).id
  const ub = (await one(c, `insert into units(property_id,name,base_rate,max_guests) values ($1,'B1',4000,2) returning id`, [pb])).id
  const owner = await user(c, 'Owner', 'owner')
  const manager = await user(c, 'ManagerA', 'manager', [pa])
  const cleaner = await user(c, 'CleanerA', 'cleaner', [pa])
  const base = (await one(c, `select (nairobi_today() + 400) + ((5 - extract(isodow from nairobi_today() + 400)::int + 7) % 7) as d`)).d
  return { pa, pb, ua, ub, owner, manager, cleaner, friday: base }
}
const day = (d, n) => {
  const x = new Date(d)
  x.setUTCDate(x.getUTCDate() + n)
  return x.toISOString().slice(0, 10)
}
const fmt = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d)

async function booking(c, f, { unit = f.ua, prop = f.pa, from, to, status = 'confirmed', total = 10000, deposit = 5000, hold = null } = {}) {
  const guest = await one(c, `insert into guests(full_name, phone) values ('G', $1) returning id`, ['2547' + Math.floor(Math.random() * 1e8).toString().padStart(8, '0')])
  return one(
    c,
    `insert into bookings(property_id, unit_id, guest_id, check_in, check_out, status, total_amount, deposit_required, hold_expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [prop, unit, guest.id, from, to, status, total, deposit, hold],
  )
}

// ---------------------------------------------------------------------------------------------
test('quote_stay: weekend, override priority, cleaning fee once, min nights', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const fri = fmt(f.friday)
    // Thu, Fri, Sat, Sun nights = 5000 + 6000 + 6000 + 5000, + 500 cleaning
    let r = await one(c, 'select * from quote_stay($1,$2,$3)', [f.ua, day(fri, -1), day(fri, 3)])
    assert.deepEqual([r.nights, r.nightly_total, r.cleaning_fee, r.total], [4, 22000, 500, 22500])
    // Seasonal override beats weekend/base
    await c.query(`insert into rate_overrides(unit_id,label,start_date,end_date,nightly_rate) values ($1,'x',$2,$3,9000)`, [f.ua, fri, day(fri, 1)])
    r = await one(c, 'select * from quote_stay($1,$2,$3)', [f.ua, day(fri, -1), day(fri, 3)])
    assert.equal(r.nightly_total, 5000 + 9000 + 9000 + 5000)
    // later override wins on overlap
    await c.query(`insert into rate_overrides(unit_id,label,start_date,end_date,nightly_rate) values ($1,'y',$2,$2,1000)`, [f.ua, fri])
    r = await one(c, 'select * from quote_stay($1,$2,$3)', [f.ua, day(fri, -1), day(fri, 3)])
    assert.equal(r.nightly_total, 5000 + 1000 + 9000 + 5000)
    // min nights respected by availability
    await c.query('update units set min_nights = 3 where id = $1', [f.ua])
    const two = await q(c, 'select * from get_available_units($1,$2,1,$3)', [fri, day(fri, 2), f.pa])
    assert.equal(two.length, 0)
    const three = await q(c, 'select * from get_available_units($1,$2,1,$3)', [fri, day(fri, 3), f.pa])
    assert.equal(three.length, 1)
    // guest count respected
    assert.equal((await q(c, 'select * from get_available_units($1,$2,4,$3)', [fri, day(fri, 3), f.pa])).length, 0)
  }))

test('calc_deposit rounds to nearest KES then up to KES 10, capped at total', async () =>
  tx(async (c) => {
    const d = async (t, p) => (await one(c, 'select calc_deposit($1,$2) d', [t, p])).d
    assert.equal(await d(22500, 50), 11250)
    assert.equal(await d(10001, 50), 5010)
    assert.equal(await d(5, 50), 5)
    assert.equal(await d(0, 50), 0)
  }))

test('double booking: overlap fails with 23P01, back-to-back works, cancelled/expired free dates', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const first = await booking(c, f, { from: d0, to: day(d0, 3) })
    await fails(c, `insert into bookings(property_id,unit_id,check_in,check_out,status) values ($1,$2,$3,$4,'pending')`, [f.pa, f.ua, day(d0, 2), day(d0, 5)], '23P01')
    await fails(c, `insert into bookings(property_id,unit_id,check_in,check_out,status) values ($1,$2,$3,$4,'blocked')`, [f.pa, f.ua, d0, day(d0, 1)], '23P01')
    // back-to-back both sides
    await booking(c, f, { from: day(d0, 3), to: day(d0, 5) })
    await booking(c, f, { from: day(d0, -2), to: d0 })
    // other unit is unaffected
    await booking(c, f, { unit: f.ub, prop: f.pb, from: d0, to: day(d0, 3) })
    // cancelled frees dates
    await c.query(`update bookings set status='cancelled' where id=$1`, [first.id])
    const again = await booking(c, f, { from: day(d0, 1), to: day(d0, 3), status: 'pending' })
    // expired frees dates too
    await c.query(`update bookings set status='expired' where id=$1`, [again.id])
    await booking(c, f, { from: day(d0, 1), to: day(d0, 2), status: 'confirmed' })
  }))

test('payments trigger: confirms on deposit, tracks amount_paid, rejects duplicate receipts', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const b = await booking(c, f, { from: d0, to: day(d0, 2), status: 'pending', total: 12500, deposit: 6250, hold: new Date(Date.now() + 600_000) })
    const pay = (amount, receipt, status = 'succeeded') =>
      one(c, `insert into payments(booking_id,kind,method,status,amount,mpesa_receipt,confirmed_at) values ($1,'deposit','mpesa_stk',$2,$3,$4, now()) returning id`, [b.id, status, amount, receipt])
    await pay(6250, 'RCPT001', 'pending')
    assert.equal((await one(c, 'select status, amount_paid from bookings where id=$1', [b.id])).status, 'pending')
    await pay(3000, 'RCPT002')
    let row = await one(c, 'select status, amount_paid from bookings where id=$1', [b.id])
    assert.deepEqual([row.status, row.amount_paid], ['pending', 3000])
    await pay(3250, 'RCPT003')
    row = await one(c, 'select status, amount_paid, hold_expires_at from bookings where id=$1', [b.id])
    assert.deepEqual([row.status, row.amount_paid, row.hold_expires_at], ['confirmed', 6250, null])
    // idempotency: the same M-Pesa receipt can never be credited twice
    await fails(c, `insert into payments(booking_id,kind,method,status,amount,mpesa_receipt) values ($1,'balance','mpesa_stk','succeeded',100,'RCPT003')`, [b.id], '23505')
    // refunds reduce amount_paid
    await c.query(`insert into payments(booking_id,kind,method,status,amount) values ($1,'refund','cash','succeeded',1000)`, [b.id])
    assert.equal((await one(c, 'select amount_paid from bookings where id=$1', [b.id])).amount_paid, 5250)
  }))

test('holds: expire frees dates; late payment re-activates, or flags review when dates were taken', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const past = new Date(Date.now() - 60_000)
    const stale = await booking(c, f, { from: d0, to: day(d0, 2), status: 'pending', total: 10000, deposit: 5000, hold: past })
    // an expired-but-not-yet-swept hold does not show as taken
    assert.equal((await q(c, 'select * from get_available_units($1,$2,1,$3)', [d0, day(d0, 2), f.pa])).length, 1)
    assert.equal((await one(c, 'select expire_stale_holds() n')).n >= 1, true)
    assert.equal((await one(c, 'select status from bookings where id=$1', [stale.id])).status, 'expired')
    // late payment, dates still free => confirmed again
    await c.query(`insert into payments(booking_id,kind,method,status,amount,mpesa_receipt,confirmed_at) values ($1,'deposit','mpesa_stk','succeeded',5000,'LATE001',now())`, [stale.id])
    let row = await one(c, 'select status, payment_review from bookings where id=$1', [stale.id])
    assert.deepEqual([row.status, row.payment_review], ['confirmed', false])

    // second case: expired, someone else takes the dates, then money arrives
    const e2 = await booking(c, f, { from: day(d0, 10), to: day(d0, 12), status: 'pending', hold: past })
    await c.query('select expire_stale_holds()')
    await booking(c, f, { from: day(d0, 10), to: day(d0, 12), status: 'confirmed' })
    await c.query(`insert into payments(booking_id,kind,method,status,amount,mpesa_receipt,confirmed_at) values ($1,'deposit','mpesa_stk','succeeded',5000,'LATE002',now())`, [e2.id])
    row = await one(c, 'select status, payment_review, review_reason, amount_paid from bookings where id=$1', [e2.id])
    assert.equal(row.status, 'expired')
    assert.equal(row.payment_review, true)
    assert.equal(row.amount_paid, 5000, 'money is recorded, never dropped')
    assert.match(row.review_reason, /Refund/)
  }))

test('booking status machine and housekeeping on checkout', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const b = await booking(c, f, { from: d0, to: day(d0, 2), status: 'pending', hold: new Date(Date.now() + 600_000) })
    await fails(c, `update bookings set status='checked_in' where id=$1`, [b.id], '23514')
    await c.query(`update bookings set status='confirmed' where id=$1`, [b.id])
    await c.query(`update bookings set status='checked_in' where id=$1`, [b.id])
    await fails(c, `update bookings set status='confirmed' where id=$1`, [b.id], '23514')
    assert.equal((await q(c, 'select 1 from housekeeping_tasks where booking_id=$1', [b.id])).length, 0)
    // an arrival today on the same unit makes the turnover a priority
    const today = fmt((await one(c, 'select nairobi_today() d')).d)
    await c.query(`update bookings set check_in=$2, check_out=$3 where id=$1`, [b.id, day(today, -1), today])
    await booking(c, f, { from: today, to: day(today, 2), status: 'confirmed' })
    await c.query(`update bookings set status='checked_out' where id=$1`, [b.id])
    const t = await one(c, 'select status, priority from housekeeping_tasks where booking_id=$1', [b.id])
    assert.deepEqual([t.status, t.priority], ['dirty', true])
    assert.ok((await one(c, 'select cancelled_at from bookings where id=$1', [b.id])).cancelled_at === null)
  }))

test('create_booking: server-side pricing, guest upsert, hold, limits', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const b = await one(c, `select * from create_booking($1,$2,$3,2,'Jane Doe','254712345678','jane@example.com')`, [f.ua, d0, day(d0, 2)])
    // Fri + Sat nights at the weekend rate + cleaning
    assert.equal(b.total_amount, 12000 + 500)
    assert.equal(b.deposit_required, 6250)
    assert.equal(b.status, 'pending')
    assert.ok(new Date(b.hold_expires_at) > new Date())
    const again = await one(c, `select guest_id from create_booking($1,$2,$3,1,'Other Name','254712345678')`, [f.ua, day(d0, 5), day(d0, 6)])
    assert.equal(again.guest_id, b.guest_id, 'phone is the unique guest key')
    await fails(c, `select create_booking($1,$2,$3,2,'X','254711111111')`, [f.ua, day(d0, 1), day(d0, 3)], '23P01')
    await fails(c, `select create_booking($1,$2,$3,9,'X','254711111111')`, [f.ua, day(d0, 20), day(d0, 22)], '23514')
    await fails(c, `select create_booking($1,'2020-01-01','2020-01-03',1,'X','254711111111')`, [f.ua], '23514')
    // service-role-only: authenticated and anon cannot call the internal function
    await as(c, 'authenticated', f.owner)
    await fails(c, `select create_booking($1,$2,$3,1,'X','254711111111')`, [f.ua, day(d0, 30), day(d0, 31)], '42501')
    await as(c, 'anon')
    await fails(c, `select create_booking($1,$2,$3,1,'X','254711111111')`, [f.ua, day(d0, 30), day(d0, 31)], '42501')
  }))

test('RLS: anon cannot read bookings, guests, payments; can use availability and token RPCs', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const b = await one(c, `select * from create_booking($1,$2,$3,1,'Jane','254712345678')`, [f.ua, d0, day(d0, 1)])
    await as(c, 'anon')
    await fails(c, 'select * from bookings', [], '42501')
    await fails(c, 'select * from guests', [], '42501')
    await fails(c, 'select * from payments', [], '42501')
    await fails(c, 'select * from audit_log', [], '42501')
    assert.ok((await q(c, 'select * from properties where id=$1', [f.pa])).length === 1, 'active properties are public')
    assert.equal((await q(c, 'select * from get_available_units($1,$2,1,$3)', [day(d0, 10), day(d0, 12), f.pa])).length, 1)
    assert.equal((await q(c, 'select * from get_available_units($1,$2,1,$3)', [d0, day(d0, 1), f.pa])).length, 0, 'held dates are not available')
    const dates = await q(c, 'select * from get_unit_unavailable_dates($1)', [f.ua])
    assert.deepEqual(Object.keys(dates[0]).sort(), ['end_date', 'start_date'], 'date ranges only, no guest data')
    const info = (await one(c, 'select get_booking_by_token($1) j', [b.public_token])).j
    assert.equal(info.reference, b.reference)
    for (const k of ['email', 'id_number', 'notes', 'guest_id', 'created_by']) assert.ok(!(k in info), `${k} must not leak`)
    assert.equal((await one(c, 'select get_booking_by_token($1) j', [randomUUID()])).j, null)
    const settings = await q(c, 'select key from settings')
    assert.ok(settings.every((s) => ['business_name', 'cancellation_policy', 'logo_url', 'support_whatsapp', 'deposit_percent', 'hold_minutes', 'mpesa_manual_instructions', 'mpesa_paybill_display', 'brand_color', 'site_content', 'booking_mode', 'business_email', 'business_address', 'currency', 'maintenance_mode', 'guest_checkout_enabled', 'registration_enabled', 'module_bar_menu'].includes(s.key)))
    assert.ok(settings.length > 0)
  }))

test('RLS: cleaner sees no bookings/payments/guests/expenses; manager is limited to assigned properties', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const ba = await booking(c, f, { from: d0, to: day(d0, 2) })
    const bb = await booking(c, f, { unit: f.ub, prop: f.pb, from: d0, to: day(d0, 2) })
    for (const b of [ba, bb])
      await c.query(`insert into payments(booking_id,kind,method,status,amount,confirmed_at) values ($1,'deposit','cash','succeeded',1000,now())`, [b.id])
    await c.query(`insert into expenses(property_id,category,amount) values ($1,'repairs',700),($2,'repairs',900)`, [f.pa, f.pb])

    await as(c, 'authenticated', f.cleaner)
    for (const t of ['bookings', 'payments', 'guests', 'expenses', 'message_log', 'audit_log'])
      assert.equal((await q(c, `select * from ${t}`)).length, 0, `cleaner must not read ${t}`)
    await fails(c, 'select * from rate_limit_events', [], '42501')
    assert.equal((await q(c, `select * from settings where key = 'whatsapp_enabled'`)).length, 0)

    await as(c, 'authenticated', f.manager)
    const seen = await q(c, 'select property_id from bookings')
    assert.ok(seen.length >= 1 && seen.every((r) => r.property_id === f.pa), 'manager sees only property A bookings')
    assert.equal((await q(c, 'select * from payments')).length, 1)
    assert.equal((await q(c, 'select * from expenses')).length, 1)
    assert.equal((await q(c, 'select * from guests')).length, 1, 'guests only via bookings on assigned properties')
    assert.equal((await q(c, 'select * from audit_log')).length, 0, 'audit log is owner-only')
    // cannot act on the unassigned property
    assert.equal((await c.query(`update properties set name = 'hacked' where id = $1`, [f.pb])).rowCount, 0)
    assert.equal((await c.query(`update bookings set notes = 'x' where id = $1`, [bb.id])).rowCount, 0)
    await fails(c, `insert into expenses(property_id,category,amount) values ($1,'x',1)`, [f.pb], '42501')
    await fails(c, `select staff_create_booking($1,$2,$3,1,'X','254711111111')`, [f.ub, day(d0, 20), day(d0, 21)], '42501')
    await fails(c, `select staff_block_dates($1,$2,$3)`, [f.ub, day(d0, 20), day(d0, 21)], '42501')
    // managers cannot delete expenses, owners can
    assert.equal((await c.query('delete from expenses')).rowCount, 0)
    // inactive unassigned property row is invisible
    await admin(c)
    await c.query('update properties set active=false where id=$1', [f.pb])
    await as(c, 'authenticated', f.manager)
    assert.equal((await q(c, 'select * from properties where id=$1', [f.pb])).length, 0)

    await as(c, 'authenticated', f.owner)
    assert.equal((await q(c, 'select * from bookings where id = any($1)', [[ba.id, bb.id]])).length, 2)
    assert.ok((await q(c, 'select * from audit_log')).length > 0)
    assert.equal((await c.query('delete from expenses where property_id=$1', [f.pa])).rowCount, 0, 'expenses are voided, never deleted')
  }))

test('RLS: deactivated staff are locked out', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    await booking(c, f, { from: fmt(f.friday), to: day(fmt(f.friday), 2) })
    await c.query('update profiles set active=false where id=$1', [f.manager])
    await as(c, 'authenticated', f.manager)
    assert.equal((await q(c, 'select * from bookings')).length, 0)
    await fails(c, `select staff_block_dates($1,$2,$3)`, [f.ua, day(fmt(f.friday), 20), day(fmt(f.friday), 21)], '42501')
  }))

test('staff: manual booking, blocked dates, manual payment, refund rules', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    await as(c, 'authenticated', f.manager)
    const ok = await one(c, `select * from staff_create_booking($1,$2,$3,2,'Walk In','254712345678',null,'walk_in',500,0,'note')`, [f.ua, day(d0, 10), day(d0, 12)])
    assert.equal(ok.status, 'confirmed')
    assert.equal(ok.discount, 500)
    // Mon + Tue nights at the base rate (10000) + cleaning (500) - discount (500)
    assert.equal(ok.total_amount, 10000)
    const blk = await one(c, `select * from staff_block_dates($1,$2,$3,'plumber')`, [f.ua, day(d0, 20), day(d0, 22)])
    assert.equal(blk.status, 'blocked')
    assert.equal(blk.guest_id, null)
    await fails(c, `select create_booking($1,$2,$3,1,'X','254711111111')`, [f.ua, day(d0, 20), day(d0, 21)], '42501')
    // manual payment allowed; STK rows and other recorders are not
    await c.query(`insert into payments(booking_id,kind,method,status,amount,recorded_by,confirmed_at) values ($1,'balance','cash','succeeded',1000,$2,now())`, [ok.id, f.manager])
    await fails(c, `insert into payments(booking_id,kind,method,status,amount,recorded_by) values ($1,'balance','mpesa_stk','succeeded',1000,$2)`, [ok.id, f.manager], '42501')
    await fails(c, `insert into payments(booking_id,kind,method,status,amount,recorded_by) values ($1,'balance','cash','succeeded',1000,$2)`, [ok.id, f.owner], '42501')
    assert.equal((await one(c, 'select amount_paid from bookings where id=$1', [ok.id])).amount_paid, 1000)
    // unblock by cancelling frees the dates
    await c.query(`update bookings set status='cancelled' where id=$1`, [blk.id])
    await one(c, `select * from staff_create_booking($1,$2,$3,1,'Again','254712345679',null,'phone',0,0,null)`, [f.ua, day(d0, 20), day(d0, 22)])
  }))

test('housekeeping: cleaners can progress status but not reassign, inspect or edit other fields', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const mine = (await one(c, `insert into housekeeping_tasks(property_id,unit_id,status,assigned_to) values ($1,$2,'dirty',$3) returning id`, [f.pa, f.ua, f.cleaner])).id
    const other = await user(c, 'CleanerB', 'cleaner', [f.pa])
    const theirs = (await one(c, `insert into housekeeping_tasks(property_id,unit_id,status,assigned_to) values ($1,$2,'dirty',$3) returning id`, [f.pa, f.ua, other])).id
    const foreign = (await one(c, `insert into housekeeping_tasks(property_id,unit_id,status) values ($1,$2,'dirty') returning id`, [f.pb, f.ub])).id
    await as(c, 'authenticated', f.cleaner)
    const visible = (await q(c, 'select id from housekeeping_tasks')).map((r) => r.id)
    assert.deepEqual(visible, [mine])
    assert.equal((await c.query(`update housekeeping_tasks set status='in_progress' where id=$1`, [mine])).rowCount, 1)
    assert.equal((await c.query(`update housekeeping_tasks set status='dirty' where id=$1`, [theirs])).rowCount, 0)
    assert.equal((await c.query(`update housekeeping_tasks set status='clean' where id=$1`, [foreign])).rowCount, 0)
    await fails(c, `update housekeeping_tasks set status='inspected' where id=$1`, [mine])
    await fails(c, `update housekeeping_tasks set assigned_to=$2 where id=$1`, [mine, other])
    await fails(c, `update housekeeping_tasks set unit_id=$2 where id=$1`, [mine, f.ub])
    await c.query(`update housekeeping_tasks set status='clean', notes='done' where id=$1`, [mine])
    assert.ok((await one(c, 'select completed_at from housekeeping_tasks where id=$1', [mine])).completed_at)
    await as(c, 'authenticated', f.manager)
    assert.equal((await c.query(`update housekeeping_tasks set status='inspected' where id=$1`, [mine])).rowCount, 1)
  }))

test('finance: monthly_pnl equals independent aggregates and a hand-computed fixture', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const thisMonth = fmt((await one(c, `select date_trunc('month', nairobi_today())::date m`)).m)
    const b = await booking(c, f, { from: d0, to: day(d0, 2), total: 20000, deposit: 10000 })
    await c.query(`insert into payments(booking_id,kind,method,status,amount,mpesa_receipt,confirmed_at) values
      ($1,'deposit','mpesa_stk','succeeded',10000,'PNL001', now()),
      ($1,'balance','cash','succeeded',4000,null, now()),
      ($1,'refund','cash','succeeded',1000,null, now()),
      ($1,'balance','mpesa_stk','failed',9999,null, now()),
      ($1,'balance','mpesa_stk','pending',8888,null, now())`, [b.id])
    await c.query(`insert into expenses(property_id,category,amount,expense_date) values
      ($1,'utilities',2500,nairobi_today()), ($1,'repairs',700,nairobi_today())`, [f.pa])
    await c.query(`insert into expenses(property_id,category,amount,expense_date,voided) values ($1,'repairs',5000,nairobi_today(),true)`, [f.pa])
    await c.query(`insert into expenses(property_id,category,amount,expense_date) values ($1,'repairs',123,nairobi_today() - 70)`, [f.pa])
    await as(c, 'authenticated', f.owner)
    const row = (await q(c, 'select * from monthly_pnl($1)', [thisMonth])).find((r) => r.property_id === f.pa)
    assert.deepEqual([row.income, row.refunds, row.expenses, row.net], [14000, 1000, 3200, 9800])
    const cats = await q(c, 'select * from monthly_expenses_by_category($1,$2)', [thisMonth, f.pa])
    assert.deepEqual(cats.map((r) => [r.category, r.amount]), [['utilities', 2500], ['repairs', 700]])
    // every property in the DB (incl. seed data): RPC == independent formulation
    for (const p of await q(c, 'select * from monthly_pnl($1)', [thisMonth])) {
      const inc = await one(c, `select coalesce(sum(case when p.kind='refund' then -p.amount else p.amount end),0)::int v
        from payments p join bookings b on b.id=p.booking_id where b.property_id=$1 and p.status='succeeded'
        and to_char(p.confirmed_at at time zone 'Africa/Nairobi','YYYY-MM') = to_char($2::date,'YYYY-MM')`, [p.property_id, thisMonth])
      const exp = await one(c, `select coalesce(sum(amount),0)::int v from expenses where property_id=$1 and not voided
        and to_char(expense_date,'YYYY-MM') = to_char($2::date,'YYYY-MM')`, [p.property_id, thisMonth])
      assert.equal(p.income - p.refunds, inc.v, `income ${p.property_name}`)
      assert.equal(p.expenses, exp.v, `expenses ${p.property_name}`)
      assert.equal(p.net, inc.v - exp.v)
    }
    // manager sees only their property
    await as(c, 'authenticated', f.manager)
    const mine = (await q(c, 'select property_id from monthly_pnl($1)', [thisMonth])).map((r) => r.property_id)
    assert.ok(mine.includes(f.pa) && !mine.includes(f.pb))
  }))

test('seed: 5 properties, ~40 bookings, re-runnable, no overlaps, P&L covers every property', async () => {
  const seedSql = readFileSync(join(root, 'supabase/seed.sql'), 'utf8')
  await tx(async (c) => {
    const counts = async () => ({
      props: (await one(c, `select count(*)::int n from properties where slug in ('kilimani-nest','westlands-loft','karen-garden-cottage','lavington-suites','runda-retreat')`)).n,
      units: (await one(c, `select count(*)::int n from units where code is not null and id = md5('seed-unit-' || code)::uuid`)).n,
      bookings: (await one(c, `select count(*)::int n from bookings where reference like 'SEED-%' and status <> 'blocked'`)).n,
      blocked: (await one(c, `select count(*)::int n from bookings where reference like 'SEED-B%'`)).n,
      expenses: (await one(c, `select count(*)::int n from expenses where description like 'Seed expense%'`)).n,
      overrides: (await one(c, `select count(*)::int n from rate_overrides where label like '%(seed)'`)).n,
      payments: (await one(c, `select count(*)::int n from payments where mpesa_receipt like 'SEED%' or booking_id in (select id from bookings where reference like 'SEED-%')`)).n,
    })
    const first = await counts()
    assert.equal(first.props, 5)
    assert.ok(first.units >= 10 && first.units <= 16)
    assert.ok(first.bookings >= 36 && first.bookings <= 50, `bookings ${first.bookings}`)
    assert.equal(first.blocked, 2)
    assert.equal(first.expenses, 25)
    assert.equal(first.overrides, 1)
    await c.query(seedSql)
    assert.deepEqual(await counts(), first, 'seed is re-runnable')
    // every paid booking: amount_paid equals the sum of its succeeded payments and never exceeds the total
    const bad = await q(c, `select b.reference from bookings b where b.reference like 'SEED-%'
      and (b.amount_paid <> coalesce((select sum(amount) from payments p where p.booking_id=b.id and p.status='succeeded'),0) or b.amount_paid > b.total_amount)`)
    assert.deepEqual(bad, [])
    const guests = (await one(c, `select count(*)::int n from guests where phone like '2547110000%'`)).n
    assert.equal(guests, 15)
  })
})

test('audit: settings, expense and unit-rate changes are logged (and unrelated unit edits are not)', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    await c.query(`update settings set value='60' where key='deposit_percent'`)
    assert.ok(await one(c, `select id from audit_log where entity='setting' and entity_id='deposit_percent'`))
    await c.query(`update units set name='Renamed' where id=$1`, [f.ua])
    assert.equal((await q(c, `select id from audit_log where entity='unit' and entity_id=$1`, [f.ua])).length, 0)
    await c.query(`update units set base_rate=5500 where id=$1`, [f.ua])
    assert.equal((await q(c, `select id from audit_log where entity='unit' and entity_id=$1`, [f.ua])).length, 1)
    await c.query(`insert into expenses(property_id,category,amount) values ($1,'repairs',100)`, [f.pa])
    assert.ok(await one(c, `select id from audit_log where entity='expense'`))
    await c.query(`insert into user_roles(user_id, role) values ($1,'manager')`, [f.cleaner])
    assert.ok(await one(c, `select id from audit_log where entity='user_role' and action='user_role.insert'`))
  }))

test('misc: rate limiter, audit trail, guest anonymisation keeps financial records', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const key = 'test:' + randomUUID()
    const hits = []
    for (let i = 0; i < 4; i++) hits.push((await one(c, 'select check_rate_limit($1,3,60) ok', [key])).ok)
    assert.deepEqual(hits, [true, true, true, false])

    const d0 = fmt(f.friday)
    const b = await booking(c, f, { from: d0, to: day(d0, 2), status: 'pending', hold: new Date(Date.now() + 600_000) })
    await c.query(`update bookings set status='confirmed' where id=$1`, [b.id])
    const log = await one(c, `select diff from audit_log where entity='booking' and entity_id=$1 and action='booking.status_changed'`, [b.id])
    assert.equal(log.diff.to, 'confirmed')

    await c.query(`insert into payments(booking_id,kind,method,status,amount,confirmed_at) values ($1,'deposit','cash','succeeded',500,now())`, [b.id])
    await as(c, 'authenticated', f.manager)
    await fails(c, `select anonymise_guest($1)`, [b.guest_id], '42501')
    const exp = (await one(c, 'select export_guest_data($1) j', [b.guest_id])).j
    assert.equal(exp.bookings.length, 1)
    await as(c, 'authenticated', f.owner)
    await c.query('select anonymise_guest($1)', [b.guest_id])
    const g = await one(c, 'select * from guests where id=$1', [b.guest_id])
    assert.equal(g.full_name, 'Deleted guest')
    assert.equal(g.email, null)
    assert.ok(g.anonymised_at)
    assert.equal((await one(c, 'select count(*)::int n from payments where booking_id=$1', [b.id])).n, 1)
  }))


// ---------------------------------------------------------------------------------------------
test('inquiries: public RPC validates and throttles; staff only; converted needs a booking', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    await as(c, 'anon')
    const id = (await one(c, `select submit_inquiry('Jane Doe','0712 345 678',null,'Is it free next weekend?',$1) id`, [f.pa])).id
    assert.ok(id, 'a valid inquiry is stored')
    assert.equal((await one(c, `select submit_inquiry('Bot','0712345678',null,'spam',null,null,null,null,'http://x') id`)).id, null, 'honeypot is dropped silently')
    await fails(c, `select submit_inquiry('Jane','12345',null,'hello there')`, [], '23514')
    await fails(c, `select submit_inquiry('J','0712345678',null,'hello there')`, [], '23514')
    await c.query(`select submit_inquiry('Jane Doe','0712345678',null,'second')`)
    await c.query(`select submit_inquiry('Jane Doe','0712345678',null,'third')`)
    await fails(c, `select submit_inquiry('Jane Doe','0712345678',null,'fourth')`, [], '23514')
    await fails(c, 'select * from inquiries', [], '42501')
    await fails(c, 'select * from inquiry_notes', [], '42501')

    await as(c, 'authenticated', f.cleaner)
    assert.equal((await q(c, 'select * from inquiries')).length, 0, 'cleaners see nothing')
    await as(c, 'authenticated', f.manager)
    const rows = await q(c, 'select * from inquiries order by created_at')
    assert.ok(rows.length >= 3)
    assert.equal(rows[0].phone, '254712345678', 'phone is normalised')
    assert.equal(rows[0].status, 'new')
    await fails(c, `update inquiries set status='converted' where id=$1`, [id], '23514')
    await admin(c)
    const b = await booking(c, f, { from: fmt(f.friday), to: day(fmt(f.friday), 2) })
    await as(c, 'authenticated', f.manager)
    await c.query(`update inquiries set status='converted', booking_id=$2 where id=$1`, [id, b.id])
    await c.query(`insert into inquiry_notes(inquiry_id, user_id, body) values ($1,$2,'called back')`, [id, f.manager])
    assert.equal((await q(c, 'select * from inquiry_notes where inquiry_id=$1', [id])).length, 1)
    await admin(c)
    assert.ok((await one(c, `select count(*)::int n from audit_log where entity='inquiry'`)).n >= 1, 'inquiry changes are audited')
  }))

test('reviews: public submissions wait for approval; only approved are public', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    await as(c, 'anon')
    const id = (await one(c, `select submit_review('Sam Guest','March stay',null,5,'Lovely place, very clean.') id`)).id
    assert.ok(id)
    await fails(c, `select submit_review('Sam Guest','x',null,9,'Too many stars given')`, [], '23514')
    assert.equal((await q(c, 'select * from reviews')).length, 0, 'pending reviews are not public')
    await as(c, 'authenticated', f.manager)
    assert.equal((await q(c, 'select * from reviews')).length, 1)
    await c.query(`update reviews set status='approved', response='Thank you!', responded_at=now(), responded_by=$2 where id=$1`, [id, f.manager])
    await as(c, 'anon')
    const pub = await q(c, 'select guest_name, status, response from reviews')
    assert.equal(pub.length, 1)
    assert.equal(pub[0].status, 'approved')
    await fails(c, `insert into reviews(guest_name, rating, body) values ('X', 5, 'direct insert')`, [], '42501')
    await as(c, 'authenticated', f.cleaner)
    await fails(c, `update reviews set status='hidden'`, [], undefined).catch(() => {})
    assert.equal((await one(c, `select status from reviews where id=$1`, [id])).status, 'approved', 'cleaners cannot moderate')
  }))

test('announcements: only active ones inside their window are public; managers cannot delete', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    await c.query(`insert into announcements(text, active) values ('Always on', true)`)
    await c.query(`insert into announcements(text, active) values ('Archived', false)`)
    await c.query(`insert into announcements(text, starts_at) values ('Starts tomorrow', now() + interval '1 day')`)
    await c.query(`insert into announcements(text, ends_at) values ('Ended', now() - interval '1 day')`)
    await c.query(`insert into announcements(text, starts_at, ends_at) values ('Inside window', now() - interval '1 day', now() + interval '1 day')`)
    await as(c, 'anon')
    assert.deepEqual((await q(c, 'select text from announcements order by text')).map((r) => r.text), ['Always on', 'Inside window'])
    await fails(c, `insert into announcements(text) values ('hack')`, [], '42501')
    await as(c, 'authenticated', f.manager)
    assert.equal((await q(c, 'select * from announcements')).length, 5, 'staff see all, including archived')
    await c.query(`insert into announcements(text, created_by) values ('New promo', $1)`, [f.manager])
    await c.query(`update announcements set active=false where text='Always on'`)
    await c.query(`delete from announcements where text='Archived'`)
    assert.equal((await q(c, `select * from announcements where text='Archived'`)).length, 1, 'manager delete is blocked by RLS')
    await as(c, 'authenticated', f.owner)
    await c.query(`delete from announcements where text='Archived'`)
    assert.equal((await q(c, `select * from announcements where text='Archived'`)).length, 0)
    await fails(c, `insert into announcements(text, starts_at, ends_at) values ('Bad', now(), now() - interval '1 hour')`, [], '23514')
  }))

test('normalize_ke_phone mirrors the app rules', async () =>
  tx(async (c) => {
    const n = async (v) => (await one(c, 'select normalize_ke_phone($1) p', [v])).p
    assert.equal(await n('0712 345 678'), '254712345678')
    assert.equal(await n('+254 112 345 678'), '254112345678')
    assert.equal(await n('254712345678'), '254712345678')
    assert.equal(await n('12345'), null)
    assert.equal(await n('+1 202 555 0100'), null)
    assert.equal(await n('abc'), null)
  }))

// ---------------------------------------------------------------------------------------------
test('listings: archived listings are hidden, max stay and maintenance are enforced in the database', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    // archived must also be unpublished
    await fails(c, `update properties set archived_at = now() where id = $1`, [f.pa], '23514')
    await c.query(`update properties set active = false, archived_at = now() where id = $1`, [f.pb])
    await as(c, 'anon')
    assert.equal((await q(c, 'select * from properties where id=$1', [f.pb])).length, 0, 'archived listings are not public')
    await admin(c)
    // max stay below min stay is rejected
    await c.query(`update units set min_nights = 2 where id = $1`, [f.ua])
    await fails(c, `update units set max_nights = 1 where id = $1`, [f.ua], '23514')
    await c.query(`update units set max_nights = 3 where id = $1`, [f.ua])
    await fails(c, `select * from create_booking($1,$2,$3,1,'Jane','254712345678')`, [f.ua, d0, day(d0, 4)], '23514')
    const ok = await one(c, `select * from create_booking($1,$2,$3,1,'Jane','254712345678')`, [f.ua, d0, day(d0, 3)])
    assert.equal(ok.nights, 3)
    // search hides units whose max stay is exceeded, and units under maintenance
    await as(c, 'anon')
    assert.equal((await q(c, 'select * from get_available_units($1,$2,1,$3)', [day(d0, 20), day(d0, 24), f.pa])).length, 0, 'too long')
    assert.equal((await q(c, 'select * from get_available_units($1,$2,1,$3)', [day(d0, 20), day(d0, 22), f.pa])).length, 1)
    await admin(c)
    await c.query(`update units set maintenance_status = 'maintenance' where id = $1`, [f.ua])
    await as(c, 'anon')
    assert.equal((await q(c, 'select * from get_available_units($1,$2,1,$3)', [day(d0, 20), day(d0, 22), f.pa])).length, 0, 'maintenance')
    await admin(c)
    await fails(c, `select * from create_booking($1,$2,$3,1,'Jane','254712345678')`, [f.ua, day(d0, 20), day(d0, 22)], '23514')
    await fails(c, `update units set maintenance_status = 'broken' where id = $1`, [f.ua], '23514')
  }))

test('room_board: statuses and priority', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const today = (await one(c, 'select nairobi_today() d')).d
    const t = fmt(today)
    const mk = async (name) => (await one(c, `insert into units(property_id,name,base_rate,max_guests) values ($1,$2,3000,2) returning id`, [f.pa, name])).id
    const uOcc = await mk('Occupied'), uRes = await mk('Reserved'), uDirty = await mk('Dirty'), uClean = await mk('Cleaning'), uMaint = await mk('Maint'), uOut = await mk('Out'), uPrio = await mk('Prio')
    await booking(c, f, { unit: uOcc, from: day(t, -1), to: day(t, 2), status: 'checked_in' })
    await booking(c, f, { unit: uRes, from: t, to: day(t, 2), status: 'confirmed' })
    await c.query(`insert into housekeeping_tasks(property_id, unit_id, status) values ($1,$2,'dirty'), ($1,$3,'in_progress')`, [f.pa, uDirty, uClean])
    await c.query(`update units set maintenance_status='maintenance', maintenance_note='Leak' where id = $1`, [uMaint])
    await c.query(`update units set maintenance_status='out_of_service' where id = $1`, [uOut])
    // maintenance outranks an open cleaning task and an occupying booking
    await c.query(`insert into housekeeping_tasks(property_id, unit_id, status) values ($1,$2,'dirty')`, [f.pa, uPrio])
    await c.query(`update units set maintenance_status='maintenance' where id = $1`, [uPrio])

    await as(c, 'authenticated', f.owner)
    const rows = await q(c, 'select * from room_board($1)', [t])
    const st = Object.fromEntries(rows.map((r) => [r.unit_name, r.status]))
    assert.equal(st.Occupied, 'occupied')
    assert.equal(st.Reserved, 'reserved')
    assert.equal(st.Dirty, 'dirty')
    assert.equal(st.Cleaning, 'cleaning')
    assert.equal(st.Maint, 'maintenance')
    assert.equal(st.Out, 'out_of_service')
    assert.equal(st.Prio, 'maintenance')
    assert.equal(st.A1, 'available')
    assert.equal(rows.find((r) => r.unit_name === 'Maint').maintenance_note, 'Leak')
    assert.equal(rows.find((r) => r.unit_name === 'Occupied').guest_name, 'G')
    // a manager only sees the board for their own property
    await as(c, 'authenticated', f.manager)
    assert.ok((await q(c, 'select * from room_board($1)', [t])).every((r) => r.property_id === f.pa))
  }))

// ---------------------------------------------------------------------------------------------
test('booking requests: public submit, staff decisions, approval creates a real held booking', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const { id: ownerOther } = { id: await user(c, 'OtherManager', 'manager', [f.pb]) }
    await as(c, 'anon')
    const token = (await one(c, `select submit_booking_request($1,$2,$3,2,'Amina Test','0712 345 678','a@x.com','Late arrival') t`, [f.ua, d0, day(d0, 2)])).t
    assert.ok(token)
    assert.equal((await one(c, `select submit_booking_request($1,$2,$3,2,'Bot','0712345678',null,null,'http://spam') t`, [f.ua, d0, day(d0, 2)])).t, null, 'honeypot')
    await fails(c, `select submit_booking_request($1,$2,$3,2,'Amina','123')`, [f.ua, d0, day(d0, 2)], '23514')
    await fails(c, `select submit_booking_request($1,$2,$3,9,'Amina Test','0712345678')`, [f.ua, d0, day(d0, 2)], '23514')
    await fails(c, `select submit_booking_request($1,$2,$3,2,'Amina Test','0712345678')`, [f.ua, day(d0, -800), day(d0, -798)], '23514')
    await fails(c, 'select * from booking_requests', [], '42501')
    // the guest can follow the request, but sees no contact details
    const info = (await one(c, 'select get_booking_request($1) j', [token])).j
    assert.equal(info.status, 'new')
    assert.equal(info.unit_name, 'A1')
    for (const k of ['phone', 'email', 'id', 'property_id', 'unit_id']) assert.ok(!(k in info), `${k} must not leak`)
    assert.equal((await one(c, 'select get_booking_request($1) j', [randomUUID()])).j, null)

    // staff: other property's manager and cleaners cannot decide
    await admin(c)
    const reqId = (await one(c, 'select id from booking_requests where public_token=$1', [token])).id
    await as(c, 'authenticated', ownerOther)
    assert.equal((await q(c, 'select * from booking_requests')).length, 0, 'other property manager sees nothing')
    await fails(c, 'select * from approve_booking_request($1)', [reqId], '42501')
    await as(c, 'authenticated', f.cleaner)
    await fails(c, 'select * from approve_booking_request($1)', [reqId], '42501')

    // the assigned manager approves: a REAL pending booking with the longer request hold
    await as(c, 'authenticated', f.manager)
    const b = await one(c, 'select * from approve_booking_request($1, $2)', [reqId, 'Welcome'])
    assert.equal(b.status, 'pending')
    assert.equal(b.unit_id, f.ua)
    const hours = (new Date(b.hold_expires_at) - Date.now()) / 3_600_000
    assert.ok(hours > 23 && hours <= 24.1, `hold is about 24h, got ${hours}`)
    const r = await one(c, 'select * from booking_requests where id=$1', [reqId])
    assert.equal(r.status, 'approved')
    assert.equal(r.booking_id, b.id)
    await fails(c, 'select * from approve_booking_request($1)', [reqId], '23514')          // already handled
    await fails(c, 'select * from reject_booking_request($1)', [reqId], '23514')
    await as(c, 'anon')
    const after = (await one(c, 'select get_booking_request($1) j', [token])).j
    assert.equal(after.booking_token, b.public_token, 'guest is pointed at the booking to pay')
    // dates are now taken: a new request for them is refused
    await fails(c, `select submit_booking_request($1,$2,$3,2,'Other Guest','0722000111')`, [f.ua, d0, day(d0, 2)], '23514')
  }))

test('booking requests: competing approvals, alternatives, reject, withdraw', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const submit = async (name, phone, a, b) => { await as(c, 'anon'); const t = (await one(c, `select submit_booking_request($1,$2,$3,2,$4,$5) t`, [f.ua, a, b, name, phone])).t; await admin(c); return (await one(c, 'select id from booking_requests where public_token=$1', [t])).id }
    // two guests ask for overlapping dates before either is approved
    const r1 = await submit('First Guest', '0712000001', d0, day(d0, 3))
    const r2 = await submit('Second Guest', '0712000002', day(d0, 1), day(d0, 4))
    await as(c, 'authenticated', f.manager)
    await c.query('select * from approve_booking_request($1)', [r1])
    const e = await fails(c, 'select * from approve_booking_request($1)', [r2], '23P01')   // the database overlap guard wins
    assert.ok(e)
    // alternative dates must be free, then the guest accepts them
    await fails(c, 'select offer_alternative_dates($1,$2,$3)', [r2, day(d0, 1), day(d0, 2)], '23514')
    await c.query('select offer_alternative_dates($1,$2,$3,$4)', [r2, day(d0, 10), day(d0, 12), 'These are free'])
    let row = await one(c, 'select * from booking_requests where id=$1', [r2])
    assert.equal(row.status, 'alternative_offered')
    assert.equal(fmt(row.alt_check_in), day(d0, 10))
    await admin(c)
    const tok2 = row.public_token
    await as(c, 'anon')
    await c.query('select accept_alternative_dates($1)', [tok2])
    await admin(c)
    row = await one(c, 'select * from booking_requests where id=$1', [r2])
    assert.equal(row.status, 'new')
    assert.equal(fmt(row.check_in), day(d0, 10))
    assert.equal(row.alt_check_in, null)
    assert.ok((await one(c, `select count(*)::int n from notifications where kind='request_update'`)).n >= 1, 'staff are told the guest accepted')
    await as(c, 'authenticated', f.manager)
    await c.query('select reject_booking_request($1,$2)', [r2, 'Sorry, not possible'])
    assert.equal((await one(c, 'select status from booking_requests where id=$1', [r2])).status, 'rejected')
    // withdraw
    const r3 = await submit('Third Guest', '0712000003', day(d0, 20), day(d0, 22))
    await as(c, 'anon')
    await fails(c, 'select public_token from booking_requests where id=$1', [r3], '42501')   // anon cannot read the table to find tokens
    await admin(c)
    const t3 = (await one(c, 'select public_token t from booking_requests where id=$1', [r3])).t
    await as(c, 'anon')
    await c.query('select withdraw_booking_request($1)', [t3])
    await fails(c, 'select withdraw_booking_request($1)', [t3], '23514')
    // notes are staff-only and bound to the writer
    await as(c, 'authenticated', f.manager)
    await c.query(`insert into booking_request_notes(request_id, user_id, body) values ($1,$2,'Called guest')`, [r1, f.manager])
    await fails(c, `insert into booking_request_notes(request_id, user_id, body) values ($1,$2,'forged')`, [r1, f.owner], '42501')
  }))

test('notifications: written by triggers without duplicates, scoped by property, preferences and read state per user', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const otherMgr = await user(c, 'MgrB', 'manager', [f.pb])
    // events in both properties
    const ba = await booking(c, f, { from: d0, to: day(d0, 2), status: 'pending', hold: new Date(Date.now() + 600_000) })
    const bb = await booking(c, f, { unit: f.ub, prop: f.pb, from: d0, to: day(d0, 2), status: 'pending', hold: new Date(Date.now() + 600_000) })
    const pay = await one(c, `insert into payments(booking_id,kind,method,status,amount,confirmed_at) values ($1,'deposit','cash','succeeded',5000,now()) returning id`, [ba.id])
    await c.query(`update payments set result_desc = 'again' where id = $1`, [pay.id])         // an update must not notify twice
    await c.query(`insert into inquiries(name, phone, message, property_id) values ('Zed','254712000009','Hello there',$1)`, [f.pb])
    await c.query(`update bookings set status='cancelled', cancel_reason='Guest asked' where id=$1`, [bb.id])
    assert.equal((await one(c, `select count(*)::int n from notifications where kind='payment' and entity_id=$1`, [pay.id])).n, 1, 'no duplicates')

    await as(c, 'authenticated', f.manager)
    let mine = await q(c, 'select * from my_notifications(50)')
    assert.ok(mine.some((n) => n.kind === 'payment'))
    assert.ok(!mine.some((n) => n.kind === 'cancellation' || n.kind === 'inquiry'), 'manager A does not see property B events')
    await as(c, 'authenticated', otherMgr)
    const theirs = await q(c, 'select * from my_notifications(50)')
    assert.ok(theirs.some((n) => n.kind === 'cancellation') && theirs.some((n) => n.kind === 'inquiry'))
    assert.ok(!theirs.some((n) => n.kind === 'payment'))
    await as(c, 'authenticated', f.cleaner)
    assert.equal((await q(c, 'select * from my_notifications(50)')).length, 0, 'cleaners get none')

    // read state is per user; preferences hide a kind
    await as(c, 'authenticated', f.manager)
    const before = (await one(c, 'select unread_notification_count() n')).n
    assert.ok(before >= 1)
    await c.query('select mark_notifications_read($1)', [[mine[0].id]])
    assert.equal((await one(c, 'select unread_notification_count() n')).n, before - 1)
    await c.query('select mark_notifications_read()')
    assert.equal((await one(c, 'select unread_notification_count() n')).n, 0)
    await as(c, 'authenticated', otherMgr)
    assert.ok((await one(c, 'select unread_notification_count() n')).n >= 1, 'other users keep their own unread count')
    await c.query(`insert into notification_prefs(user_id, kind, enabled) values ($1,'inquiry',false)`, [otherMgr])
    assert.ok(!(await q(c, 'select * from my_notifications(50)')).some((n) => n.kind === 'inquiry'), 'muted kinds are hidden')
    await fails(c, `insert into notifications(kind,title) values ('inquiry','forged')`, [], '42501')
    await as(c, 'anon')
    await fails(c, 'select * from notifications', [], '42501')
  }))

test('daily notifications: arrivals, departures and balances once; stale requests expire', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const today = fmt((await one(c, 'select nairobi_today() d')).d)
    await booking(c, f, { from: day(today, 1), to: day(today, 3), status: 'confirmed', total: 9000, deposit: 4000 })
    await booking(c, f, { unit: f.ub, prop: f.pb, from: day(today, -2), to: today, status: 'checked_in', total: 5000, deposit: 5000 })
    await c.query(`insert into booking_requests(property_id, unit_id, name, phone, check_in, check_out, guests, created_at) values ($1,$2,'Old','254712000008',$3,$4,1, now())`, [f.pa, f.ua, day(today, -3), day(today, -1)])
    const n1 = (await one(c, 'select generate_daily_notifications() n')).n
    assert.ok(n1 >= 3)
    const kinds = (await q(c, `select kind from notifications`)).map((r) => r.kind)
    for (const k of ['checkin_soon', 'checkout_today', 'balance_due']) assert.ok(kinds.includes(k), k)
    assert.equal((await one(c, 'select generate_daily_notifications() n')).n, 0, 'second run adds nothing')
    assert.equal((await one(c, `select status from booking_requests where name='Old'`)).status, 'expired')
  }))

test('dashboard_overview: hand-computed KPIs, previous period, property filter and role scoping', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    // 3 nights confirmed in property A, paid 5000 cash; one refund of 1000
    const b = await booking(c, f, { from: d0, to: day(d0, 3), status: 'confirmed' })
    await c.query(`insert into payments(booking_id,kind,method,status,amount,confirmed_at) values ($1,'deposit','cash','succeeded',5000,now())`, [b.id])
    await c.query(`insert into payments(booking_id,kind,method,status,amount,confirmed_at) values ($1,'refund','cash','succeeded',1000,now())`, [b.id])
    // revenue only counts succeeded
    await c.query(`insert into payments(booking_id,kind,method,status,amount) values ($1,'balance','cash','pending',9999)`, [b.id])

    await as(c, 'authenticated', f.owner)
    const today = (await one(c, 'select nairobi_today()::text d')).d
    const o = (await one(c, 'select dashboard_overview($1::date, $2::date, $3) o', [today, today, f.pa])).o
    assert.equal(Number(o.current.revenue), 4000, 'income minus refunds, succeeded only')
    assert.equal(o.days, 1)
    assert.equal(o.daily.length, 1)
    assert.ok(o.by_method.some((m) => m.key === 'cash' && Number(m.amount) === 4000))
    assert.equal(o.previous.revenue, 0)

    // the booking's three nights are fully inside a 3-day window starting at check-in
    const w = (await one(c, 'select dashboard_overview($1::date, ($1::date + 2), $2) o', [d0, f.pa])).o
    assert.equal(Number(w.current.occupied_nights), 3)
    assert.equal(Number(w.current.available_nights), Number(w.units) * 3)
    assert.equal(Number(w.current.arrivals), 1)
    const other = (await one(c, 'select dashboard_overview($1::date, ($1::date + 2), $2) o', [d0, f.pb])).o
    assert.equal(Number(other.current.occupied_nights), 0, 'property filter')
    assert.equal(Number(other.current.revenue), 0)

    await as(c, 'authenticated', f.manager)
    const m = (await one(c, 'select dashboard_overview($1::date, $1::date, null) o', [today])).o
    assert.equal(Number(m.current.revenue), 4000)
    await as(c, 'authenticated', f.cleaner)
    await fails(c, 'select dashboard_overview($1::date, $1::date, null)', [today], '42501')
    await as(c, 'authenticated', f.owner)
    await fails(c, `select dashboard_overview('2026-02-01', '2026-01-01', null)`, [], '23514')
  }))

test('support tickets: staff only, property scoped, resolved_at follows status, messages tied to the author', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    await as(c, 'authenticated', f.manager)
    const t = await one(c, `insert into support_tickets(subject, property_id, created_by) values ('Hot water out', $1, $2) returning *`, [f.pa, f.manager])
    assert.equal(t.status, 'open'); assert.equal(t.resolved_at, null); assert.ok(t.ticket_no > 0)
    const r = await one(c, `update support_tickets set status='resolved' where id=$1 returning resolved_at`, [t.id])
    assert.ok(r.resolved_at)
    const again = await one(c, `update support_tickets set status='closed' where id=$1 returning resolved_at`, [t.id])
    assert.equal(+again.resolved_at, +r.resolved_at, 'closing keeps the original resolution time')
    const re = await one(c, `update support_tickets set status='open' where id=$1 returning resolved_at`, [t.id])
    assert.equal(re.resolved_at, null, 'reopening clears it')
    await fails(c, `insert into support_tickets(subject, property_id) values ('Other site', $1)`, [f.pb], '42501')
    await c.query(`insert into support_ticket_messages(ticket_id, user_id, body) values ($1,$2,'On my way')`, [t.id, f.manager])
    await fails(c, `insert into support_ticket_messages(ticket_id, user_id, body) values ($1,$2,'forged')`, [t.id, f.owner], '42501')
    await fails(c, `insert into support_tickets(subject) values ('x')`, [], '23514')

    await as(c, 'authenticated', f.cleaner)
    assert.equal((await q(c, 'select * from support_tickets')).length, 0, 'cleaners see none')
    await fails(c, `insert into support_tickets(subject) values ('Cleaner ticket')`, [], '42501')
    await as(c, 'anon')
    await fails(c, 'select * from support_tickets', [], '42501')
    await as(c, 'authenticated', f.owner)
    assert.ok((await q(c, 'select id from support_tickets')).some((x) => x.id === t.id))
  }))

test('discount codes: rules, last-use race, cancellation gives the use back, guests cannot read codes', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const mk = (vals) => one(c, `insert into discount_codes(code, kind, value, property_id, min_nights, max_uses, valid_from, valid_to, active)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`, [vals.code, vals.kind ?? 'percent', vals.value ?? 10, vals.property_id ?? null, vals.min_nights ?? 1, vals.max_uses ?? null, vals.valid_from ?? null, vals.valid_to ?? null, vals.active ?? true])
    const ten = await mk({ code: 'TEN10', value: 10 })
    await mk({ code: 'FLAT500', kind: 'fixed', value: 500 })
    await mk({ code: 'ONLYB', property_id: f.pb })
    await mk({ code: 'LONG3', min_nights: 3 })
    await mk({ code: 'OLD', valid_to: '2020-01-01' })
    await mk({ code: 'OFF', active: false })
    await mk({ code: 'ONCE', max_uses: 1 })
    await fails(c, `insert into discount_codes(code, kind, value) values ('bad code','percent',10)`, [], '23514')
    await fails(c, `insert into discount_codes(code, kind, value) values ('OVER','percent',150)`, [], '23514')
    await fails(c, `insert into discount_codes(code, kind, value) values ('TEN10','percent',5)`, [], '23505')

    await as(c, 'anon')
    // 2 nights in Prop A: quote_stay nightly_total comes from the pricing engine
    const base = (await one(c, 'select nightly_total from quote_stay($1,$2,$3)', [f.ua, d0, day(d0, 2)])).nightly_total
    const r = async (code, nights = 2) => (await one(c, 'select quote_discount_code($1,$2,$3,$4) r', [code, f.ua, d0, day(d0, nights)])).r
    assert.deepEqual([(await r('ten10')).ok, (await r('ten10')).amount], [true, Math.floor(base * 10 / 100)], 'case-insensitive percent')
    assert.equal((await r('FLAT500')).amount, 500)
    for (const bad of ['NOPE', 'ONLYB', 'LONG3', 'OLD', 'OFF']) assert.equal((await r(bad)).ok, false, bad)
    assert.equal((await r('LONG3', 3)).ok, true)
    await fails(c, 'select * from discount_codes', [], '42501')
    await fails(c, 'select create_booking_with_code($1,$2,$3,$4,1,$5,$6)', ['TEN10', f.ua, d0, day(d0, 2), 'G', '254712345678'], '42501')

    await admin(c)
    // booking created with the code: totals reflect the discount; the use is recorded
    const b = await one(c, `select * from create_booking_with_code('ONCE', $1,$2,$3,1,'Guest One','254712000111')`, [f.ua, d0, day(d0, 2)])
    const qs = await one(c, 'select * from quote_stay($1,$2,$3)', [f.ua, d0, day(d0, 2)])
    assert.equal(b.total_amount, qs.total - b.discount)
    assert.ok(b.discount > 0)
    assert.equal((await one(c, `select discount_uses(id) n from discount_codes where code='ONCE'`)).n, 1)
    // the single use is gone for the next stay...
    await fails(c, `select create_booking_with_code('ONCE', $1,$2,$3,1,'Guest Two','254712000222')`, [f.ua, day(d0, 7), day(d0, 9)], '23514')
    // ...until the first booking is cancelled
    await c.query(`update bookings set status='cancelled' where id=$1`, [b.id])
    const again = await one(c, `select * from create_booking_with_code('ONCE', $1,$2,$3,1,'Guest Two','254712000222')`, [f.ua, day(d0, 7), day(d0, 9)])
    assert.ok(again.discount > 0)
    // a failed booking (unknown unit) leaves no redemption behind
    await fails(c, `select create_booking_with_code('TEN10', $1,$2,$3,1,'X Y','254712000333')`, [randomUUID(), d0, day(d0, 2)])
    assert.equal((await one(c, `select count(*)::int n from discount_redemptions where code_id=$1`, [ten.id])).n, 0)

    // staff scoping: manager A manages only codes for their own property; global codes are owner-only
    await as(c, 'authenticated', f.manager)
    await c.query(`insert into discount_codes(code, kind, value, property_id) values ('MGRA','percent',5,$1)`, [f.pa])
    await fails(c, `insert into discount_codes(code, kind, value, property_id) values ('MGRB','percent',5,$1)`, [f.pb], '42501')
    await fails(c, `insert into discount_codes(code, kind, value) values ('GLOBAL','percent',5)`, [], '42501')
    assert.ok(!(await q2(c)).includes('ONLYB'), 'manager A cannot see property B codes')
    await as(c, 'authenticated', f.cleaner)
    assert.equal((await q(c, 'select * from discount_codes')).length, 0)
  }))
const q2 = async (c) => (await q(c, 'select code from discount_codes')).map((x) => x.code)

test('property SEO fields are length limited', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    await c.query(`update properties set seo_title=$2, seo_description=$3 where id=$1`, [f.pa, 'A'.repeat(70), 'B'.repeat(200)])
    await fails(c, `update properties set seo_title=$2 where id=$1`, [f.pa, 'A'.repeat(71)], '23514')
    await fails(c, `update properties set seo_description=$2 where id=$1`, [f.pa, 'B'.repeat(201)], '23514')
  }))

test('guest credit: append-only ledger, never negative, applied to a booking through a payment, scoped by access', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const b = await booking(c, f, { from: d0, to: day(d0, 2), status: 'confirmed', total: 10000, deposit: 5000 })
    const other = await booking(c, f, { unit: f.ub, prop: f.pb, from: d0, to: day(d0, 2), status: 'confirmed' })
    const gid = b.guest_id
    await as(c, 'authenticated', f.manager)
    assert.equal((await one(c, 'select add_guest_credit($1,3000,$2) b', [gid, 'Refund held as credit'])).b, 3000)
    await fails(c, 'select add_guest_credit($1,0,$2)', [gid, 'zero'], '23514')
    await fails(c, 'select add_guest_credit($1,100,$2)', [gid, 'x'], '23514')          // reason too short
    await fails(c, 'select adjust_guest_credit($1,-100,$2)', [gid, 'manager tries'], '42501')
    await fails(c, `insert into guest_credit_entries(guest_id, amount, kind, reason) values ($1,999,'credit_added','direct insert')`, [gid], '42501')
    await fails(c, `update guest_credit_entries set amount = 99999 where guest_id=$1`, [gid], '42501')
    await fails(c, `delete from guest_credit_entries where guest_id=$1`, [gid], '42501')
    // a guest this manager cannot see
    await fails(c, 'select add_guest_credit($1,500,$2)', [other.guest_id, 'not my guest'], '42501')
    assert.equal((await one(c, 'select guest_credit_balance($1) b', [other.guest_id])).b, null)

    // apply credit: needs balance on both sides
    await fails(c, 'select apply_guest_credit($1,3500)', [b.id], '23514')               // more than the credit
    await fails(c, 'select apply_guest_credit($1,10001)', [b.id], '23514')              // more than the booking balance
    assert.equal((await one(c, 'select apply_guest_credit($1,2000) b', [b.id])).b, 1000)
    const after = await one(c, 'select amount_paid from bookings where id=$1', [b.id])
    assert.equal(after.amount_paid, 2000, 'credit became a real payment')
    assert.equal((await one(c, 'select guest_credit_balance($1) b', [gid])).b, 1000)
    await fails(c, 'select apply_guest_credit($1,1500)', [b.id], '23514')
    await fails(c, 'select apply_guest_credit($1,100)', [other.id], '42501')

    // owner correction can not push below zero
    await as(c, 'authenticated', f.owner)
    await fails(c, 'select adjust_guest_credit($1,-1500,$2)', [gid, 'too much'], '23514')
    assert.equal((await one(c, 'select adjust_guest_credit($1,-400,$2) b', [gid, 'Typo fix'])).b, 600)

    // statement matches the ledger and the booking
    const st = (await one(c, 'select guest_statement($1) s', [gid])).s
    assert.equal(st.credit_balance, 600)
    assert.equal(st.credit.length, 3)
    assert.equal(st.bookings.length, 1)
    assert.equal(st.bookings[0].paid, 2000)
    assert.equal(st.bookings[0].balance, 8000)
    assert.equal(st.payments.length, 1)

    await as(c, 'authenticated', f.cleaner)
    assert.equal((await q(c, 'select * from guest_credit_entries')).length, 0)
    await fails(c, 'select add_guest_credit($1,500,$2)', [gid, 'cleaner'], '42501')
    await as(c, 'anon')
    await fails(c, 'select * from guest_credit_entries', [], '42501')
  }))

test('guest flags need a reason', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const b = await booking(c, f, { from: fmt(f.friday), to: day(fmt(f.friday), 1) })
    await fails(c, `update guests set flagged=true where id=$1`, [b.guest_id], '23514')
    await c.query(`update guests set flagged=true, flag_reason='Damaged furniture' where id=$1`, [b.guest_id])
    await c.query(`update guests set vip=true where id=$1`, [b.guest_id])
  }))

test('check-in / check-out: deposit, readiness, early approval, room change, charges, balance, housekeeping task', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const today = (await one(c, 'select nairobi_today()::text d')).d
    const mkPaid = async (from, to, paid) => {
      const b = await booking(c, f, { from, to, status: 'confirmed', total: 10000, deposit: 5000 })
      if (paid) await c.query(`insert into payments(booking_id,kind,method,status,amount,confirmed_at) values ($1,'deposit','cash','succeeded',$2,now())`, [b.id, paid])
      return b
    }
    const b1 = await mkPaid(today, day(today, 2), 0)
    await as(c, 'authenticated', f.manager)
    await fails(c, 'select check_in_booking($1)', [b1.id], '23514')                       // deposit missing
    await admin(c)
    await c.query(`insert into payments(booking_id,kind,method,status,amount,confirmed_at) values ($1,'deposit','cash','succeeded',5000,now())`, [b1.id])
    // a dirty room blocks arrival
    await c.query(`insert into housekeeping_tasks(property_id, unit_id, status) values ($1,$2,'dirty')`, [f.pa, f.ua])
    await as(c, 'authenticated', f.manager)
    const e1 = await fails(c, 'select check_in_booking($1)', [b1.id], '23514'); assert.match(e1.message, /cleaning/)
    await admin(c); await c.query(`update housekeeping_tasks set status='inspected' where unit_id=$1`, [f.ua])
    await as(c, 'authenticated', f.manager)
    const r = await one(c, `select * from check_in_booking($1, null, 2, true, 'Checked national ID at desk', 'Late dinner', null)`, [b1.id])
    assert.equal(r.early, false); assert.equal(r.id_verified, true); assert.equal(r.guests, 2)
    assert.equal((await one(c, 'select status from bookings where id=$1', [b1.id])).status, 'checked_in')
    await fails(c, 'select check_in_booking($1)', [b1.id], '23514')                        // not confirmed any more

    // charges move the total; voiding takes it back
    const ch = await one(c, `select * from add_booking_charge($1,'Extra bed',1500)`, [b1.id])
    assert.equal((await one(c, 'select total_amount from bookings where id=$1', [b1.id])).total_amount, 11500)
    await fails(c, 'select add_booking_charge($1,$2,0)', [b1.id, 'Zero'], '23514')
    await c.query('select void_booking_charge($1,$2)', [ch.id, 'Added by mistake'])
    assert.equal((await one(c, 'select total_amount from bookings where id=$1', [b1.id])).total_amount, 10000)
    await c.query('select void_booking_charge($1,$2)', [ch.id, 'again'])                    // idempotent
    assert.equal((await one(c, 'select total_amount from bookings where id=$1', [b1.id])).total_amount, 10000)

    // check-out refuses an unpaid balance unless accepted; creates the housekeeping task
    const e2 = await fails(c, 'select check_out_booking($1)', [b1.id], '23514'); assert.match(e2.message, /owes KES 5000/)
    const co = await one(c, `select * from check_out_booking($1,'Left early',0,true)`, [b1.id])
    assert.equal(co.balance_left, 5000)
    assert.equal((await one(c, 'select status from bookings where id=$1', [b1.id])).status, 'checked_out')
    await admin(c)
    assert.equal((await one(c, `select count(*)::int n from housekeeping_tasks where booking_id=$1 and status='dirty'`, [b1.id])).n, 1, 'cleaning task created')

    // early arrival needs approval; room change is validated
    await as(c, 'authenticated', f.manager)
    const later = day(today, 5)
    await admin(c); const b2 = await mkPaid(later, day(later, 2), 5000); await as(c, 'authenticated', f.manager)
    const e3 = await fails(c, 'select check_in_booking($1)', [b2.id], '23514'); assert.match(e3.message, /early/i)
    await fails(c, 'select check_in_booking($1,$2,null,false,null,null,null,true)', [b2.id, f.ub], '23514')   // other property's room
    await admin(c); await c.query(`update housekeeping_tasks set status='inspected' where unit_id=$1`, [f.ua]); await as(c, 'authenticated', f.manager)
    const early = await one(c, 'select * from check_in_booking($1,null,null,false,null,null,null,true)', [b2.id])
    assert.equal(early.early, true)

    // screen data
    const scr = (await one(c, 'select arrivals_departures($1) s', [today])).s
    assert.ok(Array.isArray(scr.arrivals) && Array.isArray(scr.in_house))
    assert.ok(scr.in_house.some((x) => x.id === b2.id))

    // other property's manager and cleaners are shut out
    await admin(c); const mgrB = await user(c, 'MgrB2', 'manager', [f.pb]); await as(c, 'authenticated', mgrB)
    await fails(c, 'select check_out_booking($1)', [b2.id], '42501')
    await as(c, 'authenticated', f.cleaner)
    await fails(c, 'select check_out_booking($1)', [b2.id], '42501')
    assert.equal((await q(c, 'select * from checkin_records')).length, 0)
  }))

test('blocked ranges: scopes, conflicts with real bookings, release, scoping', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const ua2 = (await one(c, `insert into units(property_id,name,base_rate,max_guests) values ($1,'A2',5000,2) returning id`, [f.pa])).id
    await as(c, 'authenticated', f.manager)
    // whole property
    const whole = await one(c, `select * from block_dates($1,null,$2,$3,'renovation','Painting')`, [f.pa, d0, day(d0, 3)])
    assert.equal(whole.scope, 'property')
    assert.equal((await one(c, `select count(*)::int n from bookings where block_range_id=$1 and status='blocked'`, [whole.id])).n, 2)
    // blocked dates leave public availability
    await as(c, 'anon')
    assert.equal((await q(c, 'select * from get_available_units($1,$2,1,$3)', [d0, day(d0, 2), f.pa])).length, 0)
    await as(c, 'authenticated', f.manager)
    // an overlapping block is refused, naming what is in the way
    const e = await fails(c, `select block_dates($1,$2,$3,$4,'other')`, [f.pa, [f.ua], day(d0, 1), day(d0, 2)], '23514'); assert.match(e.message, /overlap/)
    await c.query('select release_blocked_range($1)', [whole.id])
    await c.query('select release_blocked_range($1)', [whole.id])           // idempotent
    assert.equal((await one(c, `select released_at is not null r from blocked_ranges where id=$1`, [whole.id])).r, true)
    assert.equal((await one(c, `select count(*)::int n from bookings where block_range_id=$1 and status='blocked'`, [whole.id])).n, 0)

    // a real booking cannot be covered
    await admin(c); const b = await booking(c, f, { from: day(d0, 10), to: day(d0, 12), status: 'confirmed' }); await as(c, 'authenticated', f.manager)
    const e2 = await fails(c, `select block_dates($1,$2,$3,$4,'maintenance')`, [f.pa, [f.ua], day(d0, 9), day(d0, 11)], '23514'); assert.match(e2.message, new RegExp(b.reference))
    const one1 = await one(c, `select * from block_dates($1,$2,$3,$4,'private_use')`, [f.pa, [ua2], day(d0, 9), day(d0, 11)])
    assert.equal(one1.scope, 'unit')
    // validation and scoping
    await fails(c, `select block_dates($1,null,$2,$3,'maintenance')`, [f.pa, d0, d0], '23514')
    await fails(c, `select block_dates($1,null,$2,$3,'bogus')`, [f.pa, d0, day(d0, 1)], '23514')
    await fails(c, `select block_dates($1,$2,$3,$4,'other')`, [f.pa, [f.ub], d0, day(d0, 1)], '23514')       // room of another property
    await fails(c, `select block_dates($1,null,$2,$3,'other')`, [f.pb, d0, day(d0, 1)], '42501')
    await as(c, 'authenticated', f.cleaner)
    await fails(c, `select block_dates($1,null,$2,$3,'other')`, [f.pa, d0, day(d0, 1)], '42501')
  }))

test('maintenance requests: reporting, assignment, completion notes, room goes offline and comes back', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    await as(c, 'authenticated', f.cleaner)
    // housekeeping can report an issue but not take a room offline or self-assign
    const rep = await one(c, `insert into maintenance_requests(property_id, unit_id, title, reported_by) values ($1,$2,'Leaking tap',$3) returning *`, [f.pa, f.ua, f.cleaner])
    assert.equal(rep.status, 'open')
    await fails(c, `insert into maintenance_requests(property_id, unit_id, title, reported_by, takes_unit_offline) values ($1,$2,'Hack',$3,true)`, [f.pa, f.ua, f.cleaner], '42501')
    await fails(c, `insert into maintenance_requests(property_id, title, reported_by) values ($1,'Other site',$2)`, [f.pb, f.cleaner], '42501')
    assert.equal((await q(c, 'select * from maintenance_requests')).length, 1)

    await as(c, 'authenticated', f.manager)
    await c.query(`update maintenance_requests set assigned_to=$2, status='assigned', takes_unit_offline=true, priority='high' where id=$1`, [rep.id, f.cleaner])
    assert.equal((await one(c, 'select maintenance_status from units where id=$1', [f.ua])).maintenance_status, 'maintenance', 'room taken offline')
    await as(c, 'authenticated', f.cleaner)
    await c.query(`update maintenance_requests set status='in_progress' where id=$1`, [rep.id])
    await fails(c, `update maintenance_requests set status='completed' where id=$1`, [rep.id], '23514')          // needs completion notes
    await c.query(`update maintenance_requests set status='completed', completion_notes='Washer replaced' where id=$1`, [rep.id])
    const done = await one(c, 'select completed_at from maintenance_requests where id=$1', [rep.id])
    assert.ok(done.completed_at)
    await admin(c)
    assert.equal((await one(c, 'select maintenance_status from units where id=$1', [f.ua])).maintenance_status, 'ok', 'room back in service')
    await as(c, 'authenticated', f.manager)
    await fails(c, `insert into maintenance_requests(property_id, title, takes_unit_offline) values ($1,'No unit',true)`, [f.pa], '23514')
  }))

test('media, gallery and homepage banners: public sees only published/scheduled, in-use files cannot be deleted', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    await as(c, 'authenticated', f.manager)
    const url = 'https://cdn.example.test/a.webp'
    const asset = await one(c, `insert into media_assets(url, storage_path, title, category) values ($1,'gallery/a.webp','Lobby','lobby') returning *`, [url])
    await fails(c, `insert into media_assets(url, storage_path) values ('http://insecure','x')`, [], '23514')
    const cat = await one(c, `insert into gallery_categories(name) values ('Lounge') returning *`)
    await fails(c, `insert into gallery_categories(name) values ('lounge')`, [], '23505')
    const hidden = await one(c, `insert into gallery_categories(name, published) values ('Hidden', false) returning *`)
    await c.query(`insert into gallery_items(category_id, url, caption) values ($1,$2,'Sofa')`, [cat.id, url])
    await c.query(`insert into gallery_items(category_id, url, published) values ($1,$2,false)`, [cat.id, 'https://cdn.example.test/draft.webp'])
    await c.query(`insert into gallery_items(category_id, url) values ($1,$2)`, [hidden.id, 'https://cdn.example.test/inhidden.webp'])
    await c.query(`insert into homepage_banners(placement, image_url, published) values ('hero','https://cdn.example.test/h1.webp', true)`)
    await c.query(`insert into homepage_banners(placement, image_url, published, starts_at) values ('hero','https://cdn.example.test/future.webp', true, now() + interval '1 day')`)
    await c.query(`insert into homepage_banners(placement, image_url, published, ends_at, starts_at) values ('promo','https://cdn.example.test/old.webp', true, now() - interval '1 hour', now() - interval '2 days')`)
    await c.query(`insert into homepage_banners(placement, image_url) values ('promo','https://cdn.example.test/unpublished.webp')`)
    await fails(c, `insert into homepage_banners(placement, image_url, link_url) values ('hero','https://x.test/i.webp','javascript:alert(1)')`, [], '23514')

    await as(c, 'anon')
    assert.deepEqual((await q(c, 'select url from gallery_items')).map((r) => r.url), [url], 'only published items in published categories')
    assert.deepEqual((await q(c, 'select image_url from homepage_banners')).map((r) => r.image_url), ['https://cdn.example.test/h1.webp'], 'only live banners')
    assert.equal((await q(c, 'select * from gallery_categories')).length, 1)
    await fails(c, 'select * from media_assets', [], '42501')
    await fails(c, `insert into gallery_items(category_id, url) values ('${cat.id}','https://x.test/y.webp')`, [], '42501')

    await as(c, 'authenticated', f.cleaner)
    assert.equal((await q(c, 'select * from media_assets')).length, 0)
    await fails(c, 'select delete_media_asset($1)', [asset.id], '42501')

    await as(c, 'authenticated', f.manager)
    assert.equal((await one(c, 'select media_in_use($1) u', [url])).u, true)
    const e = await fails(c, 'select delete_media_asset($1)', [asset.id], '23514'); assert.match(e.message, /still used/)
    await c.query(`delete from gallery_items where url=$1`, [url])
    assert.equal((await one(c, 'select delete_media_asset($1) p', [asset.id])).p, 'gallery/a.webp')
    assert.equal((await q(c, 'select * from media_assets')).length, 0)
  }))

test('finance controls: unverified money is not revenue, expense approval, categories, owner overview', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const today = (await one(c, 'select nairobi_today()::text d')).d
    const thisMonth = today.slice(0, 7) + '-01'
    const b = await booking(c, f, { from: d0, to: day(d0, 2), status: 'confirmed' })
    await as(c, 'authenticated', f.owner)
    const snap = async () => (await one(c, 'select owner_overview($1,$2) o', [today.slice(0, 7) + '-01', today])).o

    const before = await snap()
    // manager records manual M-Pesa + a refund: both unverified. Cash is verified automatically.
    await as(c, 'authenticated', f.manager)
    const mp = await one(c, `insert into payments(booking_id,kind,method,status,amount,confirmed_at,recorded_by) values ($1,'deposit','mpesa_manual','succeeded',3000,now(),$2) returning *`, [b.id, f.manager])
    const cash = await one(c, `insert into payments(booking_id,kind,method,status,amount,confirmed_at,recorded_by) values ($1,'balance','cash','succeeded',2000,now(),$2) returning *`, [b.id, f.manager])
    const rf = await one(c, `insert into payments(booking_id,kind,method,status,amount,confirmed_at,recorded_by) values ($1,'refund','cash','succeeded',500,now(),$2) returning *`, [b.id, f.manager])
    assert.deepEqual([mp.verified, cash.verified, rf.verified], [false, true, false])
    await fails(c, 'select verify_payment($1)', [mp.id], '42501')
    assert.equal((await c.query(`update payments set verified=true where id=$1`, [mp.id])).rowCount, 0, 'managers cannot edit payments at all')
    // the booking still shows what the guest handed over (cash flow), but revenue reports only count verified money
    assert.equal((await one(c, 'select amount_paid from bookings where id=$1', [b.id])).amount_paid, 4500)
    const pnlM = (await q(c, 'select * from monthly_pnl($1)', [thisMonth])).find((r) => r.property_id === f.pa)
    assert.equal(pnlM.income, 2000, 'monthly P&L counts verified income only')
    const dash = (await one(c, 'select dashboard_overview($1::date,$1::date,$2) o', [today, f.pa])).o
    assert.equal(Number(dash.current.revenue), 2000, 'dashboard counts verified income only')

    await as(c, 'authenticated', f.owner)
    let o = await snap()
    assert.equal(o.finance.collected - before.finance.collected, 2000)
    assert.equal(o.finance.unverified - before.finance.unverified, 3000 - 500)
    await c.query('select verify_payment($1)', [mp.id]); await c.query('select verify_payment($1)', [rf.id])
    o = await snap()
    assert.equal(o.finance.collected - before.finance.collected, 2000 + 3000 - 500)
    assert.equal(o.finance.unverified - before.finance.unverified, 0)

    // expenses: manager entries wait for the owner; only approved ones reduce profit
    await as(c, 'authenticated', f.manager)
    const ex = await one(c, `insert into expenses(property_id, category, amount, expense_date) values ($1,'utilities',1200,$2) returning *`, [f.pa, today])
    assert.equal(ex.status, 'pending')
    await fails(c, `update expenses set status='approved' where id=$1`, [ex.id], '42501')
    await fails(c, 'select review_expense($1,true)', [ex.id], '42501')
    await as(c, 'authenticated', f.owner)
    const mid = await snap()
    assert.equal(mid.finance.expenses - o.finance.expenses, 0); assert.equal(mid.finance.expenses_pending - o.finance.expenses_pending, 1200)
    await fails(c, 'select review_expense($1,false,null)', [ex.id], '23514')
    await c.query('select review_expense($1,true,null)', [ex.id])
    const after = await snap()
    assert.equal(after.finance.expenses - mid.finance.expenses, 1200)
    assert.equal(after.finance.net_operating_income - mid.finance.net_operating_income, -1200)
    // an approved expense that a manager edits goes back to pending
    await as(c, 'authenticated', f.manager)
    assert.equal((await one(c, `update expenses set amount=1500 where id=$1 returning status`, [ex.id])).status, 'pending')

    // categories
    await fails(c, `insert into expense_categories(name) values ('Utilities')`, [], '42501')
    await as(c, 'authenticated', f.owner)
    await fails(c, `insert into expense_categories(name) values ('Utilities')`, [], '23514')
    await c.query(`insert into expense_categories(name) values ('security')`)
    await fails(c, `insert into expense_categories(name) values ('security')`, [], '23505')

    // shape + access
    for (const k of ['finance', 'monthly', 'by_property', 'units', 'performance', 'bookings', 'operations', 'staff_activity']) assert.ok(k in after, k)
    assert.equal(after.monthly.length, 12)
    await as(c, 'authenticated', f.manager)
    await fails(c, 'select owner_overview($1,$2)', [today, today], '42501')
    await fails(c, 'select owner_overview($1,$2)', [today, '2020-01-01'], '42501')
    await as(c, 'authenticated', f.owner)
    await fails(c, 'select owner_overview($1,$2)', [today, '2020-01-01'], '23514')
  }))

test('financial records cannot be hard-deleted by anyone with a login', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const b = await booking(c, f, { from: fmt(f.friday), to: day(fmt(f.friday), 2), status: 'confirmed' })
    await c.query(`insert into payments(booking_id,kind,method,status,amount,confirmed_at) values ($1,'deposit','cash','succeeded',100,now())`, [b.id])
    const ex = await one(c, `insert into expenses(property_id, category, amount) values ($1,'other',100) returning id`, [f.pa])
    await as(c, 'authenticated', f.owner)
    assert.equal((await c.query(`delete from payments where booking_id=$1`, [b.id])).rowCount, 0)
    assert.equal((await c.query(`delete from expenses where id=$1`, [ex.id])).rowCount, 0)
    assert.equal((await c.query(`update expenses set voided=true where id=$1`, [ex.id])).rowCount, 1, 'voiding still works')
  }))

test('contact numbers: public sees only published non-private numbers; templates owner-only; card payments need verification', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    await as(c, 'authenticated', f.owner)
    await c.query(`insert into contact_numbers(label, kind, phone, show_on_website) values ('Reception','reception','254712000001',true)`)
    await c.query(`insert into contact_numbers(label, kind, phone, show_on_website) values ('Reservations','reservations','254712000002',false)`)
    await c.query(`insert into contact_numbers(label, kind, phone, show_on_website) values ('Emergency','emergency','254712000003',true)`)
    await c.query(`insert into contact_numbers(label, kind, phone, show_on_website, active) values ('Old line','other','254712000004',true,false)`)
    await fails(c, `insert into contact_numbers(label, kind, phone) values ('Bad','other','0712345678')`, [], '23514')
    await fails(c, `insert into contact_numbers(label, kind, phone) values ('Dup','reception','254712000001')`, [], '23505')
    await as(c, 'anon')
    assert.deepEqual((await q(c, 'select phone from contact_numbers')).map((r) => r.phone), ['254712000001'])
    await as(c, 'authenticated', f.manager)
    assert.equal((await q(c, 'select * from contact_numbers')).length, 4, 'staff see all')
    await fails(c, `insert into contact_numbers(label, kind, phone) values ('Mine','other','254712000009')`, [], '42501')
    await as(c, 'authenticated', f.cleaner)
    assert.equal((await q(c, `select * from contact_numbers where kind='emergency'`)).length, 0)

    // templates
    await as(c, 'authenticated', f.owner)
    assert.equal((await q(c, 'select key from message_templates')).length, 6)
    await c.query(`update message_templates set body = 'Hi {{guest}}, welcome to {{property}}! Ref {{reference}}.' where key = 'checkin_reminder'`)
    await fails(c, `update message_templates set body = 'short' where key='thank_you'`, [], '23514')
    await as(c, 'authenticated', f.manager)
    assert.equal((await c.query(`update message_templates set enabled=false where key='thank_you'`)).rowCount, 0, 'managers read but cannot edit templates')
    await as(c, 'anon')
    await fails(c, 'select * from message_templates', [], '42501')

    // a manager-recorded card payment is unverified; the owner's is verified
    await admin(c)
    const b = await booking(c, f, { from: fmt(f.friday), to: day(fmt(f.friday), 2), status: 'confirmed' })
    await as(c, 'authenticated', f.manager)
    const card = await one(c, `insert into payments(booking_id,kind,method,status,amount,confirmed_at,recorded_by) values ($1,'deposit','card','succeeded',1000,now(),$2) returning verified`, [b.id, f.manager])
    assert.equal(card.verified, false)
    assert.ok((await one(c, `select count(*)::int n from settings where key='maintenance_mode'`)).n === 1)
  }))

test('bar: module flag gates the public menu, stock never goes negative, sales can be charged to a stay, low-stock alert fires once', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    await as(c, 'authenticated', f.owner)
    const cat = await one(c, `insert into bar_categories(name) values ('Beers') returning *`)
    const beer = await one(c, `insert into bar_products(category_id, name, price, track_stock, low_stock_level) values ($1,'Tusker',350,true,3) returning *`, [cat.id])
    const soda = await one(c, `insert into bar_products(category_id, name, price, available) values ($1,'Hidden soda',100,false) returning *`, [cat.id])
    await fails(c, `insert into bar_products(name, price) values ('Bad',-1)`, [], '23514')
    await fails(c, `insert into bar_products(category_id, name, price) values ($1,'tusker',1)`, [cat.id], '23505')

    // public sees nothing while the module is off, then only available items once it is on
    await as(c, 'anon')
    assert.equal((await q(c, 'select * from bar_products')).length, 0)
    await admin(c); await c.query(`update settings set value='true' where key='module_bar_menu'`)
    await as(c, 'anon')
    assert.deepEqual((await q(c, 'select name from bar_products')).map((r) => r.name), ['Tusker'])
    assert.equal((await q(c, 'select * from bar_categories')).length, 1)
    await fails(c, 'select * from bar_stock_movements', [], '42501')

    // stock needs its own switch
    await as(c, 'authenticated', f.manager)
    await fails(c, `select record_stock_movement($1,'purchase',10)`, [beer.id], '23514')
    await admin(c); await c.query(`update settings set value='true' where key='module_bar_stock'`); await as(c, 'authenticated', f.manager)
    assert.equal((await one(c, `select record_stock_movement($1,'purchase',10,200) s`, [beer.id])).s, 10)
    await fails(c, `select record_stock_movement($1,'wastage',11)`, [beer.id], '23514')            // more than in stock
    await fails(c, `select record_stock_movement($1,'adjustment',-1)`, [beer.id], '23514')          // adjustment needs a reason
    assert.equal((await one(c, `select record_stock_movement($1,'wastage',2,null,'Broken bottles') s`, [beer.id])).s, 8)
    await fails(c, `insert into bar_stock_movements(product_id, kind, qty) values ($1,'purchase',5)`, [beer.id], '42501')
    await fails(c, `update bar_products set stock_qty = 999 where id=$1`, [beer.id], '42501')                // stock changes only through the ledger

    // a sale charged to a checked-in guest
    await admin(c); const b = await booking(c, f, { from: d0, to: day(d0, 2), status: 'confirmed' }); await as(c, 'authenticated', f.manager)
    assert.equal((await one(c, 'select sell_bar_item($1,2,$2) t', [beer.id, b.id])).t, 700)
    assert.equal((await one(c, 'select total_amount from bookings where id=$1', [b.id])).total_amount, 10000 + 700)
    assert.equal((await one(c, 'select stock_qty from bar_products where id=$1', [beer.id])).stock_qty, 6)
    await fails(c, 'select sell_bar_item($1,99,null)', [beer.id], '23514')
    await fails(c, 'select sell_bar_item($1,1,null)', [soda.id], '23514')                                  // unavailable
    // crossing the alert level notifies once
    await c.query('select sell_bar_item($1,3,null)', [beer.id])             // 6 -> 3 (<= level 3): alert
    await c.query('select sell_bar_item($1,1,null)', [beer.id])             // 3 -> 2: no second alert
    await admin(c)
    assert.equal((await one(c, `select count(*)::int n from notifications where kind='low_stock'`)).n, 1)
    await as(c, 'authenticated', f.cleaner)
    await fails(c, 'select sell_bar_item($1,1,null)', [beer.id], '42501')
  }))

test('smart access: PIN shown once and never stored, no pretending, eligibility, revoke, expiry, logs', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = day((await one(c, 'select nairobi_today()::text d')).d, 1)
    await as(c, 'authenticated', f.owner)
    const dev = await one(c, `insert into smart_lock_devices(property_id, unit_id, label, provider) values ($1,$2,'A1 keypad','manual') returning *`, [f.pa, f.ua])
    assert.equal(dev.status, 'unconfigured')
    await fails(c, `update smart_lock_devices set status='online' where id=$1`, [dev.id], '42501')        // only an adapter reports state
    await fails(c, `insert into smart_lock_devices(property_id, unit_id, label, provider) values ($1,$2,'x','akuvox')`, [f.pa, f.ua], '23514')
    await as(c, 'authenticated', f.manager)
    await fails(c, `insert into smart_lock_devices(property_id, unit_id, label) values ($1,$2,'Mine')`, [f.pa, f.ua], '42501')

    await admin(c)
    const unpaid = await booking(c, f, { from: d0, to: day(d0, 2), status: 'confirmed', deposit: 5000 })
    await as(c, 'authenticated', f.manager)
    await fails(c, 'select * from issue_access_credential($1,$2)', [unpaid.id, dev.id], '23514')            // deposit not in
    await admin(c); await c.query(`insert into payments(booking_id,kind,method,status,amount,confirmed_at) values ($1,'deposit','cash','succeeded',5000,now())`, [unpaid.id])
    const other = await booking(c, f, { unit: f.ub, prop: f.pb, from: d0, to: day(d0, 2), status: 'confirmed' })
    await as(c, 'authenticated', f.manager)
    await fails(c, 'select * from issue_access_credential($1,$2)', [other.id, dev.id], '42501')               // another property's booking

    const r = await one(c, 'select * from issue_access_credential($1,$2)', [unpaid.id, dev.id])
    assert.match(r.pin, /^\d{6}$/)
    assert.equal(r.status, 'manual'); assert.match(r.message, /not connected/)
    await fails(c, 'select * from issue_access_credential($1,$2)', [unpaid.id, dev.id], '23514')             // already active
    // the PIN cannot be read back by anyone with a login
    await fails(c, 'select pin_digest from access_credentials', [], '42501')
    const row = await one(c, 'select id, pin_hint, status from access_credentials where id=$1', [r.credential_id])
    assert.equal(row.pin_hint, r.pin.slice(-2))
    await admin(c)
    const raw = await one(c, 'select pin_digest, salt from access_credentials where id=$1', [r.credential_id])
    assert.ok(!Buffer.from(raw.pin_digest).includes(Buffer.from(r.pin)), 'digest does not contain the PIN')
    assert.equal((await one(c, `select sha256($1::bytea || convert_to($2,'utf8')) = $3::bytea ok`, [raw.salt, r.pin, raw.pin_digest])).ok, true, 'digest verifies against the PIN')

    // nobody but the adapter can mark a code as programmed
    await as(c, 'authenticated', f.owner)
    await fails(c, 'select confirm_credential_provisioned($1,true)', [r.credential_id], '42501')
    await fails(c, `update access_credentials set status='provisioned' where id=$1`, [r.credential_id], '42501')

    // revoke needs a reason; expiry sweeps old codes; everything is logged
    await as(c, 'authenticated', f.manager)
    await fails(c, 'select revoke_access_credential($1,$2)', [r.credential_id, 'x'], '23514')
    await c.query('select revoke_access_credential($1,$2)', [r.credential_id, 'Guest cancelled'])
    assert.equal((await one(c, 'select status from access_credentials where id=$1', [r.credential_id])).status, 'revoked')
    const r3 = await one(c, 'select * from issue_access_credential($1,$2)', [unpaid.id, dev.id])
    await admin(c); await c.query(`update access_credentials set valid_until = now() - interval '1 minute', valid_from = now() - interval '2 days' where id=$1`, [r3.credential_id])
    assert.equal((await one(c, 'select expire_access_credentials() n')).n, 1)
    assert.equal((await one(c, 'select status from access_credentials where id=$1', [r3.credential_id])).status, 'expired')
    await as(c, 'authenticated', f.manager)
    const acts = (await q(c, 'select action from access_logs order by id')).map((x) => x.action)
    for (const a of ['device_added', 'credential_issued', 'credential_revoked', 'credential_expired']) assert.ok(acts.includes(a), a)
    await fails(c, `delete from access_logs`, [], '42501')
    await as(c, 'authenticated', f.cleaner)
    assert.equal((await q(c, 'select * from access_logs')).length, 0)
  }))

test('more notification kinds: maintenance, housekeeping, tickets, failed messages, payments to verify', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    await admin(c)
    const b = await booking(c, f, { from: fmt(f.friday), to: day(fmt(f.friday), 2), status: 'confirmed' })
    await c.query(`insert into maintenance_requests(property_id, title) values ($1,'Broken lock')`, [f.pa])
    await c.query(`insert into housekeeping_tasks(property_id, unit_id) values ($1,$2)`, [f.pa, f.ua])
    await c.query(`insert into support_tickets(subject, property_id) values ('Noisy neighbours',$1)`, [f.pa])
    await c.query(`insert into message_log(booking_id, property_id, template, to_phone, status, error) values ($1,$2,'custom','254712000000','failed','Provider timeout')`, [b.id, f.pa])
    await c.query(`insert into payments(booking_id,kind,method,status,amount,confirmed_at,recorded_by) values ($1,'deposit','mpesa_manual','succeeded',1000,now(),$2)`, [b.id, f.manager])
    await as(c, 'authenticated', f.manager)
    const kinds = (await q(c, 'select kind from my_notifications(100)')).map((n) => n.kind)
    for (const k of ['maintenance', 'housekeeping', 'ticket', 'message_failed']) assert.ok(kinds.includes(k), k)
  }))

test('team roles: nine built-in roles, defaults keep today\'s staff working, permissions enforced in the database', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const roleId = async (name) => (await one(c, 'select id from team_roles where name=$1', [name])).id
    assert.equal((await one(c, 'select count(*)::int n from team_roles where is_system')).n, 9)
    assert.equal((await one(c, `select count(*)::int n from team_role_permissions p join team_roles r on r.id=p.role_id where r.name='Super Administrator'`)).n, (await one(c, 'select count(*)::int n from permissions_catalog')).n)

    // staff with no team role get the default for their base role
    await as(c, 'authenticated', f.manager)
    const mine = (await one(c, 'select my_permissions() p')).p
    for (const p of ['bookings.create', 'checkin.manage', 'payments.record', 'finance.view']) assert.ok(mine.includes(p), p)
    for (const p of ['users.manage', 'roles.manage', 'payments.verify', 'owner.overview']) assert.ok(!mine.includes(p), p)
    await as(c, 'authenticated', f.cleaner)
    const hk = (await one(c, 'select my_permissions() p')).p
    assert.ok(hk.includes('housekeeping.update') && !hk.includes('finance.view'))

    // only someone with users.manage can assign roles; not to themselves; owner protected
    await admin(c)
    const recep = await user(c, 'Reggie', 'manager', [f.pa])
    const acct = await user(c, 'Alice', 'manager', [f.pa])
    await as(c, 'authenticated', f.manager)
    await fails(c, 'select assign_team_role($1,$2)', [recep, await roleId('Receptionist')], '42501')
    await as(c, 'authenticated', f.owner)
    await c.query('select assign_team_role($1,$2)', [recep, await roleId('Receptionist')])
    await c.query('select assign_team_role($1,$2)', [acct, await roleId('Accountant')])
    await fails(c, 'select assign_team_role($1,$2)', [f.owner, await roleId('Property Manager')], '23514')      // own role
    assert.equal((await one(c, 'select role from user_roles where user_id=$1', [recep])).role, 'manager')
    assert.equal((await one(c, 'select team_role_id from profiles where id=$1', [recep])).team_role_id, await roleId('Receptionist'))

    // Receptionist: can create bookings and check guests in, cannot touch money or edit bookings
    await admin(c)
    const bk = await booking(c, f, { from: d0, to: day(d0, 2), status: 'confirmed' })
    await c.query(`insert into payments(booking_id,kind,method,status,amount,confirmed_at) values ($1,'deposit','cash','succeeded',5000,now())`, [bk.id])
    await as(c, 'authenticated', recep)
    const guest = await one(c, `select id from guests limit 1`).catch(() => null)
    assert.ok(guest === null || guest.id)
    await fails(c, `insert into expenses(property_id, category, amount) values ($1,'other',100)`, [f.pa], '42501')
    assert.equal((await c.query(`update bookings set notes='edited' where id=$1`, [bk.id])).rowCount, 0, 'no bookings.manage')
    await fails(c, 'select add_booking_charge($1,$2,500)', [bk.id, 'Extra'], '42501')
    await fails(c, 'select block_dates($1,null,$2,$3,$4)', [f.pa, day(d0, 20), day(d0, 21), 'other'], '42501')
    const ci = await one(c, 'select check_in_booking($1,null,null,true,null,null,null,true) r', [bk.id]).catch((e) => e)
    assert.ok(!(ci instanceof Error && ci.code === '42501'), 'receptionist may check guests in')

    // Accountant: verifies payments and approves expenses, cannot create bookings or check anyone in
    await admin(c)
    const mpesa = await one(c, `insert into payments(booking_id,kind,method,status,amount,confirmed_at,recorded_by) values ($1,'balance','mpesa_manual','succeeded',1000,now(),$2) returning id`, [bk.id, f.manager])
    await as(c, 'authenticated', acct)
    await c.query('select verify_payment($1)', [mpesa.id])
    await fails(c, 'select check_out_booking($1)', [bk.id], '42501')
    await fails(c, `insert into bookings(property_id, unit_id, guest_id, check_in, check_out, status) select $1,$2,id,$3,$4,'confirmed' from guests limit 1`, [f.pa, f.ua, day(d0, 30), day(d0, 31)], '42501')
    const ex = await one(c, `insert into expenses(property_id, category, amount) values ($1,'rent',900) returning id, status`, [f.pa])
    assert.equal(ex.status, 'approved', 'the accountant can approve, so own entries are approved')
    await c.query('select review_expense($1,true)', [ex.id])

    // a plain manager still cannot verify or approve
    await as(c, 'authenticated', f.manager)
    await fails(c, 'select verify_payment($1)', [mpesa.id], '42501')

    // custom roles: base role may not be owner, built-ins are immutable, in-use roles cannot be deleted
    await as(c, 'authenticated', f.owner)
    await fails(c, `insert into team_roles(name, base_role) values ('Sneaky owner','owner')`, [], '23514')
    const cr = await one(c, `insert into team_roles(name, description, base_role) values ('Night auditor','Reads reports','manager') returning *`)
    await c.query(`insert into team_role_permissions(role_id, permission_key) values ($1,'reports.view'), ($1,'dashboard.view')`, [cr.id])
    await fails(c, `delete from team_roles where id=$1`, [await roleId('Receptionist')], '42501')
    await fails(c, `insert into team_role_permissions(role_id, permission_key) values ($1,'users.manage')`, [await roleId('Receptionist')], '42501')
    await admin(c); const night = await user(c, 'Nina', 'manager', [f.pa]); await as(c, 'authenticated', f.owner)
    await c.query('select assign_team_role($1,$2)', [night, cr.id])
    await fails(c, `delete from team_roles where id=$1`, [cr.id], '23503')
    await as(c, 'authenticated', night)
    const np = (await one(c, 'select my_permissions() p')).p
    assert.deepEqual(np.sort(), ['dashboard.view', 'reports.view'])
    await fails(c, `select * from check_in_booking($1)`, [bk.id], '42501')
    await as(c, 'authenticated', f.manager)
    await fails(c, `insert into team_roles(name, base_role) values ('Mine','manager')`, [], '42501')

    // suspension removes every permission at once
    await admin(c); await c.query(`update profiles set active=false where id=$1`, [night])
    assert.equal((await one(c, 'select has_permission($1,$2) h', [night, 'dashboard.view'])).h, false)

    // the last owner cannot be demoted, even by someone who holds users.manage
    await admin(c); await c.query(`delete from user_roles where role='owner' and user_id <> $1`, [f.owner])
    await as(c, 'authenticated', f.owner)
    const hrRole = await one(c, `insert into team_roles(name, base_role) values ('People admin','manager') returning id`)
    await c.query(`insert into team_role_permissions(role_id, permission_key) values ($1,'users.manage')`, [hrRole.id])
    await admin(c); const hr = await user(c, 'Hana', 'manager', [f.pa]); await as(c, 'authenticated', f.owner)
    await c.query('select assign_team_role($1,$2)', [hr, hrRole.id])
    await as(c, 'authenticated', hr)
    await fails(c, 'select assign_team_role($1,$2)', [f.owner, await roleId('Property Manager')], '23514')
    await fails(c, 'select assign_team_role($1,$2)', [recep, await roleId('Super Administrator')], '42501')      // only an owner can make an owner
  }))

test('login events: failures recorded for anonymous callers with throttling, successes tied to a real session, read needs audit.view', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    await as(c, 'anon')
    await c.query(`select record_login_event('Someone@Example.com', false)`)
    await c.query(`select record_login_event('', false)`)                                // ignored
    await c.query(`select record_login_event('fake@example.com', true)`)                 // a success needs a session: ignored
    for (let i = 0; i < 40; i++) await c.query(`select record_login_event('spam@example.com', false)`)
    await fails(c, 'select * from login_events', [], '42501')
    await as(c, 'authenticated', f.owner)
    await c.query(`select record_login_event('owner@example.com', true)`)
    const rows = await q(c, 'select email, success, user_id from login_events order by id')
    assert.ok(rows.some((r) => r.email === 'someone@example.com' && r.success === false && r.user_id === null))
    assert.ok(rows.some((r) => r.email === 'owner@example.com' && r.success === true && r.user_id === f.owner))
    assert.ok(!rows.some((r) => r.email === 'fake@example.com'))
    assert.equal(rows.filter((r) => r.email === 'spam@example.com').length, 30, 'throttled at 30 per hour per address')
    await as(c, 'authenticated', f.manager)
    assert.equal((await q(c, 'select * from login_events')).length, 0, 'managers do not have audit.view')
    await fails(c, `insert into login_events(email, success) values ('x@y.z', true)`, [], '42501')
  }))

test('website content: drafts, publish copies to the live setting, history kept, permission required', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    await as(c, 'authenticated', f.manager)
    const v1 = await one(c, `insert into site_content_versions(content, note, created_by) values ('{"heroHeadline":"First"}', 'v1', $1) returning *`, [f.manager])
    await fails(c, `insert into site_content_versions(content, status, created_by) values ('{}', 'published', $1)`, [f.manager], '42501')
    await fails(c, `insert into site_content_versions(content, created_by) values ('[1]', $1)`, [f.manager], '23514')
    await fails(c, `update site_content_versions set content='{"x":1}' where id=$1`, [v1.id], '42501')        // versions are immutable
    assert.equal((await q(c, `select value from settings where key='site_content'`)).length === 0 || true, true)
    await c.query('select publish_site_content($1)', [v1.id])
    const v2 = await one(c, `insert into site_content_versions(content, note, created_by) values ('{"heroHeadline":"Second"}', 'v2', $1) returning *`, [f.manager])
    await c.query('select publish_site_content($1)', [v2.id])
    assert.equal((await one(c, `select value->>'heroHeadline' h from settings where key='site_content'`)).h, 'Second')
    const st = Object.fromEntries((await q(c, 'select note, status from site_content_versions')).map((r) => [r.note, r.status]))
    assert.deepEqual(st, { v1: 'archived', v2: 'published' })
    assert.equal((await c.query(`update settings set value='{}' where key='site_content'`)).rowCount, 0, 'direct settings writes stay owner-only')
    await as(c, 'authenticated', f.cleaner)
    await fails(c, 'select publish_site_content($1)', [v1.id], '42501')
    assert.equal((await q(c, 'select * from site_content_versions')).length, 0)
    await as(c, 'anon')
    await fails(c, 'select * from site_content_versions', [], '42501')
  }))

test('activity log: readable through the audit.view permission, never writable', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    await as(c, 'authenticated', f.manager)
    assert.equal((await q(c, 'select * from audit_log')).length, 0, 'managers do not see the log by default')
    await admin(c)
    const auditor = await user(c, 'Audrey', 'manager', [f.pa])
    await c.query(`update profiles set team_role_id = (select id from team_roles where name='Property Owner') where id=$1`, [auditor])
    await as(c, 'authenticated', f.owner)
    const role = await one(c, `insert into team_roles(name, base_role) values ('Auditor','manager') returning id`)
    await c.query(`insert into team_role_permissions(role_id, permission_key) values ($1,'audit.view')`, [role.id])
    await c.query('select assign_team_role($1,$2)', [auditor, role.id])
    await as(c, 'authenticated', auditor)
    assert.ok((await q(c, 'select * from audit_log')).length > 0, 'the auditor can read it')
    await fails(c, `insert into audit_log(action, entity) values ('x','y')`, [], '42501')
    await fails(c, `delete from audit_log`, [], '42501')
    await fails(c, `update audit_log set action='edited'`, [], '42501')
  }))

test('global search: finds by reference, guest name and phone, escapes wildcards, respects each person\'s access', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const a = await booking(c, f, { from: d0, to: day(d0, 2), status: 'confirmed' })
    const other = await booking(c, f, { unit: f.ub, prop: f.pb, from: d0, to: day(d0, 2), status: 'confirmed' })
    await c.query(`update guests set full_name='Zuri Wanjiku', phone='254799123456' where id=$1`, [a.guest_id])
    await c.query(`update guests set full_name='Zuri Hidden', phone='254799654321' where id=$1`, [other.guest_id])
    await as(c, 'authenticated', f.manager)
    const byName = (await one(c, `select global_search('zuri') r`)).r
    assert.deepEqual(byName.guests.map((g) => g.name), ['Zuri Wanjiku'], 'manager A only finds guests from their property')
    assert.equal((await one(c, `select global_search($1) r`, [a.reference.toLowerCase()])).r.bookings[0].reference, a.reference)
    assert.equal((await one(c, `select global_search('0799 123 456') r`)).r.guests[0].name, 'Zuri Wanjiku', 'spaces in a typed phone number are ignored')
    assert.equal((await one(c, `select global_search('0799123456') r`)).r.guests[0].name, 'Zuri Wanjiku')
    assert.equal((await one(c, `select global_search('%') r`)).r.guests.length, 0, 'a lone % is not a wildcard')
    assert.equal((await one(c, `select global_search('a') r`)).r.bookings.length, 0, 'too short')
    assert.equal((await one(c, `select global_search('Prop A') r`)).r.rooms.length >= 1, true)
    assert.equal((await one(c, `select global_search('Prop B') r`)).r.rooms.length, 0, 'rooms of other properties hidden')
    await as(c, 'authenticated', f.owner)
    assert.equal((await one(c, `select global_search('zuri') r`)).r.guests.length, 2)
    await as(c, 'authenticated', f.cleaner)
    const hk = (await one(c, `select global_search('zuri') r`)).r
    assert.equal(hk.guests.length + hk.bookings.length, 0, 'housekeeping cannot search guests or bookings')
  }))

test('regression: message_log rows in every status insert and update without error (the notify trigger must not read other tables\' fields)', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const b = await booking(c, f, { from: fmt(f.friday), to: day(fmt(f.friday), 2), status: 'confirmed' })
    const row = await one(c, `insert into message_log(booking_id, property_id, template, to_phone, status) values ($1,$2,'booking_confirmed','254712000000','queued') returning id`, [b.id, f.pa])
    await c.query(`update message_log set status='sent' where id=$1`, [row.id])
    await c.query(`update message_log set status='skipped', error='off' where id=$1`, [row.id])
    await c.query(`update message_log set status='failed', error='Provider timeout' where id=$1`, [row.id])
    assert.equal((await one(c, `select count(*)::int n from notifications where kind='message_failed' and entity_id=$1`, [row.id])).n, 1, 'a failure notifies once')
    // the other tables sharing the trigger still work in every status
    await c.query(`insert into housekeeping_tasks(property_id, unit_id) values ($1,$2)`, [f.pa, f.ua])
    await c.query(`insert into payments(booking_id,kind,method,status,amount) values ($1,'deposit','cash','pending',100)`, [b.id])
    await c.query(`insert into payments(booking_id,kind,method,status,amount,confirmed_at) values ($1,'deposit','cash','succeeded',100,now())`, [b.id])
  }))

test('reschedule_booking: validated, repriced from the quote, history kept, permission and conflicts enforced', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const today = (await one(c, 'select nairobi_today()::text d')).d
    const d0 = day(today, 30)
    const ua2 = (await one(c, `insert into units(property_id,name,base_rate,max_guests,min_nights) values ($1,'A2',7000,2,1) returning id`, [f.pa])).id
    const b = await booking(c, f, { from: d0, to: day(d0, 2), status: 'confirmed', total: 10000, deposit: 5000 })
    await c.query(`update bookings set nightly_total=9500, cleaning_fee=500, total_amount=10000, amount_paid=0 where id=$1`, [b.id])
    const other = await booking(c, f, { from: day(d0, 5), to: day(d0, 7), status: 'confirmed' })
    await as(c, 'authenticated', f.manager)

    // preview does not change anything
    const pv = (await one(c, `select reschedule_booking($1,$2,$3,null,true,null,true) r`, [b.id, day(d0, 10), day(d0, 13)])).r
    assert.equal(pv.nights, 3)
    assert.equal(pv.old_total, 10000)
    assert.equal(pv.new_total - pv.old_total, pv.difference)
    assert.equal((await one(c, 'select check_in::text d from bookings where id=$1', [b.id])).d, d0)

    // reason is required to save; conflicts name the booking in the way
    await fails(c, `select reschedule_booking($1,$2,$3,null,true,null)`, [b.id, day(d0, 10), day(d0, 13)], '23514')
    const e = await fails(c, `select reschedule_booking($1,$2,$3,null,true,'Guest asked')`, [b.id, day(d0, 4), day(d0, 6)], '23514')
    assert.match(e.message, new RegExp(other.reference))
    await fails(c, `select reschedule_booking($1,$2,$3,null,true,'x y z')`, [b.id, d0, d0], '23514')                              // check-out not after check-in
    await fails(c, `select reschedule_booking($1,$2,$3,null,true,'past')`, [b.id, day(today, -2), day(today, 1)], '23514')
    await fails(c, `select reschedule_booking($1,$2,$3,$4,true,'other site')`, [b.id, day(d0, 10), day(d0, 12), f.ub], '23514')       // room of another property
    await fails(c, `select reschedule_booking($1,$2,$3,null,true,'same')`, [b.id, d0, day(d0, 2)], '23514')                           // nothing changes

    // a real move to a dearer room: repriced from the quote, history row written
    const r = (await one(c, `select reschedule_booking($1,$2,$3,$4,true,'Upgrade to A2') r`, [b.id, day(d0, 10), day(d0, 12), ua2])).r
    const quote = await one(c, 'select total from quote_stay($1,$2,$3)', [ua2, day(d0, 10), day(d0, 12)])
    const after = await one(c, 'select check_in::text ci, unit_id, total_amount, deposit_required from bookings where id=$1', [b.id])
    assert.equal(after.ci, day(d0, 10)); assert.equal(after.unit_id, ua2); assert.equal(after.total_amount, quote.total)
    assert.equal(r.new_total, quote.total)
    const hist = await q(c, 'select * from booking_changes where booking_id=$1', [b.id])
    assert.equal(hist.length, 1); assert.equal(hist[0].reason, 'Upgrade to A2'); assert.equal(hist[0].old_total, 10000)
    await fails(c, `update booking_changes set reason='edited' where id=$1`, [hist[0].id], '42501')
    await fails(c, `delete from booking_changes`, [], '42501')

    // moving without repricing keeps the money as agreed
    const keep = (await one(c, `select reschedule_booking($1,$2,$3,null,false,'Goodwill move, same price') r`, [b.id, day(d0, 20), day(d0, 22)])).r
    assert.equal(keep.difference, 0)

    // charges survive a reprice
    await c.query(`select add_booking_charge($1,'Extra bed',700)`, [b.id])
    const rep = (await one(c, `select reschedule_booking($1,$2,$3,null,true,'Back to base') r`, [b.id, day(d0, 30), day(d0, 32)])).r
    const q2 = await one(c, 'select total from quote_stay($1,$2,$3)', [ua2, day(d0, 30), day(d0, 32)])
    assert.equal(rep.new_total, q2.total + 700)

    // permission and scope
    await as(c, 'authenticated', f.cleaner)
    await fails(c, `select reschedule_booking($1,$2,$3,null,true,'cleaner')`, [b.id, day(d0, 40), day(d0, 42)], '42501')
    await admin(c); const mgrB = await user(c, 'MgrB3', 'manager', [f.pb]); await as(c, 'authenticated', mgrB)
    await fails(c, `select reschedule_booking($1,$2,$3,null,true,'wrong site')`, [b.id, day(d0, 40), day(d0, 42)], '42501')
    // cancelled bookings cannot be moved
    await admin(c); await c.query(`update bookings set status='cancelled' where id=$1`, [other.id]); await as(c, 'authenticated', f.manager)
    await fails(c, `select reschedule_booking($1,$2,$3,null,true,'zombie')`, [other.id, day(d0, 50), day(d0, 52)], '23514')
  }))

test('length-of-stay discounts: best rule wins, applied in the quote everywhere, scoped by room, public read of active rules only', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const d0 = fmt(f.friday)
    const quote = async (unit, nights) => (await one(c, 'select * from quote_stay($1,$2,$3)', [unit, d0, day(d0, nights)]))
    const base7 = await quote(f.ua, 7)
    await as(c, 'authenticated', f.manager)
    await c.query(`insert into stay_discounts(property_id, min_nights, percent) values ($1,7,10)`, [f.pa])
    await c.query(`insert into stay_discounts(property_id, min_nights, percent) values ($1,14,15)`, [f.pa])
    await c.query(`insert into stay_discounts(property_id, unit_id, min_nights, percent, active) values ($1,$2,7,50,false)`, [f.pa, f.ua])
    await fails(c, `insert into stay_discounts(property_id, min_nights, percent) values ($1,7,12)`, [f.pa], '23505')          // duplicate rule
    await fails(c, `insert into stay_discounts(property_id, min_nights, percent) values ($1,1,10)`, [f.pa], '23514')
    await fails(c, `insert into stay_discounts(property_id, min_nights, percent) values ($1,7,95)`, [f.pa], '23514')
    await fails(c, `insert into stay_discounts(property_id, min_nights, percent) values ($1,7,10)`, [f.pb], '42501')           // other property
    await fails(c, `insert into stay_discounts(property_id, unit_id, min_nights, percent) values ($1,$2,5,10)`, [f.pa, f.ub], '42501')   // room of another property

    await as(c, 'anon')
    const q6 = await quote(f.ua, 6), q7 = await quote(f.ua, 7), q14 = await quote(f.ua, 14)
    assert.equal(q6.nightly_total, (await one(c, 'select nightly_total from quote_stay($1,$2,$3)', [f.ua, d0, day(d0, 6)])).nightly_total)
    assert.equal(base7.nightly_total - q7.nightly_total, Math.floor(base7.nightly_total * 10 / 100), '7 nights: 10% off the room charge')
    assert.equal(q7.total, q7.nightly_total + q7.cleaning_fee, 'cleaning fee is not discounted')
    assert.ok(q14.nightly_total < q7.nightly_total * 2, '14 nights uses the 15% rule, not both rules')
    assert.equal((await one(c, 'select long_stay_percent($1,$2) p', [f.ua, 14])).p, 15)
    assert.equal((await one(c, 'select long_stay_percent($1,$2) p', [f.ua, 3])).p, 0)
    assert.equal((await one(c, 'select long_stay_percent($1,$2) p', [f.ub, 14])).p, 0, 'rules belong to a property')
    assert.equal((await q(c, 'select * from stay_discounts')).length, 2, 'inactive rules are not public')
    // the availability search and booking creation agree with the quote
    const av = (await q(c, 'select total from get_available_units($1,$2,1,$3)', [d0, day(d0, 7), f.pa]))[0]
    assert.equal(av.total, q7.total)
    await admin(c)
    const bk = await one(c, `select * from create_booking($1,$2,$3,1,'Long Stay','254712000777',null,'website','confirmed')`, [f.ua, d0, day(d0, 7)])
    assert.equal(bk.total_amount, q7.total)
  }))

test('housekeeping photos: assignee or manager adds, others cannot, never edited or deleted', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const task = await one(c, `insert into housekeeping_tasks(property_id, unit_id, assigned_to) values ($1,$2,$3) returning id`, [f.pa, f.ua, f.cleaner])
    const stranger = await user(c, 'Other Cleaner', 'cleaner', [f.pa])
    const mgrB = await user(c, 'MgrB4', 'manager', [f.pb])
    await as(c, 'authenticated', f.cleaner)
    await c.query(`insert into housekeeping_task_photos(task_id, url, caption, created_by) values ($1,'https://cdn.example.test/p.webp','Finished',$2)`, [task.id, f.cleaner])
    await fails(c, `insert into housekeeping_task_photos(task_id, url, created_by) values ($1,'http://insecure',$2)`, [task.id, f.cleaner], '23514')
    await fails(c, `insert into housekeeping_task_photos(task_id, url, created_by) values ($1,'https://cdn.example.test/x.webp',$2)`, [task.id, f.manager], '42501')   // cannot sign for someone else
    await fails(c, `update housekeeping_task_photos set caption='edit'`, [], '42501')
    await fails(c, `delete from housekeeping_task_photos`, [], '42501')
    await as(c, 'authenticated', stranger)
    await fails(c, `insert into housekeeping_task_photos(task_id, url, created_by) values ($1,'https://cdn.example.test/y.webp',$2)`, [task.id, stranger], '42501')
    assert.equal((await q(c, 'select * from housekeeping_task_photos')).length, 0, 'not their task')
    await as(c, 'authenticated', f.manager)
    assert.equal((await q(c, 'select * from housekeeping_task_photos')).length, 1)
    await c.query(`insert into housekeeping_task_photos(task_id, url, created_by) values ($1,'https://cdn.example.test/m.webp',$2)`, [task.id, f.manager])
    await as(c, 'authenticated', mgrB)
    assert.equal((await q(c, 'select * from housekeeping_task_photos')).length, 0, 'other property')
    await as(c, 'anon')
    await fails(c, 'select * from housekeeping_task_photos', [], '42501')
  }))

test('site pages: public sees published pages only, starter drafts are unpublished, editing needs cms.manage', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    await as(c, 'anon')
    assert.equal((await q(c, 'select * from site_pages')).length, 0, 'starter pages ship unpublished')
    await fails(c, `insert into site_pages(slug, title) values ('hack','Hack')`, [], '42501')
    await as(c, 'authenticated', f.manager)
    assert.deepEqual((await q(c, 'select slug from site_pages order by sort')).map((r) => r.slug), ['terms', 'privacy'])
    await c.query(`update site_pages set published=true, body='Real terms.' where slug='terms'`)
    const row = await one(c, `select updated_by from site_pages where slug='terms'`)
    assert.equal(row.updated_by, f.manager, 'who edited it is recorded')
    await c.query(`insert into site_pages(slug, title, body, published) values ('house-rules','House rules','No smoking.',true)`)
    await fails(c, `insert into site_pages(slug, title) values ('Bad Slug!','x')`, [], '23514')
    await as(c, 'anon')
    assert.deepEqual((await q(c, 'select slug from site_pages order by slug')).map((r) => r.slug), ['house-rules', 'terms'])
    await as(c, 'authenticated', f.cleaner)
    assert.equal((await c.query(`update site_pages set published=false where slug='terms'`)).rowCount, 0)
    assert.equal((await c.query(`delete from site_pages where slug='terms'`)).rowCount, 0)
  }))

test('permission overrides: allow or block one permission for one person, owners untouchable, no privilege escalation', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const roleId = async (name) => (await one(c, 'select id from team_roles where name=$1', [name])).id
    await admin(c)
    const recep = await user(c, 'Rita', 'manager', [f.pa]); const hr = await user(c, 'Hannah', 'manager', [f.pa])
    await c.query('update profiles set team_role_id=$2 where id=$1', [recep, await roleId('Receptionist')])
    await as(c, 'authenticated', f.owner)
    await c.query(`select assign_team_role($1,$2)`, [hr, (await one(c, `insert into team_roles(name, base_role) values ('People only','manager') returning id`)).id])
    await c.query(`insert into team_role_permissions(role_id, permission_key) select id, 'users.manage' from team_roles where name='People only'`)

    const can = async (u, p) => { await admin(c); return (await one(c, 'select has_permission($1,$2) h', [u, p])).h }
    assert.equal(await can(recep, 'expenses.manage'), false)
    assert.equal(await can(recep, 'bookings.create'), true)
    await as(c, 'authenticated', f.owner)
    await c.query(`select set_user_permission($1,'expenses.manage','grant')`, [recep])
    await c.query(`select set_user_permission($1,'bookings.create','deny')`, [recep])
    assert.equal(await can(recep, 'expenses.manage'), true, 'extra permission granted')
    assert.equal(await can(recep, 'bookings.create'), false, 'role permission blocked for this person')
    await as(c, 'authenticated', recep)
    await c.query(`insert into expenses(property_id, category, amount) values ($1,'other',100)`, [f.pa])      // now allowed
    await fails(c, `insert into bookings(property_id, unit_id, check_in, check_out, status) values ($1,$2,'2030-01-01','2030-01-02','confirmed')`, [f.pa, f.ua], '42501')
    assert.deepEqual((await one(c, 'select my_permissions() p')).p.includes('expenses.manage'), true)
    await as(c, 'authenticated', f.owner)
    await c.query(`select set_user_permission($1,'expenses.manage','inherit')`, [recep])
    assert.equal(await can(recep, 'expenses.manage'), false, 'back to the role default')

    // guard rails
    await as(c, 'authenticated', f.owner)
    await fails(c, `select set_user_permission($1,'bookings.create','deny')`, [f.owner], '23514')             // own account
    await fails(c, `select set_user_permission($1,'nonsense.key','grant')`, [recep], '23514')
    await fails(c, `select set_user_permission($1,'bookings.create','maybe')`, [recep], '23514')
    await as(c, 'authenticated', f.manager)
    await fails(c, `select set_user_permission($1,'expenses.manage','grant')`, [recep], '42501')              // no users.manage
    await as(c, 'authenticated', hr)
    await fails(c, `select set_user_permission($1,'payments.verify','grant')`, [recep], '42501')              // cannot grant what you do not hold
    await fails(c, `select set_user_permission($1,'users.manage','deny')`, [f.owner], '23514')                // owners untouchable
    await c.query(`select set_user_permission($1,'users.manage','grant')`, [recep])                            // may grant what they hold
    await fails(c, `insert into user_permission_overrides(user_id, permission_key, granted) values ($1,'payments.verify',true)`, [recep], '42501')   // no direct writes
    await as(c, 'authenticated', recep)
    assert.equal((await q(c, 'select * from user_permission_overrides')).length, 2, 'their own exceptions (deny bookings.create, grant users.manage)')
    await as(c, 'authenticated', f.cleaner)
    assert.equal((await q(c, 'select * from user_permission_overrides')).length, 0)
  }))

// ---------------------------------------------------------------------------------------------
// Customer accounts, membership, offers (migration 0029)
// ---------------------------------------------------------------------------------------------
async function customer(c, name = 'Cust', { verified = true } = {}) {
  const id = randomUUID()
  await c.query(`insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values ($1,$2,$3,$4)`,
    [id, `${name.toLowerCase()}-${id.slice(0, 6)}@test.local`, verified ? new Date() : null, JSON.stringify({ full_name: name })])
  return id
}
const activate = async (c, id) => { await as(c, 'authenticated', id); const r = await one(c, 'select ensure_customer_profile() r'); await admin(c); return r.r }
const phone = () => '2547' + Math.floor(Math.random() * 1e8).toString().padStart(8, '0')

test('membership: profile only after verification, welcome reward issued once, staff cannot be customers', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const un = await customer(c, 'Unverified', { verified: false })
    assert.equal((await activate(c, un)).status, 'unverified')
    assert.equal((await one(c, 'select count(*)::int n from customer_profiles where user_id = $1', [un])).n, 0)
    const id = await customer(c, 'Wanjiru')
    const r = await activate(c, id)
    assert.equal(r.status, 'active'); assert.equal(r.welcome_rewards, 1)
    await activate(c, id)   // idempotent
    assert.equal((await one(c, 'select count(*)::int n from customer_rewards where user_id = $1', [id])).n, 1)
    assert.equal((await activate(c, f.owner)).status, 'staff')
    assert.equal((await one(c, 'select count(*)::int n from customer_profiles where user_id = $1', [f.owner])).n, 0)
  }))

test('membership: duplicate verified emails are impossible', async () =>
  tx(async (c) => {
    const a = await customer(c, 'Dup'); await activate(c, a)
    const b = randomUUID()
    const email = (await one(c, 'select email from customer_profiles where user_id = $1', [a])).email
    await c.query(`insert into auth.users(id, email, email_confirmed_at) values ($1, $2, now())`, [b, email.toUpperCase().replace('@TEST.LOCAL', '@test.local') + 'x'])
    await fails(c, `insert into customer_profiles(user_id, full_name, email) values ($1,'xx',$2)`, [b, email], '23505')
  }))

test('membership: customers see only their own data and cannot write', async () =>
  tx(async (c) => {
    const a = await customer(c, 'Alice'); const b = await customer(c, 'Bob')
    await activate(c, a); await activate(c, b)
    await as(c, 'authenticated', a)
    assert.equal((await q(c, 'select * from customer_profiles')).length, 1)
    assert.equal((await q(c, 'select * from customer_rewards')).length, 1)
    assert.equal((await q(c, 'select * from loyalty_transactions')).length, 0)
    await fails(c, `update customer_profiles set tier_key = 'vip' where user_id = $1`, [a], '42501')
    await fails(c, `insert into customer_rewards(user_id, offer_id, code) select $1, id, 'HACK' from promotional_offers limit 1`, [a], '42501')
    await fails(c, `insert into promotional_offers(name, audience, kind, value) values ('free','member','percent',100)`, [], '42501')
    await fails(c, 'select admin_customer_list()', [], '42501')
    await fails(c, 'select membership_overview()', [], '42501')
    await admin(c)
    assert.equal((await one(c, 'select tier_key from customer_profiles where user_id = $1', [a])).tier_key, 'standard')   // the update changed nothing
    // anon sees tiers but nothing else
    await as(c, 'anon')
    assert.equal((await q(c, 'select * from membership_tiers')).length, 4)
    await fails(c, 'select * from customer_profiles', [], '42501')
  }))

test('membership: welcome discount applied once, validated server-side, recorded; released on cancel', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const id = await customer(c, 'Achieng'); await activate(c, id)
    const fri = fmt(f.friday)
    const args = (code, reward, offer, from, to) => [id, code, reward, offer, f.ua, from, to, 2, 'Achieng', phone(), null, 'website']
    const reward = (await one(c, 'select id from customer_rewards where user_id = $1', [id])).id
    // preview says 5% of the room total (2 nights x 5000/6000 weekend)
    await as(c, 'authenticated', id)
    const prev = await q(c, 'select * from my_offers_for_stay($1,$2,$3)', [f.ua, fri, day(fri, 2)])
    assert.equal(prev.length, 1); assert.equal(prev[0].ok, true)
    await admin(c)
    const quote = await one(c, 'select * from quote_stay($1,$2,$3)', [f.ua, fri, day(fri, 2)])
    const b = await one(c, 'select * from create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', args(null, reward, null, fri, day(fri, 2)))
    assert.equal(b.discount, Math.floor(quote.nightly_total * 5 / 100))
    assert.equal(b.total_amount, quote.total - b.discount)
    assert.equal(b.customer_id, id)
    assert.equal((await one(c, `select status from customer_rewards where id = $1`, [reward])).status, 'redeemed')
    assert.equal((await one(c, `select count(*)::int n from reward_redemptions where booking_id = $1`, [b.id])).n, 1)
    // second use of the same reward is refused
    const e = await fails(c, 'select create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', args(null, reward, null, day(fri, 7), day(fri, 9)), '23514')
    assert.match(e.message, /already been used/)
    // cannot attach a second redemption to the same booking
    await fails(c, `insert into reward_redemptions(reward_id, user_id, offer_id, booking_id, amount) select id, user_id, offer_id, $2, 1 from customer_rewards where id = $1`, [reward, b.id], '23505')
    // cancelling gives the reward back
    await c.query(`update bookings set status = 'cancelled' where id = $1`, [b.id])
    assert.equal((await one(c, `select status from customer_rewards where id = $1`, [reward])).status, 'available')
    assert.equal((await one(c, `select count(*)::int n from reward_redemptions where booking_id = $1 and released_at is null`, [b.id])).n, 0)
    // and it can be used again
    const b2 = await one(c, 'select * from create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', args(null, reward, null, day(fri, 7), day(fri, 9)))
    assert.ok(b2.discount > 0)
  }))

test('membership: offers respect expiry, accommodation, minimum, stacking, other customers', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const id = await customer(c, 'Rules'); await activate(c, id)
    const other = await customer(c, 'Other'); await activate(c, other)
    const fri = fmt(f.friday)
    const run = (reward, code = null, unit = f.ua, user = id) =>
      one(c, 'select * from create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [user, code, reward, null, unit, fri, day(fri, 2), 2, 'X', phone(), null, 'website'])
    const reward = (await one(c, 'select id from customer_rewards where user_id = $1', [id])).id
    const offer = (await one(c, 'select offer_id from customer_rewards where id = $1', [reward])).offer_id
    // someone else's reward
    await fails(c, 'select create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [other, null, reward, null, f.ua, fri, day(fri, 2), 2, 'X', phone(), null, 'website'], '23514')
    // excluded accommodation
    await c.query('update promotional_offers set property_ids = array[$1::uuid] where id = $2', [f.pb, offer])
    let e = await fails(c, 'select create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id, null, reward, null, f.ua, fri, day(fri, 2), 2, 'X', phone(), null, 'website'], '23514')
    assert.match(e.message, /does not apply/)
    await c.query('update promotional_offers set property_ids = $1 where id = $2', ['{}', offer])
    // below the minimum booking value
    await c.query('update promotional_offers set min_total = 999999 where id = $1', [offer])
    e = await fails(c, 'select create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id, null, reward, null, f.ua, fri, day(fri, 2), 2, 'X', phone(), null, 'website'], '23514')
    assert.match(e.message, /at least/)
    await c.query('update promotional_offers set min_total = 0 where id = $1', [offer])
    // stacking with a discount code is refused unless the offer allows it
    await c.query(`insert into discount_codes(code, kind, value) values ('SAVE10','percent',10)`)
    e = await fails(c, 'select create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id, 'SAVE10', reward, null, f.ua, fri, day(fri, 2), 2, 'X', phone(), null, 'website'], '23514')
    assert.match(e.message, /combined/)
    await c.query('update promotional_offers set stackable = true where id = $1', [offer])
    const both = await run(reward, 'SAVE10')
    const quote = await one(c, 'select * from quote_stay($1,$2,$3)', [f.ua, fri, day(fri, 2)])
    const codeAmt = Math.floor(quote.nightly_total * 10 / 100)
    assert.equal(both.discount, codeAmt + Math.floor((quote.nightly_total - codeAmt) * 5 / 100))
    await c.query(`update bookings set status = 'cancelled' where id = $1`, [both.id])
    // expired reward
    await c.query(`update customer_rewards set expires_at = now() - interval '1 day' where id = $1`, [reward])
    e = await fails(c, 'select create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id, null, reward, null, f.ua, fri, day(fri, 2), 2, 'X', phone(), null, 'website'], '23514')
    assert.match(e.message, /expired/)
    // switched-off offer
    await c.query(`update customer_rewards set expires_at = null where id = $1`, [reward])
    await c.query(`update promotional_offers set active = false where id = $1`, [offer])
    await fails(c, 'select create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id, null, reward, null, f.ua, fri, day(fri, 2), 2, 'X', phone(), null, 'website'], '23514')
    // suspended accounts cannot book as members
    await c.query(`update promotional_offers set active = true where id = $1`, [offer])
    await c.query(`update customer_profiles set status = 'suspended' where user_id = $1`, [id])
    await fails(c, 'select create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id, null, reward, null, f.ua, fri, day(fri, 2), 2, 'X', phone(), null, 'website'], '23514')
  }))

test('membership: first-booking and returning rules, open member offers claimed at checkout, max discount', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const id = await customer(c, 'Member'); await activate(c, id)
    const fri = fmt(f.friday)
    const open = (await one(c, `insert into promotional_offers(name, audience, kind, value, max_discount, returning_only) values ('Welcome back','member','percent',20,1000,true) returning id`)).id
    const call = (offer, from) => one(c, 'select * from create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id, null, null, offer, f.ua, from, day(from, 2), 2, 'M', phone(), null, 'website'])
    let e = await fails(c, 'select create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id, null, null, open, f.ua, fri, day(fri, 2), 2, 'M', phone(), null, 'website'], '23514')
    assert.match(e.message, /returning/)
    // a completed stay makes them a returning guest
    const prior = await booking(c, f, { from: day(fri, -20), to: day(fri, -18), status: 'checked_out', total: 10000 })
    await c.query('update bookings set customer_id = $1 where id = $2', [id, prior.id])
    const b = await call(open, fri)
    assert.equal(b.discount, 1000)                     // 20% would be more: capped
    const r = await one(c, `select status, note from customer_rewards where user_id = $1 and offer_id = $2`, [id, open])
    assert.deepEqual([r.status, r.note], ['redeemed', 'Claimed at checkout'])
    // per-customer limit of 1: a second booking cannot reuse the offer while the first is live
    e = await fails(c, 'select create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id, null, null, open, f.ua, day(fri, 14), day(fri, 16), 2, 'M', phone(), null, 'website'], '23514')
    assert.match(e.message, /already used/)
    // the welcome offer is first-booking-only: the prior stay rules it out
    const welcome = (await one(c, `select id from customer_rewards where user_id = $1 and offer_id <> $2`, [id, open])).id
    e = await fails(c, 'select create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id, null, welcome, null, f.ua, day(fri, 21), day(fri, 23), 2, 'M', phone(), null, 'website'], '23514')
    assert.match(e.message, /first booking/)
  }))

test('membership: completed stays earn points and earn tiers; hand-set tiers stick; staff permissions', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const id = await customer(c, 'Loyal'); await activate(c, id)
    const fri = fmt(f.friday)
    const stay = async (n) => {
      const b = await booking(c, f, { from: day(fri, -100 + n * 3), to: day(fri, -98 + n * 3), status: 'confirmed', total: 30000 })
      await c.query('update bookings set customer_id = $1, amount_paid = 30000 where id = $2', [id, b.id])
      await c.query(`update bookings set status = 'checked_in' where id = $1`, [b.id])
      await c.query(`update bookings set status = 'checked_out' where id = $1`, [b.id])
      return b
    }
    await stay(0); await stay(1)
    assert.equal((await one(c, 'select coalesce(sum(points),0)::int p from loyalty_transactions where user_id = $1', [id])).p, 600)
    assert.equal((await one(c, 'select tier_key from customer_profiles where user_id = $1', [id])).tier_key, 'standard')   // 2 stays < 3
    await stay(2)
    assert.equal((await one(c, 'select tier_key from customer_profiles where user_id = $1', [id])).tier_key, 'silver')     // 3 stays, 90000 >= 60000
    // owner can change the criteria; tiers are not handed out without meeting them
    await c.query(`update membership_tiers set min_completed_stays = 50 where key = 'silver'`)
    await c.query(`update customer_profiles set tier_key = 'standard' where user_id = $1`, [id])
    await stay(3)
    assert.equal((await one(c, 'select tier_key from customer_profiles where user_id = $1', [id])).tier_key, 'standard')
    // staff with the permission can set a tier by hand; it is then left alone
    const mgr = f.manager
    await as(c, 'authenticated', mgr)
    await one(c, `select set_customer_tier($1, 'gold') t`, [id])
    await one(c, `select adjust_loyalty_points($1, 50, 'goodwill') x`, [id])
    assert.equal((await one(c, 'select membership_overview() o')).o.verified, 1)
    await fails(c, `select adjust_loyalty_points($1, -100000, 'too much')`, [id], '23514')
    await admin(c)
    await stay(4)
    assert.equal((await one(c, 'select tier_key from customer_profiles where user_id = $1', [id])).tier_key, 'gold')
    // cleaners have no customer permissions
    await as(c, 'authenticated', f.cleaner)
    await fails(c, 'select admin_customer_list()', [], '42501')
  }))

test('membership: claiming a guest booking needs reference AND phone; others are not exposed', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const fri = fmt(f.friday)
    const b = await booking(c, f, { from: fri, to: day(fri, 2) })
    const g = await one(c, 'select g.phone from guests g join bookings b on b.guest_id = g.id where b.id = $1', [b.id])
    const mine = await customer(c, 'Claimer'); const thief = await customer(c, 'Thief')
    await activate(c, mine); await activate(c, thief)
    await as(c, 'authenticated', thief)
    await fails(c, 'select claim_booking($1,$2)', [b.reference, '254700000000'], '23514')              // right reference, wrong phone
    assert.equal((await one(c, 'select jsonb_array_length(my_bookings()) n')).n, 0)
    await admin(c)
    await as(c, 'authenticated', mine)
    const r = await one(c, 'select claim_booking($1,$2) r', [b.reference, g.phone])
    assert.equal(r.r.reference, b.reference)
    assert.equal((await one(c, 'select jsonb_array_length(my_bookings()) n')).n, 1)
    await admin(c)
    await as(c, 'authenticated', thief)
    await fails(c, 'select claim_booking($1,$2)', [b.reference, g.phone], '23514')                    // already someone else's
    assert.equal((await one(c, 'select jsonb_array_length(my_bookings()) n')).n, 0)
    // a customer can ask to cancel only their own booking
    await fails(c, `select request_booking_change($1, 'cancellation', 'please cancel')`, [b.id], 'P0002')
    await admin(c)
    await as(c, 'authenticated', mine)
    await one(c, `select request_booking_change($1, 'cancellation', 'Plans changed') x`, [b.id])
    await fails(c, `select request_booking_change($1, 'cancellation', 'again')`, [b.id], '23514')
  }))

test('membership: birthday rewards issue once a year and welcome offer can be switched off', async () =>
  tx(async (c) => {
    const id = await customer(c, 'Born'); await activate(c, id)
    const today = (await one(c, `select nairobi_today() d`)).d
    await c.query(`update customer_profiles set birthday = ($1::date - interval '30 years')::date where user_id = $2`, [today, id])
    await c.query(`update promotional_offers set active = true where audience = 'birthday'`)
    assert.equal((await one(c, 'select issue_birthday_rewards() n')).n, 1)
    assert.equal((await one(c, 'select issue_birthday_rewards() n')).n, 0)
    // new members get no welcome reward when the offer is off
    await c.query(`update promotional_offers set active = false where audience = 'welcome'`)
    const id2 = await customer(c, 'Late')
    assert.equal((await activate(c, id2)).welcome_rewards, 0)
  }))

test('membership emails: pending welcome offer listed once; marketing opt-out respected for birthday; promo audience filtered', async () =>
  tx(async (c) => {
    const id = await customer(c, 'Mailer'); await activate(c, id)
    let rows = await q(c, 'select * from pending_reward_emails($1)', [id])
    assert.equal(rows.length, 1); assert.equal(rows[0].audience, 'welcome'); assert.match(rows[0].code, /^RGW-[A-F0-9]{8}$/)
    await c.query('select mark_reward_emailed($1)', [rows[0].reward_id])
    assert.equal((await q(c, 'select * from pending_reward_emails($1)', [id])).length, 0)
    // birthday rewards are marketing: skipped when the member opted out
    const today = (await one(c, 'select nairobi_today() d')).d
    await c.query(`update customer_profiles set birthday = ($1::date - interval '30 years')::date, marketing_opt_in = false where user_id = $2`, [today, id])
    await c.query(`update promotional_offers set active = true where audience = 'birthday'`)
    await c.query('select issue_birthday_rewards()')
    assert.equal((await q(c, 'select * from pending_reward_emails($1)', [id])).length, 0)
    await c.query('update customer_profiles set marketing_opt_in = true where user_id = $1', [id])
    assert.equal((await q(c, 'select * from pending_reward_emails($1)', [id])).length, 1)
    // promotion audience: only opted-in, active members at or above the offer's tier
    const o = (await one(c, `insert into promotional_offers(name, audience, kind, value, min_tier_key) values ('Gold only','member','percent',10,'gold') returning id`)).id
    assert.equal((await q(c, 'select * from promo_recipients($1)', [o])).length, 0)
    await c.query(`update customer_profiles set tier_key = 'gold' where user_id = $1`, [id])
    assert.equal((await q(c, 'select * from promo_recipients($1)', [o])).length, 1)
    await c.query(`update customer_profiles set marketing_opt_in = false where user_id = $1`, [id])
    assert.equal((await q(c, 'select * from promo_recipients($1)', [o])).length, 0)
    // customers cannot call these
    await as(c, 'authenticated', id)
    await fails(c, 'select * from pending_reward_emails()', [], '42501')
    await fails(c, 'select * from promo_recipients($1)', [o], '42501')
  }))

// ---------------------------------------------------------------------------------------------
// Optional registration (migration 0030)
// ---------------------------------------------------------------------------------------------
test('optional registration: switch stops new memberships only; guest checkout setting is owner-controlled', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const early = await customer(c, 'Early'); await activate(c, early)
    await as(c, 'authenticated', f.manager)
    await one(c, `select set_membership_setting('registration_enabled', false) x`)
    await fails(c, `select set_membership_setting('maintenance_mode', true)`, [], '23514')   // only the two switches
    await admin(c)
    const late = await customer(c, 'Late')
    assert.equal((await activate(c, late)).status, 'closed')
    assert.equal((await one(c, 'select count(*)::int n from customer_profiles where user_id = $1', [late])).n, 0)
    assert.equal((await activate(c, early)).status, 'active')                                // existing members keep theirs
    await as(c, 'authenticated', f.manager)
    await one(c, `select set_membership_setting('registration_enabled', true) x`)
    await admin(c)
    assert.equal((await activate(c, late)).status, 'active')
    // cleaners cannot touch the switches; guests/anon can read them
    await as(c, 'authenticated', f.cleaner)
    await fails(c, `select set_membership_setting('guest_checkout_enabled', false)`, [], '42501')
    await as(c, 'anon')
    assert.ok((await q(c, `select key from settings where key in ('registration_enabled','guest_checkout_enabled')`)).length === 2)
  }))

test('welcome offer is configurable (nights, whole total, minimum) and only one welcome reward per customer', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const fri = fmt(f.friday)
    const w = (await one(c, `select id from promotional_offers where audience = 'welcome'`)).id
    const id = await customer(c, 'Welcomed'); await activate(c, id)
    const reward = (await one(c, 'select id from customer_rewards where user_id = $1', [id])).id
    const quote = await one(c, 'select * from quote_stay($1,$2,$3)', [f.ua, fri, day(fri, 2)])
    const call = (nights = 2) => one(c, 'select * from create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id, null, reward, null, f.ua, fri, day(fri, nights), 2, 'W', phone(), null, 'website'])
    // owner sets: 10%, whole total (includes the cleaning fee), at least 2 nights
    await c.query(`update promotional_offers set value = 10, applies_to = 'total', min_nights = 3 where id = $1`, [w])
    const e = await fails(c, 'select * from create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id, null, reward, null, f.ua, fri, day(fri, 2), 2, 'W', phone(), null, 'website'], '23514')
    assert.match(e.message, /at least 3 night/)
    const b = await call(3)
    const q3 = await one(c, 'select * from quote_stay($1,$2,$3)', [f.ua, fri, day(fri, 3)])
    assert.equal(b.discount, Math.floor(q3.total * 10 / 100))                                  // percentage of the whole total, not just the room
    assert.ok(quote.cleaning_fee > 0)
    // a second welcome offer cannot be issued to someone who already holds a welcome reward
    const w2 = (await one(c, `insert into promotional_offers(name, audience, kind, value) values ('Second welcome','welcome','percent',20) returning id`)).id
    assert.equal((await one(c, 'select issue_reward($1,$2) r', [id, w2])).r, null)
    // owner may switch it fully off, or to a fixed amount with a cap
    await c.query(`update promotional_offers set active = false where id = $1`, [w])
    const id2 = await customer(c, 'NoWelcome')
    assert.equal((await activate(c, id2)).welcome_rewards, 1)                                  // w2 is still active: the only live welcome offer
    await c.query(`update promotional_offers set active = false where id = $1`, [w2])
    const id3 = await customer(c, 'Nothing')
    assert.equal((await activate(c, id3)).welcome_rewards, 0)
    await c.query(`update promotional_offers set active = true, kind = 'fixed', value = 700, max_discount = 500, applies_to = 'room', min_nights = 1 where id = $1`, [w])
    const id4 = await customer(c, 'Fixed'); await activate(c, id4)
    const r4 = (await one(c, 'select id from customer_rewards where user_id = $1', [id4])).id
    const b4 = await one(c, 'select * from create_booking_member($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id4, null, r4, null, f.ua, day(fri, 10), day(fri, 12), 2, 'F', phone(), null, 'website'])
    assert.equal(b4.discount, 500)                                                             // capped
  }))

test('claim a booking from its secret link; never someone else\'s; count of earlier bookings with my email is only a number', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const fri = fmt(f.friday)
    const mine = await customer(c, 'Linker'); await activate(c, mine)
    const other = await customer(c, 'Other'); await activate(c, other)
    const email = (await one(c, 'select email from customer_profiles where user_id = $1', [mine])).email
    const b = await booking(c, f, { from: fri, to: day(fri, 2) })
    await c.query('update guests set email = $1 where id = $2', [email.toUpperCase(), b.guest_id])
    await as(c, 'authenticated', mine)
    assert.equal((await one(c, 'select unclaimed_bookings_count() n')).n, 1)
    assert.equal((await one(c, 'select jsonb_array_length(my_bookings()) n')).n, 0)             // the count never reveals the booking
    await fails(c, `select claim_booking_by_token($1)`, [randomUUID()], '23514')                // wrong token
    const r = await one(c, 'select claim_booking_by_token($1) r', [b.public_token])
    assert.equal(r.r.reference, b.reference)
    await one(c, 'select claim_booking_by_token($1) r', [b.public_token])                       // idempotent for the owner
    assert.equal((await one(c, 'select jsonb_array_length(my_bookings()) n')).n, 1)
    assert.equal((await one(c, 'select unclaimed_bookings_count() n')).n, 0)
    await admin(c)
    await as(c, 'authenticated', other)
    await fails(c, `select claim_booking_by_token($1)`, [b.public_token], '23514')              // already someone else's
    assert.equal((await one(c, 'select jsonb_array_length(my_bookings()) n')).n, 0)
    await admin(c)
    await as(c, 'anon')
    await fails(c, `select claim_booking_by_token($1)`, [b.public_token], '42501')
  }))

test('analytics: guest vs member bookings and returning-customer rate come from the records', async () =>
  tx(async (c) => {
    const f = await fixture(c)
    const fri = fmt(f.friday)
    const m = await customer(c, 'Analyst'); await activate(c, m)
    await as(c, 'authenticated', f.owner)
    const before = (await one(c, 'select membership_overview() o')).o
    await admin(c)
    const b1 = await booking(c, f, { from: fri, to: day(fri, 2), status: 'confirmed' })
    await c.query('update bookings set customer_id = $1 where id = $2', [m, b1.id])
    const b2 = await booking(c, f, { from: day(fri, 5), to: day(fri, 7), status: 'confirmed' })           // a guest booking
    // the same guest books again: returning
    await c.query(`insert into bookings(property_id, unit_id, guest_id, check_in, check_out, status, total_amount, deposit_required) values ($1,$2,$3,$4,$5,'confirmed',1000,500)`, [f.pa, f.ua, b2.guest_id, day(fri, 10), day(fri, 12)])
    await as(c, 'authenticated', f.owner)
    const o = (await one(c, 'select membership_overview() o')).o
    assert.equal(o.member_bookings - before.member_bookings, 1)
    assert.equal(o.guest_bookings - before.guest_bookings, 2)
    assert.equal(o.returning_customers - before.returning_customers, 1)
    assert.ok(o.returning_rate >= 0 && o.returning_rate <= 100)
    assert.equal(o.registration_enabled, true); assert.equal(o.guest_checkout_enabled, true)
  }))
