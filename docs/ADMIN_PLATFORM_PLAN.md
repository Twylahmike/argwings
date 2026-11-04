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
| 3 | Executive dashboard | PARTIAL | Exists; comparisons (day/week/month/year), 8 KPI set, charts by source/method, date filters TODO |
| 4 | Listings management | PARTIAL | Properties/units CRUD, images, pricing, overrides exist. Publish/feature/archive, video, bathrooms, min/max stay UI, discounts TODO |
| 5 | Rooms and occupancy | PARTIAL | Units + housekeeping status exist; unified room status board TODO |
| 6 | Occupancy calendar | PARTIAL | Exists (timeline); week/day views, drag to reschedule TODO |
| 7 | Bookings | PARTIAL | Full lifecycle exists (pending/confirmed/checked in/out/cancelled/no-show). "Inquiry", "awaiting payment", "rejected" statuses and approval workflow TODO |
| 8 | Booking requests and inquiries | **DONE (inquiries)** | Migration 0007, Admin > Inquiries, public contact form. Booking-request approval workflow TODO |
| 9 | Guests and credit | PARTIAL | Guest list/profile/anonymise exist. Credit limits, statements TODO |
| 10 | Media library, gallery, homepage images | TODO | Needs `media` tables + Storage policies |
| 11 | Branding and CMS | PARTIAL | Website text tab (headline, tagline, socials, feature band, SEO basics). Section ordering, drafts/preview, policies pages TODO |
| 12 | Reviews and announcements | **DONE** | Migration 0007, Admin > Reviews (approve/hide/flag/reply), Admin > Announcements (schedule/publish/archive), public display + review submission |
| 13 | Blocked dates | PARTIAL | `staff_block_dates` exists (calendar). Multi-unit/property block UI, reasons TODO |
| 14 | Financial management | PARTIAL | Payments, expenses, P&L exist. Approval status, categories table, refund workflow, card/bank verification UI TODO |
| 15 | Reports | PARTIAL | Reports + CSV. PDF/Excel exports, 14 report set TODO |
| 16 | Bar menu and stock | TODO | Optional module behind a settings flag |
| 17 | Marketing and SEO | TODO | Discount codes, campaigns, per-listing SEO |
| 18 | Support tickets | TODO | |
| 19 | Roles and permissions | PARTIAL | 3 fixed roles enforced by RLS. Custom roles/permission matrix, suspension (active flag exists), login history TODO |
| 20 | Site settings and contacts | PARTIAL | Business, brand, WhatsApp, deposit, policy exist. Currency/time zone/tax/maintenance mode/contact numbers TODO |
| 21 | Activity log | PARTIAL | Audit triggers on bookings, payments, units, expenses, roles, settings and now inquiries/reviews/announcements. Login events TODO |
| 22 | Public site integration | PARTIAL | Listings, prices, availability, contact, reviews, announcements, site text wired. Homepage images TODO |
| 23 | Notifications | TODO | In-app notification centre (new inquiry, review, payment) |
| 24 | Database and security | ONGOING | Every new table ships with RLS, indexes, checks, audit trigger and SQL tests |
| 25 | Admin UX | PARTIAL | Grouped sidebar + "Back to website" added. Breadcrumbs, global search TODO |
| 26 | Interaction quality | ONGOING | New pages have search/filters, empty/error/loading states, confirmations |
| 27 | Testing | ONGOING | 109 app tests, 20 SQL tests, browser checks of public pages |

## Slice 1 (this change): Inquiries, Reviews, Announcements
- Migration `0007_inquiries_reviews_announcements.sql` (applied to the live project): tables `inquiries`, `inquiry_notes`,
  `reviews`, `announcements`; RLS (staff only, public sees approved reviews and live announcements); throttled public RPCs
  `submit_inquiry` / `submit_review` with honeypot; "converted" requires a linked booking (trigger); audit triggers.
- Admin pages: Inquiries (status tabs, search, assign, follow-up, notes, WhatsApp/call/email, link booking),
  Reviews (moderate, flag, reply), Announcements (schedule, publish, archive; history kept).
- Public site: contact form, review form, reviews and announcement bar read from the database.
- Tests: 5 new SQL tests (public RPC validation and throttling, RLS isolation, converted guard, announcement window,
  phone normalisation).

## Suggested next slices (each: migration + RLS + admin + public wiring + tests)
2. Listings: publish/feature/archive, bathrooms, min/max stay UI, discounts; room status board.
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
