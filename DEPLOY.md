# Deploying to production

Work through this top to bottom. Each step says how to check it worked. Run commands from the `bnb-system/` folder. Windows CMD/PowerShell and macOS/Linux both work; where syntax differs both are shown.

## 0. Before you start

You need: a Supabase account, a Cloudflare account, Node.js 20+, and `npm ci` already run. Have these ready (see "Inputs from the client" at the end): domain, owner email, M-Pesa Paybill/Till and Daraja credentials, WhatsApp Business details.

## 1. Create the Supabase project

1. supabase.com → New project. Pick a region close to Nairobi (for example Frankfurt or London). Save the database password.
2. Project settings → API: copy the **Project URL**, the **anon** key and the **service_role** key. The service role key is a secret: it goes only into function secrets and your own terminal, never into the app's `VITE_` variables.
3. Link the CLI: `npx supabase login` then `npx supabase link --project-ref <your-project-ref>`.

## 2. Run the migrations

```
npx supabase db push
```

This applies `0001_schema` to `0004_cron`. Check: Table editor shows `bookings`, `payments`, … with the RLS shield enabled on every table.

Do **not** load `seed.sql` into production unless you want demo properties. To remove demo data later, delete the five demo properties from Admin → Properties.

### Enable the scheduler extensions

Database → Extensions: enable **pg_cron** and **pg_net** (and **supabase_vault** if it is not on). Then re-run `npx supabase db push` if migration `0004` was skipped (it prints a notice instead of failing when the extensions are missing).

Store the two secrets the cron jobs use (SQL editor, run once):

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'functions_base_url');
select vault.create_secret('<SERVICE ROLE KEY>',                'service_role_key');
```

Check: `select jobname, schedule from cron.job;` lists three jobs:

| Job | Schedule | Does |
|---|---|---|
| `bnb-expire-holds` | every minute | frees unpaid holds (`expire_stale_holds()`) |
| `bnb-mpesa-reconcile` | every 2 minutes | settles STK pushes whose callback never arrived |
| `bnb-send-reminders` | 05:00 UTC = 08:00 Nairobi daily | check-in, balance and thank-you messages |

## 3. Auth settings

Authentication → Providers: keep **Email** enabled. Authentication → Sign In / Providers: **turn off "Allow new users to sign up"** (staff accounts are created by the owner). Set Site URL to your final site address.

## 4. Edge function secrets

Generate a callback secret first (any 32+ random characters):

```
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Then set the secrets (one line; replace the values). The `SUPABASE_*` variables are provided automatically.

```
npx supabase secrets set SITE_URL=https://yourdomain.co.ke BUSINESS_NAME="Your BNB Brand" SUPPORT_WHATSAPP=2547XXXXXXXX MPESA_ENV=mock MPESA_CALLBACK_SECRET=<the random value> WHATSAPP_ENABLED=false
```

Start with `MPESA_ENV=mock` so you can test the whole flow without real money, then switch (step 8). Allowed values are `mock`, `sandbox`, `production`; anything else makes payment functions refuse to run (on purpose).

## 5. Deploy the edge functions

```
npx supabase functions deploy
```

`supabase/config.toml` already marks only `mpesa-callback` and `whatsapp-webhook` as `verify_jwt = false`. Everything else requires a valid token, and the cron-only functions additionally require the service-role key.

Check: Edge Functions shows `create-booking`, `mpesa-stk-push`, `mpesa-callback`, `mpesa-reconcile`, `expire-holds`, `send-whatsapp`, `whatsapp-webhook`, `send-reminders`, `admin-users`, `system-status`. Open Admin → Settings → "Payments & WhatsApp": it shows the M-Pesa mode.

## 6. Create the owner login

```
# PowerShell
$env:SUPABASE_URL="https://<ref>.supabase.co"; $env:SUPABASE_SERVICE_ROLE_KEY="<service role>"
$env:OWNER_EMAIL="owner@yourdomain.co.ke"; $env:OWNER_PASSWORD="<long password>"; $env:OWNER_NAME="Owner Name"
npm run create-owner
```

