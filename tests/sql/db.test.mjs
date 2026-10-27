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
    assert.ok(settings.every((s) => ['business_name', 'cancellation_policy', 'logo_url', 'support_whatsapp', 'deposit_percent', 'hold_minutes', 'mpesa_manual_instructions', 'mpesa_paybill_display'].includes(s.key)))
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
