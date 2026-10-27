import { expect, test } from '@playwright/test'
import { freshDates, randomPhone, unitId } from './helpers'

test('two browsers race for the same dates: exactly one wins, the other sees "dates just taken"', async ({ browser }) => {
  const dates = freshDates(3)
  const unit = await unitId('R2')
  const url = `/book?unit=${unit}&in=${dates.checkIn}&out=${dates.checkOut}&guests=2`
  const ctxs = await Promise.all([browser.newContext(), browser.newContext()])
  const pages = await Promise.all(ctxs.map((c) => c.newPage()))
  const baseURL = test.info().project.use.baseURL!
  await Promise.all(pages.map((p) => p.goto(baseURL + url)))
  for (const [i, p] of pages.entries()) {
    await p.getByLabel('Full name').fill(`Racer ${i}`)
    await p.getByLabel('M-Pesa phone number').fill(randomPhone())
    await p.getByLabel(/I agree/).check()
  }
  await Promise.all(pages.map((p) => p.getByRole('button', { name: /deposit with M-Pesa/ }).click()))
  await Promise.all(pages.map((p) => expect(p.getByText('Those dates were just taken').or(p.getByText('Check your phone')).first()).toBeVisible({ timeout: 20_000 })))
  const lost = await Promise.all(pages.map((p) => p.getByText('Those dates were just taken. Please choose other dates.').isVisible()))
  expect(lost.filter(Boolean)).toHaveLength(1)
  await Promise.all(ctxs.map((c) => c.close()))
})
