-- 0006_site_content.sql: marketing copy for the public site (hero headline, reviews, socials...) is edited in
-- Admin > Settings > Website and stored as ONE jsonb value under settings.key = 'site_content'.
-- The only change needed is to let the public site read that key (same allowlist approach as 0005).
drop policy if exists settings_public_read on settings;
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes',
                 'mpesa_manual_instructions','mpesa_paybill_display','brand_color','site_content'));
