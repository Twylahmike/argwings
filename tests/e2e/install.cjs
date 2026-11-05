/* eslint-disable no-undef, @typescript-eslint/no-require-imports */
// Browser acceptance test for the install invitation. Run: npm run build && npx vite preview --port 4173 & node tests/e2e/install.cjs
// Uses headless Chromium and simulates the browser events (beforeinstallprompt / appinstalled / display-mode) and user agents.
// It cannot prove a real Android/iOS install; it proves OUR logic reacts correctly to each signal.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const BASE = process.env.BASE || 'http://localhost:4173'
const UA = {
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
}
let n = 0
const ok = (m) => console.log(`  ok ${++n} ${m}`)

async function ctxFor(browser, ua, extra = {}) {
  const ctx = await browser.newContext({ userAgent: ua, viewport: extra.viewport ?? { width: 1280, height: 800 }, hasTouch: !!extra.touch })
  if (extra.standalone) await ctx.addInitScript(() => { const mm = window.matchMedia.bind(window); window.matchMedia = (q) => (/display-mode: standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q)) })
  return ctx
}
// A fake browser install prompt. `answer` is what the visitor picks in the browser's own dialog.
const fireBIP = (page, answer) => page.evaluate((answer) => {
  const e = new Event('beforeinstallprompt', { cancelable: true })
  window.__prompted = 0
  e.prompt = async () => { window.__prompted++ }
  e.userChoice = Promise.resolve({ outcome: answer })
  window.dispatchEvent(e)
}, answer)
const dialog = (page) => page.locator('[role=dialog]')
const visit = async (page, path = '/') => { await page.goto(BASE + path); await page.waitForTimeout(300) }