(macOS/Linux: same variables inline before the command.) Sign in at `/login`.

## 7. Deploy the website to Cloudflare Workers

1. Create `.env.production` (not committed) with only browser-safe values:
   ```
   VITE_SUPABASE_URL=https://<ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=<anon key>
   ```
2. `npx wrangler login`
3. `npx wrangler deploy` (this runs from CMD/PowerShell too). It uses `wrangler.jsonc` (`name: bnb-system`) and the build output. Or run `npm run deploy`, which builds first.
4. Run the leak check after every build: `npm run check:bundle` (fails if a service-role key or secret name is in the browser files).
5. **Custom domain:** Cloudflare dashboard → Workers & Pages → bnb-system → Settings → Domains & Routes → add your domain. Update `SITE_URL` (secret in step 4) and Supabase Auth Site URL to match, then redeploy functions: `npx supabase secrets set SITE_URL=https://yourdomain.co.ke`.

If you build on Cloudflare CI, use the npm install command (`npm ci`) and build command `npm run build`. Do not use Bun: the project ships a `package-lock.json` only.

Security headers (CSP, X-Frame-Options, Referrer-Policy, HSTS) are added by `src/server.ts`. If you add a third-party script, add its origin to `src/lib/security-headers.ts`.

## 8. M-Pesa Daraja

### Sandbox first

1. developer.safaricom.co.ke → create an app with **Lipa na M-Pesa Sandbox**. Copy Consumer Key and Secret. The sandbox shortcode is `174379` and the passkey is on the app's Test Credentials page.
2. Set secrets: `npx supabase secrets set MPESA_ENV=sandbox MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=174379 MPESA_PASSKEY=... MPESA_TXN_TYPE=CustomerPayBillOnline`
3. The callback URL is generated for you: `https://<ref>.supabase.co/functions/v1/mpesa-callback?token=<MPESA_CALLBACK_SECRET>`. No need to register it for STK push: it is sent with each request.
4. Test with a Safaricom sandbox phone number. A good payment appears as **Confirmed** within seconds.

### Go-live checklist

1. Have a registered business Paybill or Till. For a **Till** use `MPESA_TXN_TYPE=CustomerBuyGoodsOnline` and set `MPESA_PARTY_B` to the Till number (`MPESA_SHORTCODE` is the store/HO number Safaricom gives you).
2. Safaricom portal → **Go Live**: submit the application, choose Lipa na M-Pesa Online, and give your Paybill/Till. Safaricom emails the production **Consumer Key/Secret** and the production **Passkey**.
3. If Safaricom asks you to whitelist the callback host, give `<ref>.supabase.co`. (Callback URLs must be HTTPS, which Supabase provides.)
4. Set the production secrets: `npx supabase secrets set MPESA_ENV=production MPESA_CONSUMER_KEY=... MPESA_CONSUMER_SECRET=... MPESA_SHORTCODE=<paybill/store> MPESA_PASSKEY=... MPESA_TXN_TYPE=...`
5. Do one real payment of KES 10 to yourself and check: the booking confirms, the payment shows an M-Pesa code, the receipt prints, and Admin → Settings shows mode **production**.
6. In Admin → Settings, enter the **Paybill/Till shown to guests** (for the manual-payment fallback).

If a callback ever fails to arrive, `mpesa-reconcile` asks Safaricom for the result within 2 minutes and settles the payment.

## 9. WhatsApp Cloud API (optional until ready)

The system works without it: messages are logged as *skipped* and staff tap **Send via WhatsApp** to send each one from their own phone.

