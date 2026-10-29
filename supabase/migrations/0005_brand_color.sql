-- 0005_brand_color.sql: owner-editable brand colour (Settings > Brand), readable by the public site.
insert into settings(key, value) values ('brand_color', '"#0f766e"') on conflict (key) do nothing;

drop policy if exists settings_public_read on settings;
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes',
                 'mpesa_manual_instructions','mpesa_paybill_display','brand_color'));
