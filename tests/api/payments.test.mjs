// API integration tests against a running local stack (`supabase start` + `npm run dev:functions` or
// `supabase functions serve`, MPESA_ENV=mock). Covers the money paths: idempotent callbacks, amount verification,
// late payments, reconcile, failure demo, rate limits and the double-booking race.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { config } from 'dotenv'

config({ quiet: true })
const FN = process.env.FUNCTIONS_URL || process.env.VITE_FUNCTIONS_URL || `${process.env.VITE_SUPABASE_URL}/functions/v1`
const ANON = process.env.VITE_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
const SECRET = process.env.MPESA_CALLBACK_SECRET || 'local-dev-callback-secret-0123456789abcdef'
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
after(() => db.end())

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = async (sql, p) => (await db.query(sql, p)).rows
const one = async (sql, p) => (await q(sql, p))[0]
// Each call pretends to come from a different client so the per-IP throttle does not interfere with unrelated tests.
const fakeIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`
async function call(name, body, key = ANON) {
  const res = await fetch(`${FN}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${key}`, 'x-forwarded-for': fakeIp() }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}
const callback = (checkout, code, amount, receipt) =>
  fetch(`${FN}/mpesa-callback?token=${SECRET}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: checkout, ResultCode: code, ResultDesc: code === 0 ? 'ok' : 'fail',
      ...(code === 0 ? { CallbackMetadata: { Item: [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: receipt }] } } : {}) } } }),
  }).then((r) => r.json())

let dayOffset = 400 + Math.floor(Math.random() * 300) // far future, random so reruns do not collide
async function freshUnit() {
  const u = await one(`select u.id from units u join properties p on p.id=u.property_id where u.code='R2' limit 1`)
  return u.id
}
function nextDates(nights = 2) {
  const d = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
  const out = { in: d(dayOffset), out: d(dayOffset + nights) }
  dayOffset += nights + 3
  return out
}
async function newBooking(extra = {}) {
  const unit = await freshUnit()
  const dates = nextDates()
  const phone = '07' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0')
  const r = await call('create-booking', { unit_id: unit, check_in: dates.in, check_out: dates.out, guests: 2, name: 'API Test', phone, consent: true, ...extra })
  assert.equal(r.status, 201, JSON.stringify(r.json))
  return { ...r.json.booking, unit, dates, phone }
}
const bookingRow = (id) => one('select status, amount_paid, payment_review, review_reason from bookings where id=$1', [id])

test('happy path: hold -> STK -> callback -> confirmed; replayed callback never double-credits', async () => {
  const b = await newBooking()
  assert.equal(b.status, 'pending')
  const push = await call('mpesa-stk-push', { token: b.public_token, phone: '0712345678', amount: b.deposit_required, kind: 'deposit' })
  assert.equal(push.status, 201, JSON.stringify(push.json))
  await sleep(6500) // mock self-callback fires after ~4s
  const row = await bookingRow(b.id)
  assert.deepEqual([row.status, row.amount_paid], ['confirmed', b.deposit_required])
  const pay = await one(`select * from payments where booking_id=$1`, [b.id])
  assert.equal(pay.status, 'succeeded')
  assert.match(pay.mpesa_receipt, /^MOCK/)
  for (let i = 0; i < 3; i++) await callback(pay.checkout_request_id, 0, b.deposit_required, pay.mpesa_receipt)
  assert.equal((await bookingRow(b.id)).amount_paid, b.deposit_required, 'replay must not credit twice')
  assert.equal((await one(`select count(*)::int n from payments where booking_id=$1 and status='succeeded'`, [b.id])).n, 1)
  // messages were attempted and logged, and a disabled WhatsApp did not break anything
  const logs = await q(`select template, status from message_log where booking_id=$1 order by created_at`, [b.id])
  assert.ok(logs.some((l) => l.template === 'payment_receipt') && logs.some((l) => l.template === 'booking_confirmed'))
  assert.ok(logs.every((l) => ['skipped', 'sent', 'failed'].includes(l.status)))
  // guests cannot pay more than the balance
  const over = await call('mpesa-stk-push', { token: b.public_token, phone: '0712345678', amount: b.total_amount, kind: 'balance' })
  assert.equal(over.status, 400)
})

