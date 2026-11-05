# Smart access: what exists and what it needs

## What is built (and tested)
* `smart_lock_devices`: a lock per room. Provider is `manual` (keypad / key box that staff set themselves) or `external`.
* `issue_access_credential`: generates a 6-digit PIN for a confirmed stay whose deposit is paid. The PIN is returned **once**; the database keeps
  only `sha256(salt || pin)` and the last two digits. Logged-in users cannot read the digest or salt (column privileges).
* Status is honest: a manual lock produces status `manual` ("set this code on the lock yourself"). Only `confirm_credential_provisioned`,
  callable by the service role (a provider adapter), can mark a code `provisioned`; nothing in the app pretends a lock was programmed.
* `revoke_access_credential` (reason required), `expire_access_credentials` (every 15 minutes through pg_cron), and an append-only `access_logs`.

## What is NOT built
No smart-lock brand is integrated. That needs: compatible hardware, the provider's documented API and credentials, and an adapter.
Nothing here invents provider endpoints.

## Adding a provider (outline)
1. Obtain the provider's API documentation and credentials; store the credentials as Supabase function secrets, never in the database or the browser.
2. Create an edge function (service role) that, for credentials in status `pending` on `external` devices, calls the provider to create the temporary code
   with the same PIN window, then calls `confirm_credential_provisioned(credential_id, ok, provider_ref, detail)`.
   The PIN must be passed to the adapter at issue time (it is not recoverable afterwards), so the adapter should be invoked from `issue_access_credential`'s
   caller (the admin page) over an authenticated request, or the function extended to hand the PIN to a one-time queue that is deleted after use.
3. On revoke or expiry, call the provider to delete the code, and log the result with `log_access`.
4. Report device state (`status`, `battery_pct`, `last_seen_at`) from the adapter only; users cannot edit these fields.
