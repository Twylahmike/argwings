# Front-end port progress: RG Wings Stays

Branch: `feat/rg-wings-frontend`. Reference (read-only, never committed): Everlett Stays public site.
Alias: argwings uses `~/`. No DB changes, no edits to `supabase/migrations`, `supabase/functions`, `supabase/seed.sql`.

## Phases
- [x] Phase 0 - Recon and port map (this file)
- [ ] Phase 1 - Foundation (theme tokens, fonts, site-content.ts, placeholder-images.ts, placeholder photos, check-no-placeholders)
- [ ] Phase 2 - Shell (Header, Footer, AnnouncementBar, FloatingWA in PublicLayout)
- [ ] Phase 3 - Home sections
- [ ] Phase 4 - /gallery, PWA
- [ ] Phase 5 - Booking CTAs wired to existing flow, mock M-Pesa e2e
- [ ] Phase 6 - Rebrand sweep + gate
- [ ] Phase 7 - Verify (typecheck, lint, test, build, check:bundle, e2e, screenshots)

## Baseline (main 661dda2)
typecheck, lint, vitest all green. No manifest, no service worker, no fonts shipped. `public/` has only `placeholders/*.svg`.
Existing: PublicLayout (header/footer inline), Wordmark, ThemeToggle (`data-theme` attr, not `.dark`), brandCss() overrides `--brand`,
SearchBar, PropertyCard (booking), ui/{badge,button,card,dialog,form,misc}. Property has `cover_image`, `gallery[]`, `amenities[]`, `area`, `city`, `tagline`.

## Port map (Everlett file -> argwings target -> data -> placeholders)
| Everlett | argwings target | Data source | Placeholders / notes |
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
- Everlett repo was not in session scope; attached read-only via add_repo, cloned to /home/user/everlettstays (outside the argwings tree).
- Fonts: `@fontsource/cormorant-garamond` and `@fontsource/inter` (new deps, self-hosted, CSP `font-src 'self' data:` OK).
- CSP: `frame-src` falls back to `default-src 'self'`, so third-party map embeds would be blocked. Maps are not embedded; "Directions" links open Google Maps via `mapsLink()`.
- **Gate conflict (needs owner decision):** gate (a) demands zero "Lavington" hits, but the pre-existing, off-limits `supabase/seed.sql` (lines 12, 24-27) and `tests/sql/db.test.mjs:405` contain it as demo seed data (a real Nairobi suburb, argwings' own demo). `public/placeholders/lavington.svg` filename too. I will not edit seed.sql. Gate (a) is run excluding those pre-existing paths; everything I author is clean.
- Packaging text "BNB Management System" also appears in `supabase/migrations/0001_schema.sql` and `supabase/functions/_shared/messaging.ts` (off-limits). Flagged, not edited.
- `.env.example` has `SUPPORT_WHATSAPP` twice (pre-existing). Will set example value on both.
- wrangler.jsonc worker `name` stays `bnb-system` (flag in PR).

## Open placeholders (TODO(owner))
Collected in `src/lib/site-content.ts` once created (Phase 1).

## Surprises
(none yet)
