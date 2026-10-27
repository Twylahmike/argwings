import { corsHeaders } from './cors.ts'
import { makeLogger, type Logger } from './log.ts'

declare const Deno: { env: { get(k: string): string | undefined } }

/** Thrown by handlers to produce a structured error response: { error: { code, message } }. */
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
  })
}

/**
 * Wraps a handler: CORS preflight, correlation-id logging, structured errors.
 * Unexpected errors are logged server-side and returned as a generic 500 (no stack traces to clients).
 */
export function serve(name: string, handler: (req: Request, log: Logger) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) })
    const log = makeLogger(name)
    try {
      return await handler(req, log)
    } catch (e) {
      if (e instanceof HttpError) {
        log.warn('request rejected', { status: e.status, code: e.code, message: e.message })
        return json(req, { error: { code: e.code, message: e.message } }, e.status)
      }
      log.error('unhandled error', { message: e instanceof Error ? e.message : String(e) })
      return json(req, { error: { code: 'internal_error', message: 'Something went wrong. Please try again.' } }, 500)
    }
  }
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body must be valid JSON.')
  }
}

/** Constant-time string comparison (callback secrets, verify tokens). */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export function clientIp(req: Request): string {
  return (req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim()
}

/** Cron / internal callers must present the service-role key (verify_jwt alone would also admit the public anon key). */
export function requireServiceRole(req: Request): void {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!key || !safeEqual(token, key)) throw new HttpError(401, 'unauthorized', 'This endpoint is for scheduled jobs only.')
}
