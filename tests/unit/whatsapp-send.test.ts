import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendWhatsApp, whatsappConfigured } from '../../supabase/functions/_shared/whatsapp'

const env = (o: Record<string, string>) => ({ get: (k: string) => o[k] })
const on = { WHATSAPP_ENABLED: 'true', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '123' }

afterEach(() => vi.unstubAllGlobals())

describe('sendWhatsApp never throws, so messaging cannot break a booking or payment', () => {
  it('is skipped (not failed) when disabled or unconfigured', async () => {
    expect(await sendWhatsApp('254712345678', 'hi', undefined, env({}))).toMatchObject({ status: 'skipped' })
    expect(await sendWhatsApp('254712345678', 'hi', undefined, env({ ...on, WHATSAPP_ENABLED: 'false' }))).toMatchObject({ status: 'skipped' })
    expect(await sendWhatsApp('254712345678', 'hi', undefined, env({ WHATSAPP_ENABLED: 'true' }))).toMatchObject({ status: 'skipped' })
    expect(whatsappConfigured(env(on))).toBe(true)
  })
  it('reports failed when the network throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    expect(await sendWhatsApp('254712345678', 'hi', undefined, env(on))).toEqual({ status: 'failed', error: 'network down' })
  })
  it('reports failed with the API message on an error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'Recipient not in allowed list' } }) }))
    expect(await sendWhatsApp('254712345678', 'hi', undefined, env(on))).toEqual({ status: 'failed', error: 'Recipient not in allowed list' })
  })
  it('sends a session text message by default and returns the provider id', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) })
    vi.stubGlobal('fetch', f)
    expect(await sendWhatsApp('254712345678', 'hello', { name: 'thank_you', params: ['Ann'] }, env(on))).toEqual({ status: 'sent', providerId: 'wamid.1' })
    const body = JSON.parse(f.mock.calls[0][1].body)
    expect(body).toMatchObject({ to: '254712345678', type: 'text', text: { body: 'hello' } })
    expect(f.mock.calls[0][0]).toContain('/123/messages')
  })
  it('sends the approved template when WHATSAPP_USE_TEMPLATES=true', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.2' }] }) })
    vi.stubGlobal('fetch', f)
    await sendWhatsApp('254712345678', 'hello', { name: 'thank_you', params: ['Ann', 'Nest'] }, env({ ...on, WHATSAPP_USE_TEMPLATES: 'true' }))
    const body = JSON.parse(f.mock.calls[0][1].body)
    expect(body.type).toBe('template')
    expect(body.template.name).toBe('bnb_thank_you')
    expect(body.template.components[0].parameters).toEqual([{ type: 'text', text: 'Ann' }, { type: 'text', text: 'Nest' }])
  })
})
