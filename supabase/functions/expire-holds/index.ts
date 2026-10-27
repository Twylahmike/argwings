// expire-holds: frees unpaid holds. pg_cron calls the SQL function directly every minute; this endpoint exists
// for manual or external triggering (service-role key required).
import { json, requireServiceRole, serve } from '../_shared/http.ts'
import { serviceClient } from '../_shared/supabase.ts'

declare const Deno: { serve(h: (r: Request) => Promise<Response>): void }

Deno.serve(serve('expire-holds', async (req, log) => {
  requireServiceRole(req)
  const { data, error } = await serviceClient().rpc('expire_stale_holds')
  if (error) throw error
  log.info('holds expired', { count: data })
  return json(req, { expired: data })
}))
