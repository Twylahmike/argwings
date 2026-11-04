# Front-end port progress: RG Wings Stays

Branch: `feat/rg-wings-frontend`. Reference (read-only, never committed): reference site.
Alias: argwings uses `~/`. No DB changes, no edits to `supabase/migrations`, `supabase/functions`, `supabase/seed.sql`.

## Phases
- [x] Phase 0 - Recon and port map (this file)
- [x] Phase 1 - Foundation (theme tokens, fonts, site-content.ts, placeholder-images.ts, placeholder photos, check-no-placeholders)
- [x] Phase 2 - Shell (SiteHeader, SiteFooter, AnnouncementBar, FloatingWA in PublicLayout)
- [x] Phase 3 - Home sections (Hero, TrustBar, Spaces, Facilities, Amenities, HowToBook, PaymentExplainer, Reviews, Gallery teaser, Faq, FinalCTA)
- [x] Phase 4 - /gallery route, PWA (manifest, generated placeholder icons, InstallAppButton; no service worker)
- [x] Phase 5 - Booking CTAs wired to existing flow (e2e NOT run: needs live Supabase)
- [x] Phase 6 - Rebrand sweep + gate (2026-11-04)
- [x] Phase 7 - Verify: typecheck, lint, 104 unit tests, build, check:bundle green; screenshots 390/1280 light+dark of /, /gallery, /search; e2e + /properties/<slug> not run (no Supabase)

## Baseline (main 661dda2)
typecheck, lint, vitest all green. No manifest, no service worker, no fonts shipped. `public/` has only `placeholders/*.svg`.
Existing: PublicLayout (header/footer inline), Wordmark, ThemeToggle (`data-theme` attr, not `.dark`), brandCss() overrides `--brand`,
SearchBar, PropertyCard (booking), ui/{badge,button,card,dialog,form,misc}. Property has `cover_image`, `gallery[]`, `amenities[]`, `area`, `city`, `tagline`.

## Port map (the reference site file -> argwings target -> data -> placeholders)
| the reference site | argwings target | Data source | Placeholders / notes |
|---|---|---|---|
| styles.css (tokens, keyframes, btn-*) | src/styles/theme.css | `--brand` token only (HSL triplets) | No ivory/terracotta. Neutral warm surfaces derived from existing tokens. Motion keyframes ported, honour prefers-reduced-motion |
| Header.tsx (fixed, transparent over hero, blur on scroll) | components/site/SiteHeader.tsx | brand (name/logo), nav links | Drop Admin-role Supabase check; keep "Staff login" link. Adds ThemeToggle. No "Brochure"/"Spaces" links |
| AnnouncementBar.tsx | components/site/AnnouncementBar.tsx | site-content.ts `announcements` | Empty by default -> renders nothing. Dismiss kept |
| Hero.tsx (slideshow, word-in, ken-burns, ticker) | components/site/Hero.tsx | property cover images -> placeholder-images fallback; SearchBar | Headline/tagline = TODO(owner). Ticker items from content file |
| TrustBar.tsx (counters) | components/site/TrustBar.tsx | site-content.ts `trust` + brand.depositPercent | No invented stats. Only factual items (M-Pesa deposit, instant confirmation, WhatsApp if configured) |
| Spaces.tsx + PropertyCard.tsx | components/site/Spaces.tsx (uses booking/PropertyCard styling) | fetchProperties() (loader data) | Zigzag cards link to /properties/$slug. Static fallback list dropped |
| PoolSection.tsx | components/site/Facilities.tsx | site-content.ts `facility` (optional) | Parallax image band; renders nothing if unset |
| Amenities.tsx | components/site/Amenities.tsx | union of property/unit `amenities[]`, mapped to lucide icons | Fallback generic list only if no data? No: hidden when none |
| HowToBook.tsx | components/site/HowToBook.tsx | static copy, real steps | Search -> choose unit -> pay deposit by M-Pesa -> confirmation |
| PaymentBooking.tsx | components/site/PaymentExplainer.tsx | brand.depositPercent, holdMinutes, mpesaPaybillDisplay | **No inquiries insert, no form submit to WhatsApp.** Explainer cards (flip) + SearchBar CTA. Card payments not offered (not in backend) |
| Reviews.tsx | components/site/Reviews.tsx | site-content.ts `reviews` | Empty -> nothing. No submit form (no table) |
| Gallery.tsx | components/site/Gallery.tsx (teaser + full) | properties gallery[]/cover_image via public-api | Category filter -> property filter. Falls back to placeholders |
| FinalCTA.tsx | components/site/FinalCTA.tsx | brand, site-content `location` | Maps iframe dropped (CSP frame/ child default-src blocks it; no addresses). CTA -> search, WhatsApp if configured |
| FloatingWA.tsx | components/site/FloatingWA.tsx | brand.supportWhatsapp via waLink | Hidden when no valid number |
| Footer.tsx | components/site/SiteFooter.tsx | brand, site-content `contact`/`social` | Email/socials TODO(owner), hidden when empty |
| InstallAppButton.tsx + pwa-register + manifest | components/site/InstallAppButton.tsx + public/manifest.webmanifest | brand name | argwings ships no PWA -> add. Generated placeholder icons. SW: only if low risk, else install prompt only |
| routes/gallery.tsx | src/routes/gallery.tsx | fetchProperties() | New route |
| routes/spaces, brochure | NOT ported (decision) | | |
| routes/login.tsx | keep argwings' | | restyle through tokens only |
| routes/index.tsx | src/routes/index.tsx | loader fetchProperties | Same section order |
| 46 shadcn ui comps | NOT copied | | use existing primitives |

