# RG Wings Stays: admin platform plan and status

Reference: the owner's "master development prompt" (27 phases). Method: audit what exists, build in vertical slices
(database migration + RLS + admin page + public website wiring + tests), never duplicate existing tables, keep all
authorisation in the database (RLS), and never present sample data as real data.

Status key: DONE = built and tested, PARTIAL = exists but short of the prompt, TODO = not started.

## Audit of the existing system (Phase 1)
Stack: TanStack Start + Vite on a Cloudflare Worker, Supabase (Postgres, Auth, RLS, Storage, Edge Functions, pg_cron).
Auth: one system (Supabase Auth + `profiles` + `user_roles`: owner / manager / cleaner + `staff_properties` scoping).
Existing admin: dashboard, calendar, bookings (+ manual create, detail), guests, properties + units (+ rate overrides),
housekeeping, finance (payments, expenses), reports, WhatsApp messages, staff, settings (business, website text, payments
and WhatsApp status, audit log, CSV exports). Booking safety: exclusion constraint prevents overlapping bookings and
holds expire in the database. Payments: M-Pesa STK (mock/sandbox/production), manual recording, receipts.

## Coverage by phase
| Phase | Topic | Status | Notes |
|---|---|---|---|
| 2 | Brand identity (admin) | PARTIAL | Public site is black/gold from the logo; admin inherits tokens. Full admin restyle (serif headings, champagne) TODO |
| 3 | Executive dashboard | **MOSTLY DONE** | Slice 4 (migration 0010): period picker (today/7d/30d/month/year/custom), 8 KPIs with change vs previous period, revenue and occupancy charts, revenue by method, bookings by source. All numbers come from `dashboard_overview`, computed under RLS |
| 4 | Listings management | **MOSTLY DONE** | Slice 2: publish/unpublish, featured, archive/restore, per-property cancellation policy, bathrooms, bed setup, min/max stay, maintenance flag. Video upload and length-of-stay discounts TODO |
| 5 | Rooms and occupancy | **DONE** | Slice 2: Admin > Rooms board (7 colour-coded statuses for any day), room condition control; overlap prevention already in the database |
| 6 | Occupancy calendar | PARTIAL | Exists (timeline); week/day views, drag to reschedule TODO |
| 7 | Bookings | **DONE (core)** | Lifecycle, manual booking, request approval (0009), digital check-in/out with extra charges (0014), charges ledger, payments, credit, discounts (0012). "Rejected" shows as a declined request |
| 8 | Booking requests and inquiries | **DONE** | Migration 0007 (inquiries) and 0009 (booking requests: approve, decline, offer other dates, guest tracking page /request/token) |
| 9 | Guests and credit | **MOSTLY DONE** | Slice 7 (migration 0013): append-only credit ledger (never below zero, owner-only corrections), use credit on a booking (creates a real payment), VIP and flag-with-reason, printable guest statement. Credit limits and tags TODO |
| 10 | Media library, gallery, homepage images | **DONE** | Migration 0016: Admin > Media library (image/video upload, categories, search, in-use delete protection), Gallery (categories, reorder, publish), Homepage images (hero + promo banners, scheduling). Public site reads them; falls back to property photos |
| 11 | Branding and CMS | **MOSTLY DONE** | Website text, drafts, preview of the top section, publish and version history (0020). Brand colour and logo in Settings. Section ordering and separate policy pages TODO |
| 12 | Reviews and announcements | **DONE** | Migration 0007, Admin > Reviews (approve/hide/flag/reply), Admin > Announcements (schedule/publish/archive), public display + review submission |
| 13 | Blocked dates | **DONE** | Migration 0015: Admin > Blocked dates (room / several rooms / whole property, reasons, refuses to cover real bookings, release) and Maintenance requests (assign, priority, completion notes, can take a room out of service) |
| 14 | Financial management | **MOSTLY DONE** | Migration 0017: payments verification (manual M-Pesa/bank/card and refunds by managers wait for the owner), unverified money is never revenue, expense categories and approval, financial records never hard-deleted, card method. Bank reconciliation matching TODO |
| 15 | Reports | **DONE** | Reporting centre: 14 reports, filters, CSV, Excel (.xlsx) and branded PDF/print |
| 16 | Bar menu and stock | **DONE (optional)** | Migration 0019: bar menu + stock behind two settings switches; public menu only when on; stock only changes through a ledger; low-stock alerts |
| 17 | Marketing and SEO | **MOSTLY DONE** | Slice 6 (migration 0012): Admin > Promotions (percent/fixed codes, property scope, dates, min nights/total, max uses; applied in the database, race-safe, cancelled bookings return the use), code box on the booking page, per-listing search title/description, robots.txt and sitemap.xml. Campaign emails/WhatsApp blasts TODO |
| 18 | Support tickets | **DONE** | Slice 5 (migration 0011): Admin > Support, categories, priority, status, assignment, linked booking, internal/staff thread, resolved time stamped by the database |
| 19 | Roles and permissions | **MOSTLY DONE** | Migration 0020: 9 built-in team roles + custom roles, 36 permissions, enforced with restrictive RLS policies and checks inside the sensitive functions; suspension; assign role; last-owner protection. Per-user permission overrides TODO |
| 20 | Site settings and contacts | **DONE** | Migration 0018: contact numbers (public/private), business email/address, currency, time zone, tax, maintenance mode, enabled payment methods, public site wired |
| 21 | Activity log | **DONE** | Audit triggers across modules + login events incl. failed attempts (0020) + Activity log page with filters |
| 22 | Public site integration | **MOSTLY DONE** | Listings, prices, availability, blocked dates, contacts, reviews, announcements, site text, gallery, banners, bar menu, maintenance mode all wired. Per-section ordering TODO |
| 23 | Notifications | **DONE** | Migration 0009 + 0019: notification centre incl. housekeeping, maintenance, tickets, low stock, failed messages, payments to verify |
| 24 | Database and security | ONGOING | Every new table ships with RLS, indexes, checks, audit trigger and SQL tests |
| 25 | Admin UX | PARTIAL | Grouped sidebar + "Back to website" added. Breadcrumbs, global search TODO |
| 26 | Interaction quality | ONGOING | New pages have search/filters, empty/error/loading states, confirmations |
| 27 | Testing | ONGOING | 122 app tests, 46 SQL tests, browser checks of public pages |

