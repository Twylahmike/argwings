import { describe, expect, it, vi } from 'vitest'
import { emailConfigured, isEmail, sendEmail, textToHtml } from '../../supabase/functions/_shared/email'
import { emailSubject } from '../../supabase/functions/_shared/templates'

const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] })
const on = { EMAIL_ENABLED: 'true', RESEND_API_KEY: 're_x', EMAIL_FROM: 'RG Wings <hi@example.com>' }

describe('email', () => {
  it('is skipped unless fully configured', async () => {
    expect(emailConfigured(env({}) as never)).toBe(false)
    expect((await sendEmail('a@b.co', 's', 't', env({ ...on, EMAIL_ENABLED: 'false' }) as never)).status).toBe('skipped')
    expect((await sendEmail('a@b.co', 's', 't', env({ EMAIL_ENABLED: 'true' }) as never)).status).toBe('skipped')
  })
  it('skips invalid addresses', async () => {
    expect(isEmail('nope')).toBe(false)
    expect((await sendEmail('nope', 's', 't', env(on) as never)).status).toBe('skipped')
  })
  it('posts to Resend and returns the id', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'abc' }) })
    vi.stubGlobal('fetch', f)
    const r = await sendEmail('a@b.co', 'Hello', 'Hi\nhttps://x.co', env(on) as never)
    expect(r).toEqual({ status: 'sent', providerId: 'abc' })
    expect(JSON.parse(f.mock.calls[0][1].body).to).toEqual(['a@b.co'])
    vi.unstubAllGlobals()
  })
  it('reports API failures without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({ message: 'bad from' }) }))
    expect(await sendEmail('a@b.co', 's', 't', env(on) as never)).toEqual({ status: 'failed', error: 'bad from' })
    vi.unstubAllGlobals()
  })
  it('escapes html and links urls', () => {
    const h = textToHtml('<b>x</b>\nhttps://a.co/p')
    expect(h).toContain('&lt;b&gt;'); expect(h).toContain('<a href="https://a.co/p"')
  })
  it('has a subject for every template', () => {
    const c = { business: 'B', property: 'P', reference: 'R1' } as never
    expect(emailSubject('booking_confirmed', c)).toContain('R1')
    expect(emailSubject('custom', c)).toContain('B')
  })
})
