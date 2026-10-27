import { expect, test } from '@playwright/test'
import { login } from './helpers'

test('cleaner is kept out of finance and every other admin page', async ({ page }) => {
  await login(page, 'cleaner')
  for (const path of ['/admin/finance', '/admin/bookings', '/admin/settings', '/admin/staff', '/admin']) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/admin\/housekeeping/)
  }
  await expect(page.getByRole('link', { name: 'Finance' })).toHaveCount(0)
})

test('manager cannot open owner-only pages and only sees assigned properties', async ({ page }) => {
  await login(page, 'manager')
  await page.goto('/admin/settings')
  await expect(page).toHaveURL(/\/admin$/)
  await page.goto('/admin/staff')
  await expect(page).toHaveURL(/\/admin$/)
  const options = await page.getByLabel('Filter by property').locator('option').allTextContents()
  expect(options).toContain('Kilimani Nest')
  expect(options).not.toContain('Runda Retreat')
})

test('anonymous visitors are sent to the login page', async ({ page }) => {
  await page.goto('/admin/calendar')
  await expect(page).toHaveURL(/\/login/)
})