test('wrong amount is rejected and flagged for review (money is never silently dropped)', async () => {
  const b = await newBooking()
  const co = 'ws_CO_TEST_' + Math.random().toString(36).slice(2)
  await q(`insert into payments(booking_id,kind,method,status,amount,checkout_request_id) values ($1,'deposit','mpesa_stk','pending',$2,$3)`, [b.id, b.deposit_required, co])
  await callback(co, 0, b.deposit_required - 1000, 'WRONGAMT1')
  const pay = await one(`select status, result_desc from payments where checkout_request_id=$1`, [co])
  assert.equal(pay.status, 'failed')
  assert.match(pay.result_desc, /AMOUNT_MISMATCH/)
  const row = await bookingRow(b.id)
  assert.equal(row.amount_paid, 0)
  assert.equal(row.status, 'pending')
  assert.equal(row.payment_review, true)
  assert.match(row.review_reason, /M-Pesa reported/)
})

test('unknown checkout ids are acknowledged and kept for review; bad secret is rejected', async () => {
  const ack = await callback('ws_CO_DOES_NOT_EXIST', 0, 100, 'ORPHAN1')
  assert.deepEqual(ack, { ResultCode: 0, ResultDesc: 'Accepted' })
  assert.ok(await one(`select id from audit_log where action='mpesa.orphan_callback' and entity_id='ws_CO_DOES_NOT_EXIST'`))
  const bad = await fetch(`${FN}/mpesa-callback?token=wrong`, { method: 'POST', body: '{}' })
  assert.equal(bad.status, 401)
})

test('mock failure demo: amounts ending in 13 fail with a clear result', async () => {
  const b = await newBooking()
  await q(`insert into payments(booking_id,kind,method,status,amount,confirmed_at,mpesa_receipt) values ($1,'deposit','cash','succeeded',$2,now(),null)`, [b.id, b.deposit_required])
  const push = await call('mpesa-stk-push', { token: b.public_token, phone: '0712345678', amount: 113, kind: 'balance' })
  assert.equal(push.status, 201, JSON.stringify(push.json))
  await sleep(6500)
  const pay = await one(`select status, result_code from payments where id=$1`, [push.json.payment_id])
  assert.deepEqual([pay.status, pay.result_code], ['failed', 2001])
  assert.equal((await bookingRow(b.id)).amount_paid, b.deposit_required)
})

test('reconcile settles missed callbacks and times out stale pushes', async () => {
  const b = await newBooking()
  const ok = 'ws_CO_MOCKOK_' + Math.random().toString(36).slice(2), stale = 'ws_CO_MOCKOK_' + Math.random().toString(36).slice(2)
  await q(`insert into payments(booking_id,kind,method,status,amount,checkout_request_id,created_at) values ($1,'deposit','mpesa_stk','pending',$2,$3, now() - interval '3 minutes')`, [b.id, b.deposit_required, ok])
  await q(`insert into payments(booking_id,kind,method,status,amount,checkout_request_id,created_at) values ($1,'balance','mpesa_stk','pending',500,$2, now() - interval '20 minutes')`, [b.id, stale])
  const denied = await call('mpesa-reconcile', {}, ANON)
  assert.equal(denied.status, 401, 'the public anon key must not be able to run cron jobs')
  const r = await call('mpesa-reconcile', {}, SERVICE)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal((await one(`select status from payments where checkout_request_id=$1`, [ok])).status, 'succeeded')
  assert.equal((await one(`select status, result_code from payments where checkout_request_id=$1`, [stale])).status, 'failed')
  assert.equal((await bookingRow(b.id)).status, 'confirmed')
})

