-- 0018_contacts_comms_settings.sql
-- Business contact numbers (shown on the public site), more site settings (email, address, currency, time zone, tax,
-- maintenance mode, payment methods), a "Card" payment method, editable message templates, per-guest communication
-- preferences and delivery retry bookkeeping.

alter type payment_method add value if not exists 'card';

insert into settings(key, value) values
  ('business_email', '""'), ('business_address', '""'), ('currency', '"KES"'), ('timezone', '"Africa/Nairobi"'), ('tax_percent', '0'),
  ('maintenance_mode', 'false'), ('enabled_payment_methods', '["mpesa_stk","mpesa_manual","cash","bank","card","other"]'),
  ('checkout_reminder_days_before', '0')
on conflict (key) do nothing;

drop policy if exists settings_public_read on settings;
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes',
                 'mpesa_manual_instructions','mpesa_paybill_display','brand_color','site_content','booking_mode',
                 'business_email','business_address','currency','maintenance_mode'));

-- A manually recorded card payment must also be verified by the owner.
create or replace function payment_verification_default() returns trigger language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or has_role(v_uid, 'owner') or new.method::text = 'mpesa_stk' then
    new.verified := true;
  elsif new.kind = 'refund' or new.method::text in ('mpesa_manual','bank','card') then
    new.verified := false;
  else
    new.verified := true;
  end if;
  if new.verified then new.verified_at := coalesce(new.verified_at, now()); new.verified_by := coalesce(new.verified_by, v_uid); end if;
  return new;
end $$;

-- ---- contact numbers ---------------------------------------------------------------------------------------------
create table contact_numbers (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(trim(label)) between 2 and 40),
  kind text not null default 'other' check (kind in ('reception','reservations','whatsapp','emergency','management','other')),
  phone text not null check (phone ~ '^254[17]\d{8}$'),
  note text check (note is null or char_length(note) <= 120),
  show_on_website boolean not null default false,
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create unique index contact_numbers_kind_phone_uniq on contact_numbers (kind, phone);
alter table contact_numbers enable row level security;
revoke insert, update, delete on contact_numbers from anon;
-- The public sees only numbers the business chose to publish. Emergency and management numbers are staff-only by default.
create policy contacts_public on contact_numbers for select to anon, authenticated using (show_on_website and active and kind not in ('emergency','management'));
create policy contacts_staff_read on contact_numbers for select to authenticated using (is_owner_or_manager((select auth.uid())));
create policy contacts_owner_write on contact_numbers for all to authenticated
  using (has_role((select auth.uid()), 'owner')) with check (has_role((select auth.uid()), 'owner'));
create trigger trg_audit_contact after insert or update or delete on contact_numbers for each row execute function audit_generic('contact_number');

-- ---- editable message templates ----------------------------------------------------------------------------------
create table message_templates (
  key text primary key check (key in ('booking_confirmed','payment_receipt','balance_reminder','checkin_reminder','checkout_reminder','thank_you')),
  label text not null,
  body text check (body is null or char_length(body) between 10 and 1000),     -- null = built-in wording
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles on delete set null
);
insert into message_templates(key, label) values
  ('booking_confirmed','Booking confirmation'), ('payment_receipt','Payment received'), ('balance_reminder','Outstanding payment reminder'),
  ('checkin_reminder','Pre-arrival reminder'), ('checkout_reminder','Check-out reminder'), ('thank_you','Thank you after the stay');
alter table message_templates enable row level security;
revoke all on message_templates from anon;
create policy templates_staff_read on message_templates for select to authenticated using (is_owner_or_manager((select auth.uid())));
create policy templates_owner_write on message_templates for update to authenticated
  using (has_role((select auth.uid()), 'owner')) with check (has_role((select auth.uid()), 'owner'));
create trigger trg_audit_template after update on message_templates for each row execute function audit_generic('message_template');
create trigger trg_templates_updated before update on message_templates for each row execute function set_updated_at();

-- ---- communication preferences + retry bookkeeping ---------------------------------------------------------------
alter table guests add column comms_opt_out boolean not null default false;      -- no reminders or thank-yous (confirmations and receipts still go)
alter table message_log add column attempts int not null default 1 check (attempts between 1 and 10);
alter table message_log add column last_attempt_at timestamptz;
create index on message_log (status, created_at) where status = 'failed';