## Slice 1 (this change): Inquiries, Reviews, Announcements
- Migration `0007_inquiries_reviews_announcements.sql` (applied to the live project): tables `inquiries`, `inquiry_notes`,
  `reviews`, `announcements`; RLS (staff only, public sees approved reviews and live announcements); throttled public RPCs
  `submit_inquiry` / `submit_review` with honeypot; "converted" requires a linked booking (trigger); audit triggers.
- Admin pages: Inquiries (status tabs, search, assign, follow-up, notes, WhatsApp/call/email, link booking),
  Reviews (moderate, flag, reply), Announcements (schedule, publish, archive; history kept).
- Public site: contact form, review form, reviews and announcement bar read from the database.
- Tests: 5 new SQL tests (public RPC validation and throttling, RLS isolation, converted guard, announcement window,
  phone normalisation).

## Slice 2 (this change): Listings management and Rooms board
- Migration `0008_listings_management.sql` (applied to the live project): `properties.featured/archived_at/cancellation_policy`
  (archived listings can never be public: CHECK constraint), `units.bathrooms/bed_config/max_nights/maintenance_status/maintenance_note`
  (max stay cannot be below min stay), `create_booking` and `get_available_units` refuse units under maintenance and stays over the
  maximum, and `room_board(date)` returns each unit's status (out of service > maintenance > occupied > cleaning > dirty > reserved >
  available), limited to properties the signed-in user can access.
- Admin: Properties list has Published / Unpublished / Archived tabs and badges; property editor has a Listing status card
  (publish, feature, archive with confirmation, restore) and cancellation policy; unit editor has the new fields and room condition;
  new Rooms page with status filters, day picker and a condition dialog.
- Public site: featured listings sort first and carry the "Featured stay" label.
- Tests: 2 new SQL tests (archive constraint, max stay, maintenance, availability search, board statuses and isolation). One real flaw
  was caught by a test and fixed before release: the board would have listed other properties' rooms with wrong statuses.

## Suggested next slices (each: migration + RLS + admin + public wiring + tests)
2. (done) Listings and rooms board.
3. Booking requests workflow (approve/reject/alternative dates, awaiting-payment status) and notifications centre.
4. Dashboard KPIs, comparisons and charts; report centre with PDF/Excel.
5. Media library, gallery and homepage images (Storage + tables).
6. Custom roles and permissions; login history.
7. Marketing: discount codes, campaigns, per-listing SEO and structured data.
8. Support tickets; guest credit and statements.
9. Optional bar menu and stock.

## Needs from the owner or external credentials
- Email/SMS/WhatsApp notification delivery: WhatsApp Cloud API credentials and approved templates (WhatsApp is switched off today).
- Real M-Pesa production credentials for live payments; `MPESA_CALLBACK_SECRET` and `SITE_URL` function secrets must be set in Supabase.
- Edge Functions are NOT changed by slice 1 (public writes use database RPCs instead), so no redeploy is needed.

## Slices 8 to 14 (this change)
| Slice | Migration | What |
|---|---|---|
| 8 | 0014 | Digital check-in/out (deposit, ready room, early approval, room change), extra charges ledger, front-desk screen |
| 9 | 0015 | Blocked dates (rooms/property) and maintenance requests |
| 10 | 0016 | Media library, managed gallery, homepage banners |
| 11 | 0017 | Payment verification, expense approval/categories, owner overview, reporting centre (CSV/Excel/PDF) |
| 12 | 0018 | Contact numbers, site settings, message templates and schedule, communication opt-out, retries |
| 13 | 0019 | Bar menu/stock (optional), smart access framework (no fake lock), extra notification kinds |
| 14 | 0020 | Team roles + permissions, login events, website content drafts/versions |

Nothing from 0009 onward is applied to the live project yet: run `docs/sql/apply_pending.sql` (regenerate with
`node scripts/build-sql-bundles.mjs`).

## Later slices
| Migration | What |
|---|---|
| 0021 | Global search (bookings, guests, rooms, inquiries, tickets), breadcrumbs, collapsible sidebar |
| 0022 | Fix: notify trigger rejected message_log rows (applied live) |
| 0023 | Change a booking's dates/room with live price preview, history, week calendar view; guest country |
| 0024 | Length-of-stay discounts applied inside the quote; admin rules; public offers |
| 0025 | Housekeeping: new tasks, deadlines/overdue, task photos |
| 0026 | Editable policy pages (terms, privacy ship as unpublished drafts) with public route and footer links |
| 0027 | Listing walkthrough video; also statement reconciliation (CSV) on the Finance page |

Still open: calendar drag-and-drop rescheduling (rescheduling works from the booking page), per-user permission overrides,
website section ordering, SMS/email providers, real smart-lock provider adapter, M-Pesa callback secret.


## Customer accounts and membership
Built. See [MEMBERSHIP.md](MEMBERSHIP.md). Migration 0029, `member-emails` edge function, `/join`, `/login`, `/account/*`, and the Customers & membership admin group.