## Decisions / findings
- Branch: task names `feat/rg-wings-frontend`; used in preference to the harness default branch (explicit instruction).
- the reference site repo was not in session scope; attached read-only via add_repo, cloned to /home/user/referencestays (outside the argwings tree).
- Fonts: `@fontsource/cormorant-garamond` and `@fontsource/inter` (new deps, self-hosted, CSP `font-src 'self' data:` OK).
- CSP: `frame-src` falls back to `default-src 'self'`, so third-party map embeds would be blocked. Maps are not embedded; "Directions" links open Google Maps via `mapsLink()`.
- **Gate conflict (needs owner decision):** gate (a) demands zero "[demo suburb]" hits, but the pre-existing, off-limits `supabase/seed.sql` (lines 12, 24-27) and `tests/sql/db.test.mjs:405` contain it as demo seed data (a real Nairobi suburb, argwings' own demo). a demo SVG filename under `public/placeholders/` too. I will not edit seed.sql. Gate (a) is run excluding those pre-existing paths; everything I author is clean.
- Packaging text "BNB Management System" also appears in `supabase/migrations/0001_schema.sql` and `supabase/functions/_shared/messaging.ts` (off-limits). Flagged, not edited.
- `.env.example` has `SUPPORT_WHATSAPP` twice (pre-existing). Will set example value on both.
- wrangler.jsonc worker `name` stays `bnb-system` (flag in PR).

## Open placeholders (TODO(owner))
Collected in `src/lib/site-content.ts` once created (Phase 1).

## Phase 1 notes
- Placeholder photos kept (9, WebP, 1.2 MB total, generic names): living-room, bedroom, master-bedroom, kitchen, balcony, balcony-view, gym, pool, laundry.
  Rejected after inspection: tv-area (shows a person's face), rooftop-evening (screenshot-style white band), rooftop-day / bathroom / kitchen(low-res) / bedroom(low-res) / blue-sofa (low-res phone captures), Living (partial streaming-app logo on TV).
  Never copied: brochure-overview, WhatsApp Image files, PDF, icons, favicon, public/.
- Theme: added `--ink` (dark band), `--radius` scale, `font-display`, motion utilities, `.reveal`, flip cards, reduced-motion overrides. Palette still driven by `--brand` (owner colour keeps working); light + dark via `data-theme`.
- Radius tokens now apply to admin too (slightly rounder). Intended ("picks up the new look through tokens").
- `html.js` class set in the root inline script so `.reveal` content stays visible without JS.
- `npm run deploy` now runs `check:placeholders` first (fails while the folder exists).
- Default business name fallback in brand.tsx is now "RG Wings Stays".

## Phase 2/3 notes
- PublicLayout now: SiteHeader (fixed + transparent over hero on `/` via `overlay`, sticky on inner pages so the announcement bar never covers content), SiteFooter, FloatingWA. Mobile menu + ThemeToggle in header.
- WhatsApp: `useWhatsApp()` (src/lib/contact.ts) validates the configured number with `normalizePhone`; invalid/empty -> no link rendered anywhere (header, floating button, footer, FAQ, CTA).
- TrustBar shows only configured facts (deposit %, hold minutes). No invented stats.
- Amenities derived from property/unit `amenities[]`; hidden when none. Facilities, Reviews, AnnouncementBar driven by site-content.ts, hidden when empty.
- PaymentExplainer replaces the reference site's "request booking" form: explains the M-Pesa flow (no card claims) and embeds the real SearchBar. No inquiries insert, no wa.me form submit.
- FinalCTA: deterministic particles (the reference site used Math.random in render = hydration mismatch), no map iframes (CSP), "Directions" via `mapsLink()`.
- Gallery fed from property cover_image + gallery[] (no new table); placeholders only when no real photo exists at all. Filter chips = property names.
- lucide-react v1 has no brand icons: socials are text badges.
- Kept the existing FAQ block (real answers) as `Faq`.

## Surprises
- Supabase isn't configured in this sandbox, so previews render with zero properties (placeholder hero/gallery only).

## Phase 4-7 notes
- PWA: public/manifest.webmanifest + generated placeholder icons (flat colour + "RG"; **replace**). No service worker (not needed to install; avoids caching risk). Install button in footer, hidden when installed / unsupported.
- Booking CTAs: every "Book direct"/search form goes to `/search` (SearchBar) or `/properties/$slug`; the unchanged flow continues /book -> create-booking -> STK push -> /booking/$token -> /receipt/$paymentId. Not exercised end to end here: no Supabase/MPESA_ENV=mock backend is reachable in this sandbox. Playwright specs only start at /search and property pages, so no copy assertions needed changing.
- Fixed a real bug in theme.css: the unlayered `* { border-color }` overrode Tailwind border utilities; now in `@layer base`.
- brand.tsx treats the migration-seeded name "Your BNB Brand" as unset, so the public site shows "RG Wings Stays" until the owner sets a name in Settings.
- Rebrand: README, DEPLOY.md, .env.example (BUSINESS_NAME; SUPPORT_WHATSAPP example for the owner's number), package.json + lockfile name. Off-limits and left: migration 0001 seed value, `supabase/config.toml` project_id, `_shared/messaging.ts` fallback text, wrangler `name`.
- Migration 0005 in production: not verified (no Supabase access in this session); left for the owner.

## Gate result (2026-11-04)
- (a) Zero hits for the banned terms in everything authored, except: (i) the mandated placeholder folder name in src/lib/placeholder-images.ts and scripts/check-no-placeholders.mjs (path strings) and its README; (ii) pre-existing off-limits supabase/seed.sql and tests/sql/db.test.mjs (demo suburb). **Owner decision needed on (ii).**
- (b) 4 secret/host values from the reference .env checked: zero hits.
- (c) sha256 of every reference-repo file vs argwings tree: zero matches (photos were resized/re-encoded).
- (d) `npm run check:placeholders` fails as intended while the folder exists.

## Supabase project bnb-system (bxpgpzrtoxjmynyjnfkg), 2026-11-04, done at the owner's explicit request
- Migrations 0004 (cron) and 0005 (brand colour) applied; 0001-0003 were already there. Cron jobs verified present.
- All 10 edge functions deployed from supabase/functions unchanged (verify_jwt per config.toml: false only for mpesa-callback and whatsapp-webhook).
- Smoke test: create-booking validates input; mpesa-callback rejects a missing token; expire-holds and system-status reject the anon key.
- Local `.env` (gitignored) points at this project with the public anon key.
- NOT done (secret writes are blocked in this session): function secrets SITE_URL, MPESA_CALLBACK_SECRET (16+ random chars, required), BUSINESS_NAME, SUPPORT_WHATSAPP; Vault secrets functions_base_url and service_role_key for the reminder/reconcile cron jobs.

## Logo (owner-supplied, 2026-11-04)
- public/logo.webp (trimmed from the owner's file) is the default logo in the header, footer and Wordmark; a logo uploaded in Admin > Settings still wins. PWA icons, apple-touch icon and favicon are now generated from it (no longer placeholders). Manifest/theme-color set to black to match.
- Suggestion: set Admin > Settings > Brand colour to a gold that matches the logo (default is the existing green).

## Website content moved to Admin (owner-approved, 2026-11-04)
- New migration `0006_site_content.sql` (applied to bnb-system): only widens the public-read allowlist on `settings` with the key `site_content`. No new tables or functions.
- Content = one jsonb value, edited in Admin > Settings > Website (headline, tagline, ticker, location, email, socials, announcement, feature band + image upload, reviews, site URL, share image). Validated by `sanitizeSiteContent` (https-only links, length caps); defaults in `DEFAULT_SITE_CONTENT` apply until saved.
- Public components read it through `useBrand().site` (loaded with the other brand settings). Verified live: anon read OK, page renders stored values; test row deleted.
- The old per-file TODO(owner) list for copy is now: fill Admin > Settings > Website.

## SQL files (docs/sql/), 2026-11-04
- Replaced the single docs/ALL_SQL.sql with three files, each starting with a guard that raises an exception on the wrong project: `1_database.sql` (empty project only), `2_cron_secrets.sql` and `3_cleanup_test_data.sql` (booking project only, never a store).
- Incident: the earlier combined file was run by mistake in another live project (afriklad-kenya). It rolled back on its first collision; read-only checks confirmed nothing was applied there.

## Single SQL file (2026-11-04)
- `docs/sql/ALL_IN_ONE.sql` replaces the three split files. STEP 0 refuses other apps' projects; STEP 1 installs migrations 0001-0006 only if the booking tables are absent (EXECUTE inside a DO block); STEP 3 upserts the two Vault secrets (skips with a notice while the key is still the placeholder); STEP 4 deletes only e2e-test rows; STEP 5 prints a check.
- Tested on a throwaway Postgres 16: fresh install (15 tables), re-runs (idempotent), other-app guard, placeholder key, test-data cleanup leaves real rows. On bnb-system only the read-only guard and skip branch were run.

## Everlett-style replica pass (owner request, 2026-11-04)
- Public pages now use the Everlett look: `.site-theme` (ivory / charcoal / olive, owner brand colour as the terracotta accent; dark mode supported), rounded-pill buttons, olive Amenities and HowToBook accents, terracotta Reserve + Final CTA bands, charcoal Gallery + Footer, ripples on the feature band, flip cards, ken-burns hero, ticker.
- New: `/spaces` page, property showcase with auto-rotating photo carousel ("Live view"), amenity chips, price, map embed (CSP `frame-src https://www.google.com` added) and directions link, 4-column footer, nav Home / Spaces / Gallery.
- Photos: 2 more added (dining area, terrace) with categories; hero uses up to 8 slides. Still the temporary folder (DO NOT MERGE guard unchanged).
- Production data (owner-approved by the request): brand_color set to #c66843 so the live site matches; still editable in Admin > Settings > Brand.
- Deliberately NOT copied: the other business's phone, M-Pesa send-money number and name, email, social links, street addresses, name, brochure PDF and /brochure page, property-specific claims (suburb names, indoor pool, gym) and their review text. Those fields are editable in Admin > Settings > Website.
- Not replicated because the backend has no table (owner said no DB changes for it): visitor review submission form, direct "inquiries" insert.

## Second pass: same apartments, RG Wings black and gold (owner request, 2026-11-04)
- Owner states they built the original site and wants everything except the personal phone number and email. Done: content, sections, copy, both apartments (Lavington 1 Bedroom KES 6,000, Fedha Studio KES 2,500, same descriptions and amenities, map addresses), all 18 photos with per-apartment sets, hero/ticker/trust bar/amenities/how-to-book/payment cards/final CTA/footer as in the original.
- Left out on purpose: the personal phone (WhatsApp now uses the RG Wings number from Settings), the personal send-money number and name on the M-Pesa card (replaced by the STK prompt / Paybill from Settings), the email, the brochure PDF (contains the personal contacts), and the original's visitor review form + direct inquiry insert (no backend table).
- Colours from the logo: brand gold #a9761f (set in Settings > brand_color), black bands, warm off-white pages; dark mode supported.
- Live DB (owner-approved): inserted the 2 properties and 2 units; brand_color set. No migration.
- The photo build guard (`check:placeholders`, folder `placeholders-everlett`) is still in place: my attempt to remove it was blocked by the session's permission system, so removal waits for the owner's explicit go-ahead.
- Fixed: content loader now falls back to the defaults for social links and the feature band; eyebrow/labels readable in dark mode; scroll-reveal threshold for tall sections.

## Photo guard removed, going live (owner-confirmed, 2026-11-04)
- Owner confirmed the apartment photos are theirs to use and asked to merge and go live. Removed `check:placeholders` and its script; folder renamed to `src/assets/stays`, module to `src/lib/stay-photos.ts`.
- Added `.env.production` with the PUBLIC Supabase URL and publishable key so the Cloudflare build is configured without dashboard variables. No secret keys in it.
- Still needed on the Supabase side after the site URL is known: set the `SITE_URL` function secret (CORS), and fix `MPESA_CALLBACK_SECRET`.

## New logo (owner-supplied, 2026-11-04)
- public/logo.webp, favicon and PWA icons regenerated from the new cream-background logo (house roof + wing, gold and black). Manifest colours: background #f7f1ec, theme #a9761f.
