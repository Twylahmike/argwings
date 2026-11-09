# Customer accounts and membership

Free member accounts for guests: sign up, verified email, welcome offer, member offers, tiers, points, and an account area. It is built on the existing Supabase Auth, guest records, bookings and discount codes. There is no second login system.

## How it fits together

- A customer is a normal Supabase Auth user with **no staff profile**, so they can never reach `/admin` or any staff data.
- The member profile (`customer_profiles`) is created only after the email is verified. That is also when the welcome reward is issued.
- Customers read their own data through database functions that work from their own user id (`my_customer`, `my_bookings`, `my_rewards`...). They cannot write to any membership table directly.
- Offers are checked in the database when the booking is created (`create_booking_member`). The browser's price is never trusted. A redeemed reward is tied to one booking; if that booking is cancelled, expires or is a no-show, the reward goes back.
- A booking made while signed in is linked to the account. An earlier guest booking can be added with its reference **and** the phone number it was made with (never by email alone).
- Points are earned when a stay is completed (`loyalty_kes_per_point` setting, default 100). Tiers come from the owner's criteria (completed stays and money paid inside the tier's term) or are set by hand on the customer's page.

## One-time setup (Supabase dashboard)

1. **SQL**: run `docs/sql/apply_part7.sql`, then `docs/sql/apply_part8.sql`, in the SQL editor (project **bnb-system**). Both are safe to run twice.
2. **Authentication > Providers > Email**: turn on **Confirm email**. Turn off "Allow new users to sign up" only if you want to stop all sign-ups.
3. **Authentication > URL Configuration**: set **Site URL** to your website address and add `https://YOUR-SITE/auth/callback` and `https://YOUR-SITE/reset-password` to **Redirect URLs**. Without this the verification and reset links will not return to your site.
4. **Authentication > SMTP Settings**: use your own sender (for example Resend SMTP) so verification and reset emails come from your domain and are not rate-limited. Supabase's built-in sender is for testing only.
5. **Authentication > Email Templates**: paste the branded templates below for *Confirm signup*, *Reset password* and *Change email address*.
6. **Edge Functions**: deploy `member-emails`, `create-booking`, `send-whatsapp`, `send-reminders` and `system-status`. Secrets for email are the same as in the email setup (`EMAIL_ENABLED`, `RESEND_API_KEY`, `EMAIL_FROM`, `SITE_URL`).

## Emails

| Email | Sent by |
|---|---|
| Verify your email, Password reset, Change email | Supabase Auth (your SMTP, templates below) |
| Welcome to RG Wings Stays, Your welcome offer is ready, Birthday reward, Special member promotion | `member-emails` function |
| Booking confirmation, Payment confirmation, Upcoming stay reminder | existing guest messages (WhatsApp and email) |

"Sent" in the admin means the email provider **accepted** the message. Delivery is never claimed.

### Supabase template: Confirm signup

Subject: `Confirm your RG Wings Stays account`

```html
<div style="background:#f7f1ec;padding:24px 12px"><div style="max-width:560px;margin:0 auto;background:#fffdf9;border-radius:12px;overflow:hidden;font-family:Inter,Arial,sans-serif;color:#1c1a17">
<div style="background:#0c0b0a;padding:22px 28px"><span style="font-family:Georgia,serif;font-size:24px;color:#d4a24c">RG Wings Stays</span></div>
<div style="padding:28px;font-size:15px;line-height:1.65">
<p>Welcome! Please confirm your email to activate your free membership and unlock your welcome offer.</p>
<p style="margin:28px 0"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#a9761f;color:#ffffff;text-decoration:none;font-weight:600;letter-spacing:.06em;text-transform:uppercase;font-size:13px;padding:14px 28px;border-radius:999px">Confirm my email</a></p>
<p style="color:#666;font-size:13px">If you did not create an account you can ignore this email.</p></div></div></div>
```

### Supabase template: Reset password

Subject: `Reset your RG Wings Stays password`. Same layout; body: "We received a request to reset your password." and the button text `Choose a new password` linking to `{{ .ConfirmationURL }}`.

### Supabase template: Change email address

Subject: `Confirm your new email`. Same layout; button `Confirm new email` linking to `{{ .ConfirmationURL }}`.

## Admin

**Customers & membership** group in the menu (permissions `customers.view`, `customers.manage`, `offers.manage`):

- *Customer accounts*: search, status, tier, bookings, spend, points, offers, activity; suspend and reactivate (reason required), set a tier by hand, adjust points (reason required), issue a reward.
- *Membership overview*: registered, verified, new, active members, welcome offers issued, offers redeemed, discount value, member bookings and revenue. All counted from records.
- *Membership tiers*: criteria, term, benefits, on/off.
- *Special offers*: welcome, birthday and member offers. Percent or fixed, cap, minimum booking value, accommodation, minimum tier, first-booking or returning-guest rules, dates, redemption limits, stacking, on/off. "Email members" sends an open offer to opted-in members.
- *Discount codes*: the existing promotions page.
- *Reward redemptions*, *Loyalty transactions*, *Customer activity*: read-only ledgers.

Customer change and cancellation requests appear on the booking page and as a notification. Staff decide; nothing changes automatically.

## Optional by design

Registration is free and never required. Guests can browse and book without an account, and their booking page (the secret link in the confirmation message) shows payment status and receipts. In Admin, **Membership settings** has two switches:

- **Optional registration**: when off, the "Join for free" invitations disappear and no new memberships are created. Existing members keep theirs.
- **Guest checkout**: on by default. Turn it off only if you want bookings for members only (the booking function enforces it).

The invitation ("Stay More. Enjoy More.") appears on the home page, the spaces list, each property page, the booking page (a quiet one-line note) and the footer. It is hidden for signed-in members.

### Welcome offer

Edited under Membership settings. Nothing is hardcoded: percentage or fixed KES amount (0 switches it off), minimum booking amount, maximum discount, minimum nights, eligible accommodation, start and end dates, reward expiry in days after registration, accommodation charge only or whole total, and whether it can be combined with a discount code. A customer can receive and use only one welcome reward, whatever is configured. The reward is issued only after the email is verified.

### Adding a guest booking to an account

- From the booking page: a signed-in member taps **Add to my account**. The secret booking link is the proof.
- From the account: **My bookings** accepts a booking reference **and** the phone number it was made with.
- After joining with the same email as an earlier guest booking, the account shows only a count ("We found 2 earlier bookings made with your email"). The bookings themselves are never shown until one of the proofs above is given.

## Guest checkout

Settings key `guest_checkout_enabled` (default on). When off, visitors must sign in to book. The booking function enforces it, not only the page.

## Spending points

Off until the owner switches it on (Membership settings, Loyalty points). The owner sets what one point is worth, the most of a stay that points may cover, and how much spend earns a point. At checkout a signed-in member can tick "Use my points"; the database checks the balance, the cap and that spending is on, takes the points inside the booking and records a ledger row tied to the booking. If that booking is cancelled, expires or is a no-show the points come back, once. Run `docs/sql/apply_part10.sql` for this and redeploy `create-booking`.

## Privacy

In Account settings a member can **download their data** (one JSON file) and **request deletion**. The request reaches staff as a notification; in Customer accounts, staff with `customers.manage` can then **Remove personal details**. That clears name, email, phone, country and birthday and suspends the profile, but keeps bookings, payments, redemptions and points in the records (financial records are never deleted). The sign-in itself is removed separately in Supabase, Authentication, Users. Run `docs/sql/apply_part9.sql` for this.

## Not built

- SMS and smart-lock integrations (no provider connected).
- Deleting an account from the account page (ask the owner; financial records are never hard-deleted).