test('late payment on an expired hold: re-activates when free, flags review when the dates were taken', async () => {
  const b1 = await newBooking()
  await q(`update bookings set hold_expires_at = now() - interval '1 minute' where id=$1`, [b1.id])
  await q(`select expire_stale_holds()`)
  assert.equal((await bookingRow(b1.id)).status, 'expired')
  const co1 = 'ws_CO_TEST_' + Math.random().toString(36).slice(2)
  await q(`insert into payments(booking_id,kind,method,status,amount,checkout_request_id) values ($1,'deposit','mpesa_stk','pending',$2,$3)`, [b1.id, b1.deposit_required, co1])
  await callback(co1, 0, b1.deposit_required, 'LATEOK' + Math.random().toString(36).slice(2, 8).toUpperCase())
  assert.equal((await bookingRow(b1.id)).status, 'confirmed')

  const b2 = await newBooking()
  await q(`update bookings set hold_expires_at = now() - interval '1 minute' where id=$1`, [b2.id])
  await q(`select expire_stale_holds()`)
  const taken = await call('create-booking', { unit_id: b2.unit, check_in: b2.check_in, check_out: b2.check_out, guests: 2, name: 'Fast Guest', phone: '0733000999', consent: true })
  assert.equal(taken.status, 201, 'expired hold frees the dates for the next guest')
  const co2 = 'ws_CO_TEST_' + Math.random().toString(36).slice(2)
  await q(`insert into payments(booking_id,kind,method,status,amount,checkout_request_id) values ($1,'deposit','mpesa_stk','pending',$2,$3)`, [b2.id, b2.deposit_required, co2])
  await callback(co2, 0, b2.deposit_required, 'LATEBAD' + Math.random().toString(36).slice(2, 6).toUpperCase())
  const row = await bookingRow(b2.id)
  assert.equal(row.status, 'expired')
  assert.equal(row.payment_review, true)
  assert.equal(row.amount_paid, b2.deposit_required, 'recorded, never dropped')
})

test('race: two guests, same dates => exactly one booking succeeds', async () => {
  const unit = await freshUnit()
  const dates = nextDates(3)
  const attempt = (n) => call('create-booking', { unit_id: unit, check_in: dates.in, check_out: dates.out, guests: 2, name: 'Racer ' + n, phone: '07' + String(40000000 + n * 1111), consent: true })
  const results = await Promise.all([attempt(1), attempt(2), attempt(3), attempt(4)])
  const statuses = results.map((r) => r.status).sort()
  assert.deepEqual(statuses, [201, 409, 409, 409])
  const loser = results.find((r) => r.status === 409)
  assert.equal(loser.json.error.code, 'dates_taken')
})

test('push throttling and validation', async () => {
  const b = await newBooking()
  const bad = await call('mpesa-stk-push', { token: b.public_token, phone: '12345', amount: b.deposit_required, kind: 'deposit' })
  assert.equal(bad.status, 400)
  const wrongDeposit = await call('mpesa-stk-push', { token: b.public_token, phone: '0712345678', amount: 100, kind: 'deposit' })
  assert.equal(wrongDeposit.status, 400, 'guests must pay the full deposit')
  const noConsent = await call('create-booking', { unit_id: b.unit, check_in: '2031-01-01', check_out: '2031-01-03', guests: 2, name: 'No Consent', phone: '0712000111' })
  assert.equal(noConsent.status, 400)
  // 3 pushes per 10 minutes
  for (let i = 0; i < 3; i++) {
    await q(`update payments set status='failed' where booking_id=$1 and status='pending'`, [b.id])
    const r = await call('mpesa-stk-push', { token: b.public_token, phone: '0712345678', amount: b.deposit_required, kind: 'deposit' })
    assert.equal(r.status, 201, `push ${i + 1}: ${JSON.stringify(r.json)}`)
    await q(`update payments set status='failed' where booking_id=$1 and status='pending'`, [b.id])
  }
  const fourth = await call('mpesa-stk-push', { token: b.public_token, phone: '0712345678', amount: b.deposit_required, kind: 'deposit' })
  assert.equal(fourth.status, 429)
})
