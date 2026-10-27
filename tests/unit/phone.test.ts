import { describe, expect, it } from 'vitest'
import { normalizePhone, formatPhoneLocal, maskPhone } from '../../src/lib/phone'
import { normalizePhone as normalizeShared } from '../../supabase/functions/_shared/phone'

describe('normalizePhone', () => {
  it.each([
    ['0712345678', '254712345678'],
    ['0112345678', '254112345678'],
    ['+254712345678', '254712345678'],
    ['254712345678', '254712345678'],
    ['+254 712 345 678', '254712345678'],
    ['0712-345-678', '254712345678'],
    ['(0712) 345.678', '254712345678'],
    ['  0722 000 111 ', '254722000111'],
    ['+254-112-345-678', '254112345678'],
  ])('accepts %s', (input, expected) => {
    expect(normalizePhone(input)).toEqual({ ok: true, phone: expected })
  })

  it.each([
    '', '   ', '712345678', '0212345678', '254212345678', '+255712345678', '07123456', '071234567890',
    'abc', '0712 345 67a', '++254712345678', '254+712345678', '+1 415 555 0100', '0812345678',
  ])('rejects %j with a message', (input) => {
    const r = normalizePhone(input)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.length).toBeGreaterThan(5)
  })

  it('the Deno shared copy behaves identically', () => {
    for (const s of ['0712345678', '+254 112 345 678', '712345678', 'x', '', '254712345678', '0212345678'])
      expect(normalizeShared(s)).toEqual(normalizePhone(s))
  })

  it('formats and masks', () => {
    expect(formatPhoneLocal('254712345678')).toBe('0712 345 678')
    expect(maskPhone('254712345678')).toBe('*********678')
    expect(maskPhone(null)).toBe('')
  })
})
