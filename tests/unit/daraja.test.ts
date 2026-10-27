import { describe, expect, it } from 'vitest'
import {
  accountReference, callbackUrl, classifyResult, createProvider, nairobiTimestamp, parseCallback, stkPassword, transactionDesc,
} from '../../supabase/functions/_shared/daraja'

describe('Daraja helpers', () => {
  it('timestamp is Nairobi time (UTC+3), YYYYMMDDHHmmss', () => {
    expect(nairobiTimestamp(new Date('2026-11-03T21:30:05Z'))).toBe('20261104003005')
    expect(nairobiTimestamp(new Date('2026-01-01T00:00:00Z'))).toBe('20260101030000')
    expect(nairobiTimestamp(new Date('2026-12-31T21:00:00Z'))).toBe('20270101000000')
  })
  it('password = base64(shortcode + passkey + timestamp)', () => {
    const pw = stkPassword('174379', 'PASSKEY', '20261104003005')
    expect(pw).toBe(btoa('174379PASSKEY20261104003005'))
    expect(atob(pw)).toBe('174379PASSKEY20261104003005')
  })
  it('respects Daraja field limits (reference 12 chars, description 13 chars)', () => {
    expect(accountReference('BNB-2611-0001')).toBe('NB-2611-0001')
    expect(accountReference('BNB 26/11')).toBe('BNB2611')
    expect(accountReference('!!!')).toBe('BOOKING')
    expect(transactionDesc('Booking deposit payment')).toHaveLength(13)
  })
  it('builds the callback url with the secret', () => {
    const env = { get: (k: string) => ({ SUPABASE_URL: 'https://abc.supabase.co/', MPESA_CALLBACK_SECRET: 's3cret value' } as Record<string, string>)[k] }
    expect(callbackUrl(env)).toBe('https://abc.supabase.co/functions/v1/mpesa-callback?token=s3cret%20value')
  })
})

describe('parseCallback', () => {
  const success = {
    Body: { stkCallback: {
      MerchantRequestID: '29115-34620561-1', CheckoutRequestID: 'ws_CO_191220191020363925', ResultCode: 0,
      ResultDesc: 'The service request is processed successfully.',
      CallbackMetadata: { Item: [
        { Name: 'Amount', Value: 1 }, { Name: 'MpesaReceiptNumber', Value: 'NLJ7RT61SV' },
        { Name: 'TransactionDate', Value: 20191219102115 }, { Name: 'PhoneNumber', Value: 254708374149 },
      ] },
    } },
  }
  it('reads amount, receipt and phone on success', () => {
    expect(parseCallback(success)).toEqual({
      merchantRequestId: '29115-34620561-1', checkoutRequestId: 'ws_CO_191220191020363925', resultCode: 0,
      resultDesc: 'The service request is processed successfully.', amount: 1, receipt: 'NLJ7RT61SV', phone: '254708374149', transactionDate: '20191219102115',
    })
  })
  it.each([[1032, 'cancelled'], [1037, 'failed'], [1, 'failed'], [2001, 'failed'], [0, 'success']] as const)('classifies %s as %s', (code, expected) => {
    expect(classifyResult(code)).toBe(expected)
    const failure = { Body: { stkCallback: { MerchantRequestID: 'm', CheckoutRequestID: 'c', ResultCode: code, ResultDesc: 'x' } } }
    const p = parseCallback(failure)!
    expect(p.resultCode).toBe(code)
    expect(p.receipt).toBeUndefined()
  })
  it('rejects payloads that are not STK callbacks', () => {
    expect(parseCallback(null)).toBeNull()
    expect(parseCallback({})).toBeNull()
    expect(parseCallback({ Body: {} })).toBeNull()
    expect(parseCallback({ Body: { stkCallback: { ResultCode: 0 } } })).toBeNull()
    expect(parseCallback({ Body: { stkCallback: { CheckoutRequestID: 'x', ResultCode: 'abc' } } })).toBeNull()
  })
})

describe('provider selection', () => {
  const env = (m: string | undefined) => ({ get: (k: string) => (k === 'MPESA_ENV' ? m : undefined) })
  it('defaults to mock and supports sandbox/production', () => {
    expect(createProvider(env(undefined)).name).toBe('mock')
    expect(createProvider(env('mock')).name).toBe('mock')
    expect(createProvider(env('sandbox')).name).toBe('sandbox')
    expect(createProvider(env('PRODUCTION')).name).toBe('production')
  })
  it('fails closed on unknown values (a typo must never fall back to fake payments)', () => {
    expect(() => createProvider(env('prod'))).toThrow(/MPESA_ENV/)
  })
  it('mock query encodes the outcome in the checkout id', async () => {
    const p = createProvider(env('mock'))
    expect((await p.stkQuery('ws_CO_MOCKOK_1')).resultCode).toBe(0)
    expect((await p.stkQuery('ws_CO_MOCKFAIL_1')).resultCode).toBe(2001)
  })
})