;(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
  console.log('Android Chrome / desktop Edge: native prompt')
  for (const [label, ua, touch, vp] of [['android', UA.android, true, { width: 390, height: 844 }], ['desktop', UA.desktop, false, { width: 1280, height: 800 }]]) {
    const ctx = await ctxFor(browser, ua, { touch, viewport: vp }); const page = await ctx.newPage()
    await visit(page); await fireBIP(page, 'dismissed'); await page.waitForTimeout(1800)
    await dialog(page).waitFor(); ok(`${label}: first visit shows the popup`)
    assert.match(await dialog(page).innerText(), /Take .* With You/); assert.match(await dialog(page).innerText(), /INSTALL APP/i); ok(`${label}: headline and INSTALL APP button`)
    await page.screenshot({ path: `/tmp/claude-0/install-${label}.png` })
    // closing with X: gone for this visit, back on the next, and nothing stored
    await dialog(page).getByRole('button', { name: 'Close' }).click(); await page.waitForTimeout(200)
    assert.equal(await dialog(page).count(), 0); ok(`${label}: X closes it`)
    const keys = await page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage)))
    assert.ok(!keys.some((k) => /dismiss|invite|install|popup/i.test(k)), `no dismissal stored: ${keys}`); ok(`${label}: nothing about dismissal is stored`)
    await visit(page); await fireBIP(page, 'dismissed'); await page.waitForTimeout(1800)
    await dialog(page).waitFor(); ok(`${label}: next visit shows it again`)
    // click outside
    await page.mouse.click(5, 5); await page.waitForTimeout(200)
    assert.equal(await dialog(page).count(), 0); ok(`${label}: clicking outside closes it for now`)
    await visit(page); await fireBIP(page, 'dismissed'); await page.waitForTimeout(1800)
    await dialog(page).waitFor(); ok(`${label}: and it still returns next visit`)
    // declined in the browser's own prompt: popup stays eligible, nothing marked installed
    await dialog(page).getByRole('button', { name: /install app/i }).click(); await page.waitForTimeout(300)
    assert.equal(await page.evaluate(() => window.__prompted), 1); ok(`${label}: INSTALL APP opens the native prompt (called from the click)`)
    assert.match(await dialog(page).innerText(), /cancelled|No problem/i); assert.ok(!/installed/i.test((await dialog(page).innerText()).replace(/install any time|Install app/gi, ''))); ok(`${label}: declined is not shown as installed`)
    assert.equal(await page.evaluate(() => localStorage.getItem('rgw-app-installed')), null); ok(`${label}: declined does not set the installed flag`)
    await visit(page); await fireBIP(page, 'accepted'); await page.waitForTimeout(1800)
    await dialog(page).waitFor(); ok(`${label}: after a decline the invitation returns on the next visit`)
    // accepted: still not "installed" until appinstalled
    await dialog(page).getByRole('button', { name: /install app/i }).click(); await page.waitForTimeout(300)
    assert.match(await dialog(page).innerText(), /Finishing installation/); assert.ok(!/Installed\. Welcome/.test(await dialog(page).innerText())); ok(`${label}: accepting alone does not claim success`)
    assert.equal(await page.evaluate(() => localStorage.getItem('rgw-app-installed')), null)
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled'))); await page.waitForTimeout(300)
    assert.match(await dialog(page).innerText(), /Installed\. Welcome/); assert.equal(await page.evaluate(() => localStorage.getItem('rgw-app-installed')), '1'); ok(`${label}: appinstalled confirms the install`)
    await dialog(page).getByRole('button', { name: 'Continue' }).click()
    await visit(page); await page.waitForTimeout(1800)
    assert.equal(await dialog(page).count(), 0); ok(`${label}: once installed the popup stops (browser offers no prompt any more)`)
    // uninstalled later: the browser offers installation again -> invitation returns and the flag is cleared
    await visit(page); await fireBIP(page, 'dismissed'); await page.waitForTimeout(1800)
    await dialog(page).waitFor(); assert.equal(await page.evaluate(() => localStorage.getItem('rgw-app-installed')), null); ok(`${label}: after an uninstall the invitation is available again`)
    // quiet pages
    for (const p of ['/book?unit=x&in=2030-01-01&out=2030-01-03&guests=1', '/login', '/join']) {
      await visit(page, p); await fireBIP(page, 'dismissed'); await page.waitForTimeout(1800)
      assert.equal(await dialog(page).count(), 0)
    }
    ok(`${label}: never interrupts checkout, sign in or sign up`)
    await ctx.close()
  }
  console.log('Installed app (standalone)')
  { const ctx = await ctxFor(browser, UA.android, { standalone: true, touch: true }); const page = await ctx.newPage()
    await visit(page); await fireBIP(page, 'dismissed'); await page.waitForTimeout(1800)
    assert.equal(await dialog(page).count(), 0); ok('standalone: no popup'); await ctx.close() }
  console.log('Chromium with no install prompt (already installed or not installable)')
  { const ctx = await ctxFor(browser, UA.desktop); const page = await ctx.newPage()
    await visit(page); await page.waitForTimeout(2200); assert.equal(await dialog(page).count(), 0); ok('quiet when the browser offers nothing'); await ctx.close() }
  console.log('iPhone Safari')
  { const ctx = await ctxFor(browser, UA.iphone, { touch: true, viewport: { width: 390, height: 844 } }); const page = await ctx.newPage()
    await visit(page); await page.waitForTimeout(1800); await dialog(page).waitFor(); ok('iOS: popup appears without any browser event')
    await page.screenshot({ path: '/tmp/claude-0/install-ios.png' })
    await dialog(page).getByRole('button', { name: /install app/i }).click(); await page.waitForTimeout(300)
    const t = await dialog(page).innerText(); assert.match(t, /Share/); assert.match(t, /Add to Home Screen/); assert.match(t, /Add/); ok('iOS: INSTALL APP shows the Share > Add to Home Screen > Add steps')
    await page.screenshot({ path: '/tmp/claude-0/install-ios-steps.png' })
    assert.equal(await page.evaluate(() => localStorage.getItem('rgw-app-installed')), null); assert.ok(!/Installed\. Welcome/.test(t)); ok('iOS: reading the steps is not treated as an install')
    await dialog(page).getByRole('button', { name: 'Got it' }).click(); await visit(page); await page.waitForTimeout(1800)
    await dialog(page).waitFor(); ok('iOS: still invited on the next visit'); await ctx.close() }
  { const ctx = await ctxFor(browser, UA.iphone, { touch: true, standalone: true }); const page = await ctx.newPage()
    await visit(page); await page.waitForTimeout(1800); assert.equal(await dialog(page).count(), 0); ok('iOS: opened from the Home Screen (standalone) -> invitation stops'); await ctx.close() }
  console.log('Firefox desktop (cannot install)')
  { const ctx = await ctxFor(browser, UA.firefox); const page = await ctx.newPage()
    await visit(page); await page.waitForTimeout(1800); await dialog(page).waitFor()
    const t = await dialog(page).innerText(); assert.match(t, /cannot install apps directly/); assert.equal(await dialog(page).getByRole('button', { name: /install app/i }).count(), 0); ok('unsupported browser: instructions, no broken button'); await ctx.close() }
  await browser.close()
  console.log(`\n${n} checks passed`)
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