1. developers.facebook.com → create a Business app → add **WhatsApp**. Add and verify your business phone number. Copy the **Phone number ID** and create a permanent **System User token** with `whatsapp_business_messaging` permission.
2. Webhook: Callback URL `https://<ref>.supabase.co/functions/v1/whatsapp-webhook`, Verify token = the value of `WHATSAPP_VERIFY_TOKEN` you choose. Subscribe to `messages`. (Optionally set `WHATSAPP_APP_SECRET` so signatures are verified.)
3. Secrets: `npx supabase secrets set WHATSAPP_ENABLED=true WHATSAPP_TOKEN=... WHATSAPP_PHONE_NUMBER_ID=... WHATSAPP_VERIFY_TOKEN=...`
4. Admin → Settings → Payments & WhatsApp → tick **Send automatic WhatsApp messages**.
5. **Templates.** Business-initiated messages outside the 24-hour window need approved templates. Create these English templates in WhatsApp Manager (category *Utility*), body text with the variables in order, then set `WHATSAPP_USE_TEMPLATES=true`:

   | Template name | Variables {{1}}… |
   |---|---|
   | `bnb_booking_confirmed` | first name, property, reference, dates, link |
   | `bnb_payment_receipt` | first name, amount, reference, balance, link |
   | `bnb_balance_reminder` | first name, balance, reference, check-in date, link |
   | `bnb_checkin_reminder` | first name, property, date, time, link |
   | `bnb_thank_you` | first name, property |

   Until templates are approved leave `WHATSAPP_USE_TEMPLATES` unset: the system then sends normal session messages (these only deliver if the guest messaged you in the last 24 hours, so the manual fallback button remains handy).

## 10. Backups

- Supabase → Database → Backups: Pro plan has daily backups; enable **Point in Time Recovery** for a business with live payments.
- Weekly CSV safety copy: `npm run export-all` (needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in your terminal). It writes every table to `exports/<timestamp>/`. Store the folder somewhere private: it contains guest details.
- Owners can also download CSVs from Admin → Settings → Data export.

## 11. Post-launch smoke test

Do these on a phone, in order:

- [ ] Home page loads, all properties visible, photos show.
- [ ] Search dates → property → unit → **Book now**.
- [ ] Pay the deposit with M-Pesa (real KES 10 if live, or sandbox). Booking turns **Confirmed**; receipt opens and prints.
- [ ] A second phone trying the same dates is told they were just taken.
- [ ] Owner login → dashboard shows the booking; calendar shows the bar.
- [ ] Check in → record a cash balance → check out. A cleaning task appears.
- [ ] Cleaner login (assigned property only) → Start cleaning → Mark clean. Cleaner cannot open Finance.
- [ ] Block dates on the calendar; they no longer appear as available on the site.
- [ ] Settings → Payments & WhatsApp shows the correct M-Pesa mode (production) .
- [ ] Settings page changes (business name, deposit %) show on the guest site.
- [ ] Leave a booking unpaid: after the hold time it expires and the dates reopen.
- [ ] `select * from cron.job_run_details order by start_time desc limit 5;` shows the jobs succeeding.
- [ ] A failed STK (cancel the prompt on the phone) shows a clear message and **Try again**.

## Inputs still needed from the client

Property names, addresses, photos, rates and house rules · brand name, logo and colours · owner's WhatsApp number and a number per property · M-Pesa Paybill or Till number and Daraja credentials · a WhatsApp Business account and approved templates · the domain name · the owner's email for the first login. All of these can be edited in the admin screens except the secrets (set with `supabase secrets set`) and brand colours (`src/styles/theme.css`).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Guests see "Failed to fetch" at checkout | `SITE_URL` secret does not exactly match the site's address (CORS) |
| STK prompt arrives but booking stays pending | callback not reaching `mpesa-callback`; check `MPESA_CALLBACK_SECRET` and function logs. Reconcile will still settle it within ~2 minutes |
| Cron jobs never run | `pg_cron`/`pg_net` not enabled, or the two Vault secrets are missing |
| "Payment needs review" on the dashboard | late payment on an expired hold whose dates were taken, or an amount mismatch. Open the booking, refund or move the guest, then **Mark as reviewed** |
| Staff cannot sign in after deactivation | working as intended: deactivated users have no roles |
