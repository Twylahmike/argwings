import { expect, type Page } from '@playwright/test'
import pg from 'pg'
import { config } from 'dotenv'

config({ quiet: true })
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? ''
export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 })

/** A far-future date range that no other test run has used (random block per call). */
export function freshDates(nights = 2) {
  const start = 700 + Math.floor(Math.random() * 1500)
  const d = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)
  return { checkIn: d(start), checkOut: d(start + nights) }
}
export const randomPhone = () => '07' + String(Math.floor(10000000 + Math.random() * 89999999))

export async function login(page: Page, who: 'owner' | 'manager' | 'cleaner') {
  await open(page, '/login')
  await page.getByLabel('Email').fill(`${who}@example.com`)
  await page.getByLabel('Password').fill(DEMO_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(who === 'cleaner' ? /\/admin\/housekeeping/ : /\/admin$/)
}

/** Search for the dates and open checkout for the unit with this code ("R2" etc.). */
/** Navigate and wait for hydration: server-rendered controls do nothing useful before React attaches. */
export async function open(page: Page, url: string) {
  await page.goto(url)
  await page.waitForLoadState('networkidle')
}

export async function searchAndBook(page: Page, dates: { checkIn: string; checkOut: string }, guests = 2) {
  await open(page, '/')
  await page.getByLabel('Check-in').fill(dates.checkIn)
  await page.getByLabel('Check-out').fill(dates.checkOut)
  await page.getByLabel('Guests').selectOption(String(guests))
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page).toHaveURL(/\/search/)
}

export async function unitId(code: string): Promise<string> {
  const { rows } = await db.query('select id from units where code=$1', [code])
  return rows[0].id
}
