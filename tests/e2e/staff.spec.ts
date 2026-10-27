import { expect, test } from '@playwright/test'
import { db, login, randomPhone } from './helpers'

async function api(name: string, body: unknown) {
  const base = process.env.VITE_FUNCTIONS_URL || `${process.env.VITE_SUPABASE_URL}/functions/v1`
  const r = await fetch(`${base}/${name}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', apikey: process.env.VITE_SUPABASE_ANON_KEY!, Authorization: `Bearer ${process.env.VITE_SUPABASE_ANON_KEY}`, 'x-forwarded-for': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
  })
  return { status: r.status, json: await r.json() }
}

test('owner: booking on the calendar -> check in -> balance payment -> check out -> cleaner marks clean', async ({ browser, page }) => {
  // Arrange: a confirmed booking arriving today on Deluxe 1 Bedroom (K3, a property the demo cleaner is assigned to), created through the public API.
  const { rows } = await db.query(`select id, nairobi_today()::text as today, (nairobi_today() + 2)::text as out from units where code='K3'`)
  const unit = rows[0]
  await db.query(`delete from bookings where unit_id=$1 and check_in < $2::date + 2 and check_out > $2::date and status in ('pending','confirmed','checked_in','blocked')`, [unit.id, unit.today])
  const name = `Owner Flow ${Date.now().toString().slice(-5)}`
  const created = await api('create-booking', { unit_id: unit.id, check_in: unit.today, check_out: unit.out, guests: 2, name, phone: randomPhone(), consent: true })
  expect(created.status).toBe(201)
  const b = created.json.booking
  await api('mpesa-stk-push', { token: b.public_token, phone: '0712345678', amount: b.deposit_required, kind: 'deposit' })
  await expect.poll(async () => (await db.query('select status from bookings where id=$1', [b.id])).rows[0].status, { timeout: 20_000 }).toBe('confirmed')

  await login(page, 'owner')
  await page.goto('/admin/calendar')
  await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible()

  await page.goto(`/admin/bookings/${b.id}`)
  await page.getByRole('button', { name: 'Check in' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Check in' }).click()
  await expect(page.getByText('Checked in').first()).toBeVisible()

  await page.getByRole('button', { name: 'Record manual payment' }).click()
  await page.getByLabel('Paid by').selectOption('cash')
  await page.getByRole('button', { name: 'Save payment' }).click()
  await expect(page.getByText('Payment recorded')).toBeVisible()
  await expect.poll(async () => (await db.query('select total_amount - amount_paid as bal from bookings where id=$1', [b.id])).rows[0].bal).toBe(0)

  await page.getByRole('button', { name: 'Check out' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Check out' }).click()
  await expect(page.getByText('Checked out').first()).toBeVisible()
  await expect.poll(async () => (await db.query(`select count(*)::int n from housekeeping_tasks where booking_id=$1 and status='dirty'`, [b.id])).rows[0].n).toBe(1)

  // The cleaner sees the new task and works it.
  const ctx = await browser.newContext()
  const cp = await ctx.newPage()
  await login(cp, 'cleaner')
  const card = cp.locator('li', { hasText: 'Deluxe 1 Bedroom' }).first()
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'Start cleaning' }).click()
  await card.getByRole('button', { name: 'Mark clean' }).click()
  await expect.poll(async () => (await db.query(`select status from housekeeping_tasks where booking_id=$1`, [b.id])).rows[0].status).toBe('clean')
  await ctx.close()
})

test('a pending hold expires after the hold window and the dates reopen', async ({ page }) => {
  test.setTimeout(150_000)
  const { rows } = await db.query(`select id from units where code='R1'`)
  const unit = rows[0].id
  const start = 2600 + Math.floor(Math.random() * 300)
  const d = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
  const prev = (await db.query(`select value from settings where key='hold_minutes'`)).rows[0].value
  await db.query(`update settings set value='1' where key='hold_minutes'`) // shortened for the test
  try {
    const r = await api('create-booking', { unit_id: unit, check_in: d(start), check_out: d(start + 2), guests: 2, name: 'Hold Test', phone: randomPhone(), consent: true })
    expect(r.status).toBe(201)
    const avail = async () => (await db.query(`select count(*)::int n from get_available_units($1,$2,2,(select property_id from units where id=$3))`, [d(start), d(start + 2), unit])).rows[0].n
    await page.goto(`/booking/${r.json.booking.public_token}`)
    await expect(page.getByText(/Your dates are held for/)).toBeVisible()
    const held = (await db.query(`select count(*)::int n from get_available_units($1,$2,2,null) where unit_id=$3`, [d(start), d(start + 2), unit])).rows[0].n
    expect(held).toBe(0)
    void avail
    await expect.poll(async () => (await db.query(`select count(*)::int n from get_available_units($1,$2,2,null) where unit_id=$3`, [d(start), d(start + 2), unit])).rows[0].n, { timeout: 100_000, intervals: [5_000] }).toBe(1)
    await expect.poll(async () => (await db.query(`select status from bookings where id=$1`, [r.json.booking.id])).rows[0].status, { timeout: 90_000, intervals: [5_000] }).toBe('expired')
    await page.reload()
    await expect(page.getByText('This hold has expired')).toBeVisible()
  } finally {
    await db.query(`update settings set value=$1 where key='hold_minutes'`, [JSON.stringify(prev)])
  }
})
