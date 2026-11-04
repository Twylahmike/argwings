// SQL tests: overlap guard, pricing, payments trigger, hold expiry, RLS isolation, finance totals, seed.
// Each test runs inside a transaction that is rolled back, so tests never leak into each other.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
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
    assert.ok(settings.every((s) => ['business_name', 'cancellation_policy', 'logo_url', 'support_whatsapp', 'deposit_percent', 'hold_minutes', 'mpesa_manual_instructions', 'mpesa_paybill_display', 'brand_color', 'site_content', 'booking_mode'].includes(s.key)))
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
    assert.equal((await c.query('delete from expenses where property_id=$1', [f.pa])).rowCount, 1)
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
