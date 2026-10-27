// M-Pesa (Safaricom Daraja) provider behind one interface, so providers are swappable: mock | sandbox | production.
// Pure helpers are exported separately and unit-tested (timestamp, password, callback parsing).
declare const Deno: { env: { get(k: string): string | undefined } }
// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any

export interface PaymentProvider {
  name: 'mock' | 'sandbox' | 'production'
  stkPush(args: { phone: string; amount: number; reference: string; description: string }): Promise<{ merchantRequestId: string; checkoutRequestId: string }>
  /** resultCode: 0 success, -1 still processing, anything else = failed / cancelled */
  stkQuery(checkoutRequestId: string): Promise<{ resultCode: number; resultDesc: string }>
}

export class ProviderError extends Error {}

/* ------------------------------ pure helpers (unit-tested) ------------------------------ */

/** Daraja timestamp YYYYMMDDHHmmss in Africa/Nairobi (UTC+3, no DST). */
export function nairobiTimestamp(now: Date = new Date()): string {
  const t = new Date(now.getTime() + 3 * 3600_000)
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`
}

/** Password = base64(shortcode + passkey + timestamp) */
export function stkPassword(shortcode: string, passkey: string, timestamp: string): string {
  return btoa(`${shortcode}${passkey}${timestamp}`)
}

/** AccountReference max 12 chars, TransactionDesc max 13 chars. */
export const accountReference = (ref: string) => ref.replace(/[^A-Za-z0-9-]/g, '').slice(-12) || 'BOOKING'
export const transactionDesc = (d: string) => d.slice(0, 13) || 'Booking'

export type ParsedCallback = {
  merchantRequestId: string
  checkoutRequestId: string
  resultCode: number
  resultDesc: string
  amount?: number
  receipt?: string
  phone?: string
  transactionDate?: string
}

/** Parses Body.stkCallback. Returns null when the payload is not a Daraja STK callback. */
export function parseCallback(body: unknown): ParsedCallback | null {
  const cb = (body as { Body?: { stkCallback?: Record<string, unknown> } } | null)?.Body?.stkCallback
  if (!cb || typeof cb.CheckoutRequestID !== 'string') return null
  const out: ParsedCallback = {
    merchantRequestId: String(cb.MerchantRequestID ?? ''),
    checkoutRequestId: cb.CheckoutRequestID,
    resultCode: Number(cb.ResultCode),
    resultDesc: String(cb.ResultDesc ?? ''),
  }
  const items = (cb.CallbackMetadata as { Item?: { Name: string; Value?: unknown }[] } | undefined)?.Item
  if (Array.isArray(items)) {
    for (const it of items) {
      if (it.Name === 'Amount') out.amount = Number(it.Value)
      else if (it.Name === 'MpesaReceiptNumber') out.receipt = String(it.Value)
      else if (it.Name === 'PhoneNumber') out.phone = String(it.Value)
      else if (it.Name === 'TransactionDate') out.transactionDate = String(it.Value)
    }
  }
  return Number.isNaN(out.resultCode) ? null : out
}

/** 0 = success; 1032 = user cancelled; everything else = failed. (1037 timeout, 1 insufficient funds, 2001 wrong PIN.) */
export function classifyResult(code: number): 'success' | 'cancelled' | 'failed' {
  if (code === 0) return 'success'
  if (code === 1032) return 'cancelled'
  return 'failed'
}

/* ------------------------------------ providers ------------------------------------ */

type Env = { get(k: string): string | undefined }

export function callbackUrl(env: Env): string {
  const base = (env.get('MPESA_CALLBACK_BASE_URL') ?? env.get('SUPABASE_URL') ?? '').replace(/\/$/, '')
  return `${base}/functions/v1/mpesa-callback?token=${encodeURIComponent(env.get('MPESA_CALLBACK_SECRET') ?? '')}`
}

class DarajaProvider implements PaymentProvider {
  private tokenCache: { token: string; expires: number } | null = null
  constructor(public name: 'sandbox' | 'production', private env: Env) {}

  private base() { return this.name === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke' }
  private need(k: string): string {
    const v = this.env.get(k)
    if (!v) throw new ProviderError(`${k} is not configured`)
    return v
  }

  private async token(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expires > Date.now()) return this.tokenCache.token
    const basic = btoa(`${this.need('MPESA_CONSUMER_KEY')}:${this.need('MPESA_CONSUMER_SECRET')}`)
    const res = await fetch(`${this.base()}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${basic}` } })
    if (!res.ok) throw new ProviderError(`Daraja auth failed (${res.status})`)
    const j = await res.json() as { access_token: string }
    this.tokenCache = { token: j.access_token, expires: Date.now() + 50 * 60_000 } // cached ~50 min
    return j.access_token
  }

  async stkPush(a: { phone: string; amount: number; reference: string; description: string }) {
    const shortcode = this.need('MPESA_SHORTCODE')
    const timestamp = nairobiTimestamp()
    const txn = this.env.get('MPESA_TXN_TYPE') ?? 'CustomerPayBillOnline'
    const partyB = txn === 'CustomerBuyGoodsOnline' ? (this.env.get('MPESA_PARTY_B') || shortcode) : shortcode
    const res = await fetch(`${this.base()}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: stkPassword(shortcode, this.need('MPESA_PASSKEY'), timestamp),
        Timestamp: timestamp,
        TransactionType: txn,
        Amount: Math.round(a.amount),
        PartyA: a.phone,
        PartyB: partyB,
        PhoneNumber: a.phone,
        CallBackURL: callbackUrl(this.env),
        AccountReference: accountReference(a.reference),
        TransactionDesc: transactionDesc(a.description),
      }),
    })
    const j = await res.json().catch(() => ({})) as Record<string, string>
    if (!res.ok || j.ResponseCode !== '0') throw new ProviderError(j.errorMessage ?? j.ResponseDescription ?? `Daraja STK push failed (${res.status})`)
    return { merchantRequestId: j.MerchantRequestID, checkoutRequestId: j.CheckoutRequestID }
  }

  async stkQuery(checkoutRequestId: string) {
    const shortcode = this.need('MPESA_SHORTCODE')
    const timestamp = nairobiTimestamp()
    const res = await fetch(`${this.base()}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: shortcode, Password: stkPassword(shortcode, this.need('MPESA_PASSKEY'), timestamp),
        Timestamp: timestamp, CheckoutRequestID: checkoutRequestId,
      }),
    })
    const j = await res.json().catch(() => ({})) as Record<string, string>
    // While the customer is still deciding Daraja answers 500 "transaction is being processed".
    if (!res.ok || j.errorCode) return { resultCode: -1, resultDesc: j.errorMessage ?? 'Processing' }
    return { resultCode: Number(j.ResultCode), resultDesc: j.ResultDesc ?? '' }
  }
}

/**
 * Mock mode: no credentials needed. stkPush returns fake ids and schedules a callback to our own
 * mpesa-callback ~4 seconds later, exactly like Safaricom would. Amounts ending in 13 fail when
 * MPESA_MOCK_FAIL_ON_13=true so the failure UI can be demoed.
 */
class MockProvider implements PaymentProvider {
  name = 'mock' as const
  constructor(private env: Env) {}

  async stkPush(a: { phone: string; amount: number; reference: string }) {
    const fail = (this.env.get('MPESA_MOCK_FAIL_ON_13') ?? 'true') === 'true' && a.amount % 100 === 13
    const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
    const checkoutRequestId = `ws_CO_MOCK${fail ? 'FAIL' : 'OK'}_${rand}`
    const merchantRequestId = `MOCK-${rand}`
    const payload = fail
      ? { Body: { stkCallback: { MerchantRequestID: merchantRequestId, CheckoutRequestID: checkoutRequestId, ResultCode: 2001, ResultDesc: 'The initiator information is invalid.' } } }
      : {
          Body: { stkCallback: {
            MerchantRequestID: merchantRequestId, CheckoutRequestID: checkoutRequestId, ResultCode: 0, ResultDesc: 'The service request is processed successfully.',
            CallbackMetadata: { Item: [
              { Name: 'Amount', Value: a.amount },
              { Name: 'MpesaReceiptNumber', Value: `MOCK${rand.slice(0, 6).toUpperCase()}` },
              { Name: 'TransactionDate', Value: Number(nairobiTimestamp()) },
              { Name: 'PhoneNumber', Value: Number(a.phone) },
            ] },
          } },
        }
    const send = async () => {
      await new Promise((r) => setTimeout(r, 4000))
      try {
        await fetch(callbackUrl(this.env), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      } catch (e) {
        console.warn('mock callback failed', e instanceof Error ? e.message : e)
      }
    }
    // EdgeRuntime.waitUntil keeps the worker alive after the response is sent.
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(send())
    else void send()
    return { merchantRequestId, checkoutRequestId }
  }

  // Used by mpesa-reconcile when the mock callback never arrived: the id encodes the outcome.
  async stkQuery(checkoutRequestId: string) {
    return checkoutRequestId.includes('MOCKFAIL')
      ? { resultCode: 2001, resultDesc: 'The initiator information is invalid.' }
      : { resultCode: 0, resultDesc: 'The service request is processed successfully.' }
  }
}

export function createProvider(env: Env = Deno.env): PaymentProvider {
  const mode = (env.get('MPESA_ENV') ?? 'mock').toLowerCase()
  if (mode === 'production' || mode === 'sandbox') return new DarajaProvider(mode, env)
  // Fail closed: a typo like "prod" must never silently fall back to fake payments.
  if (mode !== 'mock') throw new ProviderError(`MPESA_ENV must be mock, sandbox or production (got "${mode}")`)
  return new MockProvider(env)
}
