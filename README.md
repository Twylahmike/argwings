# BNB Management System

One dashboard for every BNB you run: bookings, a master calendar, M-Pesa payments, guests, housekeeping, finances and WhatsApp messages, plus a public booking site guests can use from their phones.

Built by Twylah Digital. Single owner, KES (whole shillings), Africa/Nairobi time.

| Layer | Tech |
|---|---|
| App | TanStack Start (React, TypeScript strict), TanStack Router + Query, Tailwind CSS v4, Radix, react-hook-form + zod, date-fns, recharts |
| Backend | Supabase: Postgres, Auth, Row Level Security, Storage, Realtime, Edge Functions (Deno), `pg_cron` + `pg_net` |
| Hosting | Cloudflare Workers (Wrangler) |
| Payments | Safaricom Daraja STK push (mock, sandbox and production modes) |
| Messages | WhatsApp Business Cloud API, with a `wa.me` fallback |

## What is where

```
src/routes/          pages (public site + /admin/*)
src/components/      ui/ (shadcn-style kit), calendar/, booking/, layout/
src/lib/             money, phone, dates, pricing, reports, csv, auth, supabase client
src/server.ts        Worker entry: adds security headers
supabase/migrations  0001 schema, 0002 functions + triggers, 0003 RLS + storage, 0004 cron
supabase/functions   edge functions + _shared/ (daraja, whatsapp, templates, phone ...)
supabase/seed.sql    5 demo properties, ~45 bookings, expenses, tasks (re-runnable)
scripts/             create-owner, seed, seed-users, export-all, dev-functions, SQL test runner
tests/unit           Vitest   tests/sql  database + RLS   tests/api  money paths   tests/e2e  Playwright
DEPLOY.md            production checklist      USER_GUIDE.md  how staff use it
```

## Prerequisites

- Node.js 20 or newer and npm (this repo uses **npm** and commits `package-lock.json`; do not use Bun or pnpm).
- A Supabase project (cloud) **or** Docker Desktop for the local stack.
- Everything below works from Windows CMD/PowerShell as well as macOS/Linux: all npm scripts are cross-platform.

## Quick start (local)

```bash
npm ci
npx supabase start          # needs Docker. Prints the API URL and keys. Applies migrations + seed.
```

Copy `.env.example` to `.env` and fill in the values `supabase start` printed:

```
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<ANON_KEY from supabase status>
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY>
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
DEMO_PASSWORD=<pick a password, 10+ characters>
```

Create `supabase/functions/.env` for the edge functions (the M-Pesa and WhatsApp lines of `.env.example`; `MPESA_ENV=mock` and `WHATSAPP_ENABLED=false` need no credentials):

```
SITE_URL=http://localhost:3000
MPESA_ENV=mock
MPESA_CALLBACK_SECRET=any-random-string-of-32-or-more-characters
WHATSAPP_ENABLED=false
```

Then, in separate terminals:

```bash
npx supabase functions serve --env-file supabase/functions/.env   # edge functions
npm run dev                                                          # app on http://localhost:3000
```

Create your first login (no default password exists in the repo):

```bash
# macOS / Linux
OWNER_EMAIL=you@example.com OWNER_PASSWORD='a-long-password' OWNER_NAME='Your Name' npm run create-owner
# Windows PowerShell
$env:OWNER_EMAIL="you@example.com"; $env:OWNER_PASSWORD="a-long-password"; $env:OWNER_NAME="Your Name"; npm run create-owner
```

…or put those three values in `.env` and just run `npm run create-owner`.

Optional demo users (`owner@`, `manager@`, `cleaner@example.com`, password from `DEMO_PASSWORD`):

```bash
npm run seed:users
```

Re-seed demo data any time with `npm run seed` (it replaces only its own rows).

> **Docker cannot reach npm (corporate proxy)?** `npm run dev:functions` runs the edge functions as plain Deno processes on `http://127.0.0.1:54331/functions/v1`. Set `VITE_FUNCTIONS_URL` to that address.

### Try the guest flow without any credentials

1. Open http://localhost:3000, pick dates, choose a place, fill the form, press **Pay deposit with M-Pesa**.
2. The mock provider "sends a prompt", then confirms by itself after about 4 seconds. The booking flips to **Confirmed** and a receipt appears.
3. To see the failure screen, pay a balance of an amount ending in 13 (for example KES 113). Set `MPESA_MOCK_FAIL_ON_13=false` to turn that off.

