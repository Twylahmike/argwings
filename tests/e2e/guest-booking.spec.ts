import { expect, test } from '@playwright/test'
import { freshDates, open, randomPhone, searchAndBook } from './helpers'

test('guest searches, books, pays the deposit by (mock) M-Pesa, sees confirmation and receipt', async ({ page }) => {
  const dates = freshDates(2)
  await searchAndBook(page, dates)
  await expect(page.getByText('Nothing free')).toHaveCount(0)
  // Cheapest result first: open its checkout
  const book = page.getByRole('link', { name: 'Book', exact: true }).first()
  await expect(book).toBeVisible()
  await book.click()
  await expect(page.getByRole('heading', { name: 'Complete your booking' })).toBeVisible()
  await page.getByLabel('Full name').fill('E2E Guest')
  await page.getByLabel('M-Pesa phone number').fill(randomPhone())
  await page.getByLabel(/I agree/).check()
  await page.getByRole('button', { name: /deposit with M-Pesa/ }).click()

  // The booking page asks the phone for the PIN, then flips to confirmed by itself.
  await expect(page).toHaveURL(/\/booking\//)
  await expect(page.getByText('Check your phone')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Payment received.')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/BNB-\d{4}-\d{4}/).first()).toBeVisible()

  const receipt = page.getByRole('link', { name: /Receipt/ }).first()
  await expect(receipt).toBeVisible()
  const popup = page.waitForEvent('popup')
  await receipt.click()
  const r = await popup
  await expect(r.getByText('Payment receipt')).toBeVisible()
  await expect(r.getByText(/MOCK[A-Z0-9]{6}/)).toBeVisible()
  await expect(r.getByRole('button', { name: /Print/ })).toBeVisible()
})

test('Book on WhatsApp opens a prefilled wa.me message', async ({ page }) => {
  const dates = freshDates(2)
  await open(page, `/properties/kilimani-nest?in=${dates.checkIn}&out=${dates.checkOut}&guests=2`)
  await page.getByRole('button', { name: 'Check dates & price' }).first().click()
  await expect(page.getByText('Total', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Book on WhatsApp' }).click()
  const popup = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Continue on WhatsApp' }).click()
  const wa = await popup
  // wa.me redirects to api.whatsapp.com/send?phone=...&text=... (spaces become +)
  const text = decodeURIComponent((wa.url().split('text=')[1] ?? '').split('&')[0].replace(/\+/g, ' '))
  expect(wa.url()).toMatch(/(wa\.me\/|phone=)2547/)
  expect(text).toContain('Property: Kilimani Nest')
  expect(text).toContain('Guests: 2')
  expect(text).toMatch(/Quoted price: KES [\d,]+/)
})

test('guest checkout rejects an invalid phone number with a clear message', async ({ page }) => {
  const dates = freshDates(2)
  await searchAndBook(page, dates)
  await page.getByRole('link', { name: 'Book', exact: true }).first().click()
  await page.getByLabel('Full name').fill('Bad Phone')
  await page.getByLabel('M-Pesa phone number').fill('12345')
  await page.getByLabel(/I agree/).check()
  await page.getByRole('button', { name: /deposit with M-Pesa/ }).click()
  await expect(page.getByText(/valid Kenyan phone number/)).toBeVisible()
})
