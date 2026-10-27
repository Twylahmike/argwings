import { describe, expect, it } from 'vitest'
import { mpesaFailureMessage } from '../../src/lib/payment-messages'

describe('mpesaFailureMessage', () => {
  it.each([[1032, /cancelled/], [1037, /timed out/], [1, /balance/], [2001, /PIN/], [1001, /Another/]])('code %s', (code, re) => {
    expect(mpesaFailureMessage(code as number)).toMatch(re as RegExp)
  })
  it('falls back to the description, then a generic message', () => {
    expect(mpesaFailureMessage(2, 'DS timeout')).toContain('DS timeout')
    expect(mpesaFailureMessage(null)).toMatch(/did not go through/)
  })
})