## Environment variables

All variables are documented in `.env.example`. The important ones:

| Variable | Where | Notes |
|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | app (browser) | public by design. RLS protects the data |
| `VITE_FUNCTIONS_URL` | app | optional override for the edge functions URL |
| `SUPABASE_SERVICE_ROLE_KEY` | edge functions + scripts only | **never** put it in a `VITE_` variable. The build is checked for it |
| `MPESA_ENV` | edge functions | `mock` (default) / `sandbox` / `production`. Unknown values refuse to run |
| `MPESA_CONSUMER_KEY/SECRET/SHORTCODE/PASSKEY/TXN_TYPE/PARTY_B` | edge functions | Daraja credentials |
| `MPESA_CALLBACK_SECRET` | edge functions | 32+ random characters, sent to Safaricom in the callback URL |
| `WHATSAPP_ENABLED/TOKEN/PHONE_NUMBER_ID/VERIFY_TOKEN` | edge functions | WhatsApp Cloud API. Off by default |
| `SITE_URL` | edge functions | CORS origin and the base of links in messages |

Secrets are never logged; phone numbers are redacted to the last 3 digits in logs.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | app dev server on port 3000 |
| `npm run build` | production build (`dist/`) |
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint |
| `npm run check:functions` | type-checks every edge function with Deno |
| `npm test` | unit tests (Vitest) |
| `npm run test:sql` | database tests: double-booking guard, pricing, RLS, finance totals, seed. Boots a throwaway local PostgreSQL if `DATABASE_URL` is not set (needs PostgreSQL 14+ installed) |
| `npm run test:api` | money-path tests against the running stack (callback replay, wrong amount, late payment, reconcile, race) |
| `npm run test:e2e` | Playwright smoke tests (mobile viewport). Needs the stack, the demo users and `npx playwright install chromium` |
| `npm run create-owner`, `seed`, `seed:users`, `export-all` | operations scripts (see above) |
| `npm run deploy` | `vite build` then `wrangler deploy` |

## Tests

- **Unit:** pricing parity with SQL `quote_stay`, phone normalisation (every accepted and rejected form), money/dates, deposit rounding, Daraja timestamp/password/callback parsing, message templates, reports, security headers.
- **SQL (`tests/sql`):** overlap rejected with `23P01`, back-to-back allowed, cancelled/expired free dates, cleaner cannot read bookings or payments, manager limited to assigned properties, anon blocked, duplicate M-Pesa receipt rejected, trigger confirms the booking when the deposit is covered, monthly profit equals independent sums, seed is re-runnable.
- **API (`tests/api`):** payment replay never double-credits, wrong amount is rejected and flagged, orphan callbacks are kept, reconcile settles missed callbacks, late payment on an expired hold, four-way booking race.
- **E2E (`tests/e2e`):** guest books and pays, two browsers race for the same dates, owner check-in → payment → check-out → cleaner marks clean, a hold expires and the dates reopen, role access.

## How the important rules are enforced

- **No double bookings:** a Postgres exclusion constraint (`no_overlapping_bookings`) on `(unit, daterange [check_in, check_out))` for live statuses. Nothing else is relied on.
- **Prices:** always computed in the database (`quote_stay`, `create_booking`). The browser only previews.
- **Money idempotency:** unique `checkout_request_id` and unique `mpesa_receipt`; callbacks only change a payment that is still pending.
- **Access:** RLS on every table. Cleaners cannot read bookings, payments or guests; managers are limited to assigned properties; deactivated accounts have no roles, so everything is denied. Route guards in the UI are only a convenience.

## Known limitations

- Real Daraja and WhatsApp traffic could not be exercised in the build environment (no credentials). Both are implemented to the documented APIs; use the sandbox and the go-live steps in `DEPLOY.md`.
- When a payment is settled by status query (callback missed), Daraja returns no receipt number, so staff can add the code from the SMS.
- The calendar renders every cell (fine for 5 properties; virtualise if you grow past ~50 units).
- Out of scope by design: WhatsApp chatbot, Airbnb/Booking.com iCal sync, multi-owner tenancy, card payments. Extension points are marked in the code (`whatsapp-webhook` inbound messages, `PaymentProvider` interface).
