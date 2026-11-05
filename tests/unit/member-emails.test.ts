import { describe, expect, it } from 'vitest'
import { renderMemberEmail } from '../../supabase/functions/_shared/member-emails'
import { textToHtml } from '../../supabase/functions/_shared/email'

const base = { business: 'RG Wings Stays', name: 'Wanjiru Kamau', site: 'https://rgwings.example', contactPhone: '+254722842508', contactEmail: 'hello@rgwings.example', address: 'Lavington, Nairobi' }
const offer = { name: 'Welcome offer', kind: 'percent' as const, value: 5, code: 'RGW-AB12CD34', expiresAt: '2027-01-10T00:00:00Z', terms: 'One booking only.' }

describe('member emails', () => {
  it('welcome email greets by first name, links the account and carries business contact details', () => {
    const m = renderMemberEmail('welcome', base)
    expect(m.subject).toBe('Welcome to RG Wings Stays')
    expect(m.text).toContain('Hi Wanjiru,')
    expect(m.text).toContain('+254722842508'); expect(m.text).toContain('hello@rgwings.example')
    expect(m.cta?.url).toBe('https://rgwings.example/account')
  })
  it('offer email states the value, code, expiry and terms', () => {
    const m = renderMemberEmail('welcome_offer', { ...base, offer })
    expect(m.text).toContain('5% off'); expect(m.text).toContain('RGW-AB12CD34'); expect(m.text).toContain('One booking only.')
    expect(m.text).toMatch(/Use it by .*2027/)
  })
  it('marketing emails mention how to opt out; transactional ones do not need to', () => {
    expect(renderMemberEmail('birthday', { ...base, offer }).text).toContain('turn these emails off')
    expect(renderMemberEmail('promotion', { ...base, offer }).text).toContain('turn these emails off')
    expect(renderMemberEmail('welcome', base).text).not.toContain('turn these emails off')
  })
  it('branded html uses the business name, escapes text and only links https buttons', () => {
    const h = textToHtml('Hi <b>x</b>', { business: 'RG Wings Stays', cta: { label: 'Open', url: 'https://a.co/account' } })
    expect(h).toContain('RG Wings Stays'); expect(h).toContain('&lt;b&gt;'); expect(h).toContain('href="https://a.co/account"')
    expect(textToHtml('x', { business: 'B', cta: { label: 'Bad', url: 'javascript:alert(1)' } })).not.toContain('javascript:')
  })
})
