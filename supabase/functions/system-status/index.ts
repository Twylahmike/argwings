// system-status: lets the owner's Settings page show how the server is configured (read-only, set via env).
// Returns modes only, never secrets.
import { json, serve } from '../_shared/http.ts'
import { requireOwner, serviceClient, staffFromRequest } from '../_shared/supabase.ts'
import { whatsappConfigured } from '../_shared/whatsapp.ts'

declare const Deno: { serve(h: (r: Request) => Promise<Response>): void; env: { get(k: string): string | undefined } }

Deno.serve(serve('system-status', async (req) => {
  requireOwner(await staffFromRequest(req, serviceClient()))
  return json(req, {
    mpesa_env: (Deno.env.get('MPESA_ENV') ?? 'mock').toLowerCase(),
    mpesa_callback_secret_set: (Deno.env.get('MPESA_CALLBACK_SECRET') ?? '').length >= 16,
    whatsapp_env_enabled: Deno.env.get('WHATSAPP_ENABLED') === 'true',
    whatsapp_configured: whatsappConfigured(),
    whatsapp_templates: Deno.env.get('WHATSAPP_USE_TEMPLATES') === 'true',
    site_url: Deno.env.get('SITE_URL') ?? '',
  })
}))
