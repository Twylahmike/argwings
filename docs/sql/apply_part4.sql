-- apply_pending.sql: paste into the Supabase SQL Editor of project "bnb-system" (ref bxpgpzrtoxjmynyjnfkg) and press Run.
-- PART 4 of 5: migrations 0019 to 0021. Run the parts in order.
-- Stops without changes if this is the wrong project or migration 0008 is missing.
do $apply$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'STOP: this is not the RG Wings project (no bookings table). Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='units' and column_name='maintenance_status') then
    raise exception 'STOP: apply migration 0008 first. Nothing was changed.';
  end if;
  if to_regclass('public.bar_products') is null then
    execute $m0019$
-- 0019_bar_smart_access_notifications.sql
-- 1. Optional bar menu + stock modules (off by default; the public menu shows only when switched on).
-- 2. Smart access framework: devices, temporary credentials (PINs are shown once and stored only as a salted digest),
--    and an access log. Nothing is ever reported as programmed on a lock unless a provider adapter confirmed it.
-- 3. More notification kinds: maintenance, housekeeping, low stock, failed messages, tickets, payments to verify.

insert into settings(key, value) values ('module_bar_menu','false'), ('module_bar_stock','false') on conflict (key) do nothing;
drop policy if exists settings_public_read on settings;
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes',
                 'mpesa_manual_instructions','mpesa_paybill_display','brand_color','site_content','booking_mode',
                 'business_email','business_address','currency','maintenance_mode','module_bar_menu'));

create or replace function module_on(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true'::jsonb from settings where key = p_key), false)
$$;

-- ---------------------------------------------------------------------------
-- Bar
-- ---------------------------------------------------------------------------
create table bar_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 40),
  sort int not null default 0,
  active boolean not null default true
);
create unique index bar_categories_name_uniq on bar_categories (lower(name));

create table bar_products (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references bar_categories on delete set null,
  name text not null check (char_length(trim(name)) between 2 and 80),
  description text check (description is null or char_length(description) <= 300),
  price int not null check (price >= 0),
  image_url text check (image_url is null or image_url ~ '^https://'),
  available boolean not null default true,
  track_stock boolean not null default false,
  stock_qty int not null default 0 check (stock_qty >= 0),
  low_stock_level int not null default 5 check (low_stock_level >= 0),
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index bar_products_name_uniq on bar_products (lower(name), coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid));
create trigger trg_bar_products_updated before update on bar_products for each row execute function set_updated_at();

create table bar_stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references bar_products on delete restrict,
  kind text not null check (kind in ('purchase','sale','adjustment','wastage')),
  qty int not null check (qty <> 0),                         -- signed: purchases +, sales and wastage -
  unit_cost int check (unit_cost is null or unit_cost >= 0),
  unit_price int check (unit_price is null or unit_price >= 0),
  booking_id uuid references bookings on delete set null,
  note text check (note is null or char_length(note) <= 200),
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  check ((kind = 'purchase' and qty > 0) or (kind in ('sale','wastage') and qty < 0) or kind = 'adjustment')
);
create index on bar_stock_movements (product_id, created_at desc);

alter table bar_categories enable row level security;
alter table bar_products enable row level security;
alter table bar_stock_movements enable row level security;
revoke insert, update, delete on bar_categories, bar_products from anon;
revoke all on bar_stock_movements from anon;
revoke insert, update, delete on bar_stock_movements from authenticated;       -- movements are written by the functions below only
-- Public menu: only while the module is on, and only available items.
create policy bar_cat_public on bar_categories for select to anon, authenticated using (active and module_on('module_bar_menu'));
create policy bar_prod_public on bar_products for select to anon, authenticated using (available and module_on('module_bar_menu'));
create policy bar_cat_staff on bar_categories for all to authenticated using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy bar_prod_staff on bar_products for all to authenticated using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy bar_moves_staff on bar_stock_movements for select to authenticated using (is_owner_or_manager((select auth.uid())));
create trigger trg_audit_bar_product after insert or update or delete on bar_products for each row execute function audit_generic('bar_product');

-- Stock can only change through the movement ledger (a direct edit of the number is refused).
create or replace function guard_stock_qty() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then new.stock_qty := 0;
  elsif new.stock_qty is distinct from old.stock_qty and pg_trigger_depth() < 2 then
    raise exception 'Record a purchase, wastage or adjustment to change stock.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_guard_stock before insert or update on bar_products for each row execute function guard_stock_qty();

-- stock follows the movements
create or replace function apply_stock_movement() returns trigger language plpgsql security definer set search_path = public as $$
declare p bar_products;
begin
  select * into p from bar_products where id = new.product_id for update;
  update bar_products set stock_qty = p.stock_qty + new.qty where id = p.id;       -- the CHECK (stock_qty >= 0) refuses overselling
  if p.track_stock and p.stock_qty > p.low_stock_level and p.stock_qty + new.qty <= p.low_stock_level then
    perform add_notification('low_stock', 'Low stock: ' || p.name, (p.stock_qty + new.qty) || ' left (alert level ' || p.low_stock_level || ')', '/admin/bar', null, gen_random_uuid());
  end if;
  return null;
end $$;
create trigger trg_apply_stock after insert on bar_stock_movements for each row execute function apply_stock_movement();

create or replace function record_stock_movement(p_product uuid, p_kind text, p_qty int, p_unit_cost int default null, p_note text default null) returns int
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); p bar_products; v_signed int;
begin
  perform require_permission('bar.manage');
  if not is_owner_or_manager(v_uid) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if not module_on('module_bar_stock') then raise exception 'Bar stock is switched off in Settings.' using errcode = 'check_violation'; end if;
  if p_kind not in ('purchase','wastage','adjustment') then raise exception 'Use the sale button to record sales.' using errcode = 'check_violation'; end if;
  select * into p from bar_products where id = p_product for update;
  if not found then raise exception 'Product not found' using errcode = 'no_data_found'; end if;
  if p_qty is null or p_qty = 0 then raise exception 'Enter a quantity.' using errcode = 'check_violation'; end if;
  v_signed := case p_kind when 'purchase' then abs(p_qty) when 'wastage' then -abs(p_qty) else p_qty end;
  if p.stock_qty + v_signed < 0 then raise exception 'Only % in stock.', p.stock_qty using errcode = 'check_violation'; end if;
  if p_kind = 'adjustment' and char_length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Say why the stock is being adjusted.' using errcode = 'check_violation'; end if;
  insert into bar_stock_movements(product_id, kind, qty, unit_cost, note, created_by) values (p_product, p_kind, v_signed, p_unit_cost, nullif(trim(coalesce(p_note, '')), ''), v_uid);
  return p.stock_qty + v_signed;
end $$;
grant execute on function record_stock_movement(uuid, text, int, int, text) to authenticated;

-- A sale: reduces stock (if tracked) and can be charged to a guest's booking.
create or replace function sell_bar_item(p_product uuid, p_qty int, p_booking uuid default null) returns int
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); p bar_products; b bookings;
begin
  perform require_permission('bar.manage');
  if not is_owner_or_manager(v_uid) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_qty is null or p_qty < 1 or p_qty > 500 then raise exception 'Enter a quantity from 1 to 500.' using errcode = 'check_violation'; end if;
  select * into p from bar_products where id = p_product for update;
  if not found or not p.available then raise exception 'That item is not available.' using errcode = 'check_violation'; end if;
  if p_booking is not null then
    select * into b from bookings where id = p_booking for update;
    if not found or not can_manage_property(v_uid, b.property_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
    if b.status not in ('confirmed','checked_in') then raise exception 'Charges can only go on a confirmed or checked-in stay.' using errcode = 'check_violation'; end if;
  end if;
  if p.track_stock then
    if not module_on('module_bar_stock') then raise exception 'Bar stock is switched off in Settings.' using errcode = 'check_violation'; end if;
    if p.stock_qty < p_qty then raise exception 'Only % in stock.', p.stock_qty using errcode = 'check_violation'; end if;
    insert into bar_stock_movements(product_id, kind, qty, unit_price, booking_id, created_by) values (p_product, 'sale', -p_qty, p.price, p_booking, v_uid);
  end if;
  if p_booking is not null and p.price * p_qty > 0 then
    insert into booking_charges(booking_id, label, amount, created_by) values (p_booking, left('Bar: ' || p.name || ' x' || p_qty, 80), p.price * p_qty, v_uid);
  end if;
  return p.price * p_qty;
end $$;
grant execute on function sell_bar_item(uuid, int, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Smart access
-- ---------------------------------------------------------------------------
create table smart_lock_devices (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties on delete cascade,
  unit_id uuid not null references units on delete cascade,
  label text not null check (char_length(trim(label)) between 2 and 60),
  provider text not null default 'manual' check (provider in ('manual','external')),   -- 'external' = needs an adapter + credentials (not shipped)
  external_id text check (external_id is null or char_length(external_id) <= 120),
  status text not null default 'unconfigured' check (status in ('unconfigured','online','offline','unknown')),
  last_seen_at timestamptz,
  battery_pct int check (battery_pct is null or battery_pct between 0 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index on smart_lock_devices (unit_id);

create table access_credentials (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings on delete cascade,
  device_id uuid not null references smart_lock_devices on delete restrict,
  kind text not null default 'pin' check (kind in ('pin')),
  pin_digest bytea not null,                         -- sha256(salt || pin); the PIN itself is never stored
  salt bytea not null,
  pin_hint text not null,                            -- last two digits, to tell codes apart
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  status text not null default 'pending' check (status in ('pending','provisioned','manual','failed','revoked','expired')),
  provider_ref text,
  revoked_reason text check (revoked_reason is null or char_length(revoked_reason) <= 200),
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  check (valid_until > valid_from)
);
create index on access_credentials (booking_id);
create index on access_credentials (device_id, valid_until);

create table access_logs (
  id bigint generated always as identity primary key,
  action text not null,
  device_id uuid references smart_lock_devices on delete set null,
  credential_id uuid references access_credentials on delete set null,
  booking_id uuid references bookings on delete set null,
  actor uuid references profiles on delete set null,
  detail text,
  created_at timestamptz not null default now()
);
create index on access_logs (created_at desc);

alter table smart_lock_devices enable row level security;
alter table access_credentials enable row level security;
alter table access_logs enable row level security;
revoke all on smart_lock_devices, access_credentials, access_logs from anon;
revoke insert, update, delete on access_credentials, access_logs from authenticated;
create policy lock_devices_read on smart_lock_devices for select to authenticated using (can_manage_property((select auth.uid()), property_id));
create policy lock_devices_write on smart_lock_devices for insert to authenticated with check (has_role((select auth.uid()), 'owner'));
create policy lock_devices_update on smart_lock_devices for update to authenticated using (has_role((select auth.uid()), 'owner')) with check (has_role((select auth.uid()), 'owner'));
-- the PIN digest and salt are never readable by logged-in users: expose a column-limited view of the safe fields
revoke select on access_credentials from authenticated;
grant select (id, booking_id, device_id, kind, pin_hint, valid_from, valid_until, status, provider_ref, revoked_reason, created_by, created_at) on access_credentials to authenticated;
create policy credentials_read on access_credentials for select to authenticated
  using (exists (select 1 from bookings b where b.id = booking_id and can_manage_property((select auth.uid()), b.property_id)));
create policy access_logs_read on access_logs for select to authenticated
  using (is_owner_or_manager((select auth.uid())) and (device_id is null or exists (select 1 from smart_lock_devices d where d.id = device_id and can_manage_property((select auth.uid()), d.property_id))));

-- Only a provider adapter (service role, no user session) may report device state.
create or replace function guard_device_state() returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and (new.status is distinct from old.status or new.last_seen_at is distinct from old.last_seen_at
      or new.battery_pct is distinct from old.battery_pct or new.external_id is distinct from old.external_id) then
    raise exception 'Device status comes from the lock provider and cannot be edited by hand' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_guard_device_state before update on smart_lock_devices for each row execute function guard_device_state();

create or replace function log_access(p_action text, p_device uuid, p_cred uuid, p_booking uuid, p_actor uuid, p_detail text) returns void
language sql security definer set search_path = public as $$
  insert into access_logs(action, device_id, credential_id, booking_id, actor, detail) values (p_action, p_device, p_cred, p_booking, p_actor, p_detail)
$$;
revoke execute on function log_access(text, uuid, uuid, uuid, uuid, text) from public, anon, authenticated;

create or replace function trg_log_device() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform log_access(case tg_op when 'INSERT' then 'device_added' else 'device_changed' end, new.id, null, null, auth.uid(), new.label || ' (' || new.provider || ')');
  return null;
end $$;
create trigger trg_log_device after insert or update on smart_lock_devices for each row execute function trg_log_device();

-- Issue a temporary PIN for a stay. Returns the PIN ONCE; only a salted digest is kept.
create or replace function issue_access_credential(p_booking uuid, p_device uuid, p_valid_from timestamptz default null, p_valid_until timestamptz default null)
returns table(credential_id uuid, pin text, status text, message text)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := (select auth.uid()); b bookings; d smart_lock_devices; v_pin text; v_salt bytea; v_from timestamptz; v_until timestamptz; v_id uuid; v_status text;
begin
  perform require_permission('access.manage');
  select * into b from bookings where id = p_booking for update;
  if not found or not can_manage_property(v_uid, b.property_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into d from smart_lock_devices where id = p_device and active;
  if not found or d.property_id <> b.property_id then raise exception 'Choose a lock at this property.' using errcode = 'check_violation'; end if;
  if d.unit_id <> b.unit_id then raise exception 'That lock belongs to a different room than this booking.' using errcode = 'check_violation'; end if;
  if b.status not in ('confirmed','checked_in') then raise exception 'Access can only be issued for a confirmed or checked-in stay.' using errcode = 'check_violation'; end if;
  if b.amount_paid < b.deposit_required then raise exception 'The deposit has not been received, so access cannot be issued yet.' using errcode = 'check_violation'; end if;
  if exists (select 1 from access_credentials c where c.booking_id = b.id and c.device_id = d.id and c.status in ('pending','provisioned','manual') and c.valid_until > now()) then
    raise exception 'This stay already has active access for that lock. Revoke it first.' using errcode = 'check_violation';
  end if;
  v_from := coalesce(p_valid_from, (b.check_in::timestamp + time '12:00') at time zone 'Africa/Nairobi');
  v_until := coalesce(p_valid_until, (b.check_out::timestamp + time '12:00') at time zone 'Africa/Nairobi');
  if v_until <= v_from or v_until <= now() then raise exception 'The access window must end in the future and after it starts.' using errcode = 'check_violation'; end if;
  if v_until > (b.check_out::timestamp + interval '1 day') at time zone 'Africa/Nairobi' then raise exception 'Access cannot run more than a day past check-out.' using errcode = 'check_violation'; end if;

  v_pin := lpad((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 1000000)::text, 6, '0');
  v_salt := sha256(convert_to(gen_random_uuid()::text, 'utf8'));
  -- A manual device has no provider to confirm anything: the code is only recorded, and staff must set it on the lock themselves.
  v_status := case when d.provider = 'manual' then 'manual' else 'pending' end;
  insert into access_credentials(booking_id, device_id, pin_digest, salt, pin_hint, valid_from, valid_until, status, created_by)
    values (b.id, d.id, sha256(v_salt || convert_to(v_pin, 'utf8')), v_salt, right(v_pin, 2), v_from, v_until, v_status, v_uid) returning id into v_id;
  perform log_access('credential_issued', d.id, v_id, b.id, v_uid, 'valid ' || to_char(v_from at time zone 'Africa/Nairobi', 'DD Mon HH24:MI') || ' to ' || to_char(v_until at time zone 'Africa/Nairobi', 'DD Mon HH24:MI') || ', status ' || v_status);
  return query select v_id, v_pin, v_status,
    case v_status when 'manual' then 'Code generated. This lock is not connected, so set this code on the lock yourself; the system has not programmed it.'
                  else 'Code generated. It is waiting for the lock provider to confirm; it has not been programmed yet.' end;
end $$;
grant execute on function issue_access_credential(uuid, uuid, timestamptz, timestamptz) to authenticated;

create or replace function revoke_access_credential(p_credential uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); c access_credentials; b bookings;
begin
  perform require_permission('access.manage');
  select * into c from access_credentials where id = p_credential for update;
  if not found then raise exception 'Access code not found' using errcode = 'no_data_found'; end if;
  select * into b from bookings where id = c.booking_id;
  if not can_manage_property(v_uid, b.property_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if c.status in ('revoked','expired') then return; end if;
  if char_length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason.' using errcode = 'check_violation'; end if;
  update access_credentials set status = 'revoked', revoked_reason = trim(p_reason) where id = p_credential;
  perform log_access('credential_revoked', c.device_id, c.id, c.booking_id, v_uid, trim(p_reason) || case when c.status = 'provisioned' then ' (the lock must also be told to remove the code)' else '' end);
end $$;
grant execute on function revoke_access_credential(uuid, text) to authenticated;

-- Provider adapters (service role only) report what the lock actually did. Nothing else can mark a code as programmed.
create or replace function confirm_credential_provisioned(p_credential uuid, p_ok boolean, p_provider_ref text default null, p_detail text default null) returns void
language plpgsql security definer set search_path = public as $$
declare c access_credentials;
begin
  select * into c from access_credentials where id = p_credential for update;
  if not found then raise exception 'Access code not found' using errcode = 'no_data_found'; end if;
  update access_credentials set status = case when p_ok then 'provisioned' else 'failed' end, provider_ref = p_provider_ref where id = p_credential and status = 'pending';
  perform log_access(case when p_ok then 'provision_confirmed' else 'provision_failed' end, c.device_id, c.id, c.booking_id, null, p_detail);
end $$;
revoke execute on function confirm_credential_provisioned(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function confirm_credential_provisioned(uuid, boolean, text, text) to service_role;

create or replace function expire_access_credentials() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; r record;
begin
  for r in update access_credentials set status = 'expired' where status in ('pending','provisioned','manual') and valid_until <= now() returning id, device_id, booking_id loop
    perform log_access('credential_expired', r.device_id, r.id, r.booking_id, null, null);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function expire_access_credentials() from public, anon, authenticated;
grant execute on function expire_access_credentials() to service_role;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('expire-access-credentials', '*/15 * * * *', 'select public.expire_access_credentials()');
  end if;
exception when others then null;
end $$;

-- ---------------------------------------------------------------------------
-- More notification kinds
-- ---------------------------------------------------------------------------
alter table notifications drop constraint if exists notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in ('booking_request','request_update','inquiry','review','payment','payment_review','cancellation','checkin_soon','checkout_today','balance_due',
  'low_stock','maintenance','housekeeping','ticket','message_failed','payment_verify'));

create or replace function trg_notify_more() returns trigger language plpgsql security definer set search_path = public as $$
declare v_unit text;
begin
  if tg_table_name = 'maintenance_requests' and tg_op = 'INSERT' then
    perform add_notification('maintenance', 'Maintenance: ' || new.title, new.priority || ' priority', '/admin/maintenance', new.property_id, new.id);
  elsif tg_table_name = 'housekeeping_tasks' and tg_op = 'INSERT' then
    select name into v_unit from units where id = new.unit_id;
    perform add_notification('housekeeping', 'Room to clean: ' || coalesce(v_unit, ''), case when new.priority then 'Same-day turnover' else null end, '/admin/housekeeping', new.property_id, new.id);
  elsif tg_table_name = 'support_tickets' and tg_op = 'INSERT' then
    perform add_notification('ticket', 'Ticket #' || new.ticket_no || ': ' || new.subject, new.priority || ' priority', '/admin/support', new.property_id, new.id);
  elsif tg_table_name = 'message_log' and new.status = 'failed' and (tg_op = 'INSERT' or old.status is distinct from 'failed') then
    perform add_notification('message_failed', 'Message not delivered', left(coalesce(new.error, 'Delivery failed'), 140), '/admin/messages', new.property_id, new.id);
  elsif tg_table_name = 'payments' and new.status = 'succeeded' and not new.verified and tg_op = 'INSERT' then
    perform add_notification('payment_verify', 'Payment to verify: KES ' || to_char(new.amount, 'FM999,999,999'), new.method::text, '/admin/finance', (select property_id from bookings where id = new.booking_id), new.id);
  end if;
  return null;
end $$;
create trigger trg_notify_maint  after insert on maintenance_requests for each row execute function trg_notify_more();
create trigger trg_notify_hk     after insert on housekeeping_tasks   for each row execute function trg_notify_more();
create trigger trg_notify_ticket after insert on support_tickets      for each row execute function trg_notify_more();
create trigger trg_notify_msg    after insert or update on message_log for each row execute function trg_notify_more();
create trigger trg_notify_verify after insert on payments             for each row execute function trg_notify_more();

$m0019$;
    raise notice 'Applied 0019';
  else
    raise notice '0019 already applied, skipped';
  end if;
  if to_regclass('public.permissions_catalog') is null then
    execute $m0020$
-- 0020_roles_permissions_login_cms.sql
-- 1. Team roles with granular permissions, enforced in the database:
--      * has_permission / require_permission, used inside the sensitive functions and as RESTRICTIVE row-level policies;
--      * nine system roles (Super Administrator, Property Owner, Property Manager, Receptionist, Booking Manager, Accountant,
--        Housekeeping, Maintenance Staff, Marketing Manager) and custom roles built from the permission catalogue;
--      * every role maps to a base role (owner / manager / cleaner) so the existing property-scoped policies keep working;
--      * a user without a team role gets the default for their base role, so nothing changes for existing staff.
-- 2. Login events (including failed attempts), recorded without exposing passwords.
-- 3. Website content drafts and published versions.

create table permissions_catalog (
  key text primary key check (key ~ '^[a-z_]+\.[a-z_]+$'),
  module text not null,
  label text not null,
  sort int not null default 0
);
insert into permissions_catalog(key, module, label, sort) values
  ('dashboard.view','Dashboard','View the dashboard',1),
  ('bookings.view','Bookings','View reservations',10), ('bookings.create','Bookings','Create bookings',11), ('bookings.manage','Bookings','Modify, reschedule and cancel bookings',12),
  ('requests.manage','Bookings','Approve or reject booking requests',13), ('inquiries.manage','Bookings','Handle guest inquiries',14),
  ('checkin.manage','Front desk','Check guests in and out',20), ('blocked.manage','Front desk','Block and release dates',21), ('rooms.manage','Front desk','Update room status',22),
  ('guests.view','Guests','View guest profiles',30), ('guests.manage','Guests','Edit guest profiles',31), ('credit.manage','Guests','Manage guest credit',32),
  ('housekeeping.view','Housekeeping','View assigned rooms and cleaning tasks',40), ('housekeeping.update','Housekeeping','Update cleaning status',41), ('housekeeping.manage','Housekeeping','Create, assign and verify cleaning tasks',42),
  ('maintenance.report','Maintenance','Report maintenance issues',50), ('maintenance.update','Maintenance','Update assigned maintenance work',51), ('maintenance.manage','Maintenance','Assign and close maintenance requests',52),
  ('listings.manage','Listings','Create and edit properties, rooms and prices',60), ('media.manage','Website','Manage the media library, gallery and banners',61),
  ('cms.manage','Website','Edit and publish website content, reviews and announcements',62), ('marketing.manage','Website','Manage discount codes and campaigns',63),
  ('support.manage','Support','Handle support tickets',70),
  ('finance.view','Finance','View payments and financial figures',80), ('payments.record','Finance','Record payments and refunds',81), ('payments.verify','Finance','Verify payments',82),
  ('expenses.manage','Finance','Enter and edit expenses',83), ('expenses.approve','Finance','Approve expenses',84),
  ('reports.view','Reports','View and export reports',90), ('owner.overview','Reports','Open the owner overview',91),
  ('bar.manage','Services','Manage the bar menu and stock',100), ('access.manage','Services','Issue and revoke smart access codes',101), ('comms.manage','Services','Send and manage guest messages',102),
  ('users.manage','System','Manage staff accounts',110), ('roles.manage','System','Manage team roles and permissions',111), ('settings.manage','System','Change site settings',112), ('audit.view','System','View the activity log',113);

create table team_roles (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 3 and 40),
  description text check (description is null or char_length(description) <= 200),
  base_role app_role not null,
  is_system boolean not null default false,
  default_for app_role,                              -- the role given to staff who have no team role yet
  created_at timestamptz not null default now(),
  check (is_system or base_role <> 'owner')         -- only the built-in Super Administrator has owner-level database access
);
create unique index team_roles_name_uniq on team_roles (lower(name));
create unique index team_roles_default_uniq on team_roles (default_for) where default_for is not null;
create table team_role_permissions (
  role_id uuid not null references team_roles on delete cascade,
  permission_key text not null references permissions_catalog on delete cascade,
  primary key (role_id, permission_key)
);
alter table profiles add column team_role_id uuid references team_roles on delete restrict;
create index on profiles (team_role_id) where team_role_id is not null;

do $seed$
declare r record; v_id uuid;
begin
  for r in select * from (values
    ('Super Administrator','Full access to everything.','owner'::app_role,null::app_role, array['*']),
    ('Property Owner','Business overview, finance and performance for their properties, without day-to-day editing.','manager',null, array['dashboard.view','bookings.view','guests.view','finance.view','reports.view','owner.overview','housekeeping.view']),
    ('Property Manager','Runs day-to-day operations: bookings, guests, rooms, housekeeping, maintenance, listings and operational reports.','manager','manager',
       array['dashboard.view','bookings.view','bookings.create','bookings.manage','requests.manage','inquiries.manage','checkin.manage','blocked.manage','rooms.manage','guests.view','guests.manage','credit.manage','housekeeping.view','housekeeping.update','housekeeping.manage','maintenance.report','maintenance.update','maintenance.manage','listings.manage','media.manage','cms.manage','marketing.manage','support.manage','finance.view','payments.record','expenses.manage','reports.view','bar.manage','access.manage','comms.manage']),
    ('Receptionist','Reservations, check-in and check-out, guest inquiries and taking payments at the desk.','manager',null,
       array['dashboard.view','bookings.view','bookings.create','inquiries.manage','requests.manage','checkin.manage','guests.view','guests.manage','payments.record','housekeeping.view','maintenance.report','comms.manage']),
    ('Booking Manager','Owns reservations, requests, inquiries, blocked dates and guest records.','manager',null,
       array['dashboard.view','bookings.view','bookings.create','bookings.manage','requests.manage','inquiries.manage','checkin.manage','blocked.manage','rooms.manage','guests.view','guests.manage','credit.manage','payments.record','reports.view','comms.manage']),
    ('Accountant','Financial reports, recording and verifying payments, expenses and reconciliation.','manager',null,
       array['dashboard.view','bookings.view','guests.view','finance.view','payments.record','payments.verify','expenses.manage','expenses.approve','reports.view']),
    ('Housekeeping','Sees assigned rooms and cleaning tasks, updates cleaning status and reports issues.','cleaner','cleaner',
       array['housekeeping.view','housekeeping.update','maintenance.report','maintenance.update']),
    ('Maintenance Staff','Reports and works on maintenance requests assigned to them.','cleaner',null,
       array['housekeeping.view','maintenance.report','maintenance.update']),
    ('Marketing Manager','Website content, media, reviews, promotions and listing text.','manager',null,
       array['dashboard.view','bookings.view','media.manage','cms.manage','marketing.manage','reports.view','comms.manage'])
  ) as t(name, descr, base, def, perms) loop
    insert into team_roles(name, description, base_role, is_system, default_for) values (r.name, r.descr, r.base, true, r.def) returning id into v_id;
    if r.perms = array['*'] then
      insert into team_role_permissions(role_id, permission_key) select v_id, key from permissions_catalog;
    else
      insert into team_role_permissions(role_id, permission_key) select v_id, unnest(r.perms);
    end if;
  end loop;
end $seed$;

-- ---- checks used everywhere ---------------------------------------------------------------------------------------
create or replace function has_permission(_uid uuid, _perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when _uid is null then false
    when not exists (select 1 from profiles p where p.id = _uid and p.active) then false
    when has_role(_uid, 'owner') then true
    else exists (
      select 1 from team_role_permissions rp
      where rp.permission_key = _perm
        and rp.role_id = coalesce(
          (select p.team_role_id from profiles p where p.id = _uid),
          (select tr.id from team_roles tr where tr.default_for = case when has_role(_uid, 'manager') then 'manager'::app_role when has_role(_uid, 'cleaner') then 'cleaner'::app_role end)))
  end
$$;
grant execute on function has_permission(uuid, text) to authenticated;

create or replace function require_permission(_perm text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_permission((select auth.uid()), _perm) then
    raise exception 'You do not have permission to do this.' using errcode = '42501';
  end if;
end $$;
grant execute on function require_permission(text) to authenticated;

-- What can the signed-in person do? (drives the menu; the database still enforces every action)
create or replace function my_permissions() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(c.key order by c.key), '{}') from permissions_catalog c where has_permission((select auth.uid()), c.key)
$$;
grant execute on function my_permissions() to authenticated;

-- ---- tables: RLS --------------------------------------------------------------------------------------------------
alter table permissions_catalog enable row level security;
alter table team_roles enable row level security;
alter table team_role_permissions enable row level security;
revoke all on permissions_catalog, team_roles, team_role_permissions from anon;
create policy catalog_read on permissions_catalog for select to authenticated using (is_staff((select auth.uid())));
create policy roles_read on team_roles for select to authenticated using (is_staff((select auth.uid())));
create policy role_perms_read on team_role_permissions for select to authenticated using (is_staff((select auth.uid())));
create policy roles_write on team_roles for all to authenticated
  using (has_permission((select auth.uid()), 'roles.manage')) with check (has_permission((select auth.uid()), 'roles.manage'));
create policy role_perms_write on team_role_permissions for all to authenticated
  using (has_permission((select auth.uid()), 'roles.manage')) with check (has_permission((select auth.uid()), 'roles.manage'));
create trigger trg_audit_team_role  after insert or update or delete on team_roles for each row execute function audit_generic('team_role');
create trigger trg_audit_role_perm  after insert or delete on team_role_permissions for each row execute function audit_generic('team_role_permission');

-- Built-in roles cannot be edited or deleted (clone one to customise it). The audit trigger above records every change.
create or replace function guard_system_roles() returns trigger language plpgsql as $$
declare v_role uuid;
begin
  if tg_table_name = 'team_roles' then
    if tg_op = 'DELETE' then v_role := old.id; else v_role := new.id; end if;
  else
    if tg_op = 'DELETE' then v_role := old.role_id; else v_role := new.role_id; end if;
  end if;
  if auth.uid() is not null and exists (select 1 from team_roles r where r.id = v_role and r.is_system) then
    raise exception 'Built-in roles cannot be changed. Create a custom role instead.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger trg_guard_roles before update or delete on team_roles for each row execute function guard_system_roles();
create trigger trg_guard_role_perms before insert or delete on team_role_permissions for each row execute function guard_system_roles();

-- Assign a team role. Keeps the base role (which the existing policies read) in step, protects the last owner.
create or replace function assign_team_role(p_user uuid, p_role uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); r team_roles; v_owners int;
begin
  if not has_permission(v_uid, 'users.manage') then raise exception 'You do not have permission to do this.' using errcode = '42501'; end if;
  select * into r from team_roles where id = p_role;
  if not found then raise exception 'Role not found' using errcode = 'no_data_found'; end if;
  if p_user = v_uid then raise exception 'You cannot change your own role.' using errcode = 'check_violation'; end if;
  if r.base_role = 'owner' and not has_role(v_uid, 'owner') then raise exception 'Only an owner can make another owner.' using errcode = '42501'; end if;
  if has_role(p_user, 'owner') and r.base_role <> 'owner' then
    select count(*) into v_owners from user_roles ur join profiles p on p.id = ur.user_id where ur.role = 'owner' and p.active;
    if v_owners <= 1 then raise exception 'There must always be at least one owner.' using errcode = 'check_violation'; end if;
  end if;
  update profiles set team_role_id = p_role where id = p_user;
  if not found then raise exception 'User not found' using errcode = 'no_data_found'; end if;
  delete from user_roles where user_id = p_user;
  insert into user_roles(user_id, role) values (p_user, r.base_role);
  insert into audit_log(user_id, action, entity, entity_id, diff) values (v_uid, 'staff.role_assigned', 'staff', p_user::text, jsonb_build_object('role', r.name, 'base', r.base_role));
end $$;
grant execute on function assign_team_role(uuid, uuid) to authenticated;

-- ---- restrictive policies: a permission is required IN ADDITION to the existing property-scoped access ------------
do $pol$
declare r record; v_expr text; v_name text;
begin
  for r in select * from (values
    ('payments','insert', array['payments.record']), ('payments','select', array['finance.view','bookings.view','checkin.manage']),
    ('expenses','select', array['finance.view']), ('expenses','insert', array['expenses.manage']), ('expenses','update', array['expenses.manage','expenses.approve']),
    ('bookings','insert', array['bookings.create']), ('bookings','update', array['bookings.manage']),
    ('guests','update', array['guests.manage']),
    ('housekeeping_tasks','insert', array['housekeeping.manage']), ('housekeeping_tasks','delete', array['housekeeping.manage']), ('housekeeping_tasks','update', array['housekeeping.update','housekeeping.manage']),
    ('properties','insert', array['listings.manage']), ('properties','update', array['listings.manage']), ('properties','delete', array['listings.manage']),
    ('units','insert', array['listings.manage','rooms.manage']), ('units','update', array['listings.manage','rooms.manage']), ('units','delete', array['listings.manage']),
    ('rate_overrides','insert', array['listings.manage']), ('rate_overrides','update', array['listings.manage']), ('rate_overrides','delete', array['listings.manage']),
    ('inquiries','insert', array['inquiries.manage']), ('inquiries','update', array['inquiries.manage']), ('inquiries','delete', array['inquiries.manage']),
    ('inquiry_notes','insert', array['inquiries.manage']), ('inquiry_notes','update', array['inquiries.manage']), ('inquiry_notes','delete', array['inquiries.manage']),
    ('reviews','insert', array['cms.manage']), ('reviews','update', array['cms.manage']), ('reviews','delete', array['cms.manage']),
    ('announcements','insert', array['cms.manage']), ('announcements','update', array['cms.manage']), ('announcements','delete', array['cms.manage']),
    ('gallery_categories','insert', array['media.manage']), ('gallery_categories','update', array['media.manage']), ('gallery_categories','delete', array['media.manage']),
    ('gallery_items','insert', array['media.manage']), ('gallery_items','update', array['media.manage']), ('gallery_items','delete', array['media.manage']),
    ('homepage_banners','insert', array['media.manage']), ('homepage_banners','update', array['media.manage']), ('homepage_banners','delete', array['media.manage']),
    ('media_assets','insert', array['media.manage']), ('media_assets','update', array['media.manage']), ('media_assets','delete', array['media.manage']),
    ('discount_codes','insert', array['marketing.manage']), ('discount_codes','update', array['marketing.manage']), ('discount_codes','delete', array['marketing.manage']),
    ('support_tickets','insert', array['support.manage']), ('support_tickets','update', array['support.manage']), ('support_tickets','delete', array['support.manage']),
    ('support_ticket_messages','insert', array['support.manage']),
    ('maintenance_requests','insert', array['maintenance.report','maintenance.manage']), ('maintenance_requests','update', array['maintenance.manage','maintenance.update']), ('maintenance_requests','delete', array['maintenance.manage']),
    ('booking_requests','update', array['requests.manage']), ('booking_request_notes','insert', array['requests.manage']),
    ('bar_categories','insert', array['bar.manage']), ('bar_categories','update', array['bar.manage']), ('bar_categories','delete', array['bar.manage']),
    ('bar_products','insert', array['bar.manage']), ('bar_products','update', array['bar.manage']), ('bar_products','delete', array['bar.manage']),
    ('guest_credit_entries','select', array['credit.manage','finance.view','guests.view'])
  ) as t(tbl, cmd, perms) loop
    continue when to_regclass('public.' || r.tbl) is null;
    select string_agg(format('has_permission((select auth.uid()), %L)', p), ' or ') into v_expr from unnest(r.perms) p;
    v_name := 'perm_' || r.tbl || '_' || r.cmd;
    if r.cmd = 'insert' then
      execute format('create policy %I on %I as restrictive for insert to authenticated with check (%s)', v_name, r.tbl, v_expr);
    elsif r.cmd = 'update' then
      execute format('create policy %I on %I as restrictive for update to authenticated using (%s) with check (%s)', v_name, r.tbl, v_expr, v_expr);
    else
      execute format('create policy %I on %I as restrictive for %s to authenticated using (%s)', v_name, r.tbl, r.cmd, v_expr);
    end if;
  end loop;
end $pol$;

-- ---------------------------------------------------------------------------
-- Login events
-- ---------------------------------------------------------------------------
create table login_events (
  id bigint generated always as identity primary key,
  user_id uuid references profiles on delete set null,
  email text not null check (char_length(email) <= 160),
  success boolean not null,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index on login_events (created_at desc);
create index on login_events (email, created_at desc);
alter table login_events enable row level security;
revoke all on login_events from anon;
revoke insert, update, delete on login_events from authenticated;
create policy login_events_read on login_events for select to authenticated using (has_permission((select auth.uid()), 'audit.view'));

-- Called by the login page. A failed attempt comes from an anonymous browser, so it is throttled; a success is tied to the real session user.
create or replace function record_login_event(p_email text, p_success boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := (select auth.uid()); v_email text := lower(left(trim(coalesce(p_email, '')), 160)); n int; v_h json;
begin
  if v_email = '' then return; end if;
  if p_success and v_uid is null then return; end if;                      -- cannot claim a success without a session
  select count(*) into n from rate_limit_events where key = 'login:' || v_email and created_at > now() - interval '1 hour';
  if n >= 30 then return; end if;
  select count(*) into n from rate_limit_events where key = 'login:all' and created_at > now() - interval '1 hour';
  if n >= 600 then return; end if;
  insert into rate_limit_events(key) values ('login:' || v_email), ('login:all');
  begin v_h := current_setting('request.headers', true)::json; exception when others then v_h := null; end;
  insert into login_events(user_id, email, success, ip, user_agent)
    values (case when p_success then v_uid end, v_email, p_success, left(split_part(coalesce(v_h->>'x-forwarded-for', ''), ',', 1), 64), left(v_h->>'user-agent', 200));
end $$;
grant execute on function record_login_event(text, boolean) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Website content: drafts, published versions
-- ---------------------------------------------------------------------------
create table site_content_versions (
  id uuid primary key default gen_random_uuid(),
  content jsonb not null,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  note text check (note is null or char_length(note) <= 200),
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  check (jsonb_typeof(content) = 'object' and pg_column_size(content) < 200000)
);
create index on site_content_versions (created_at desc);
alter table site_content_versions enable row level security;
revoke all on site_content_versions from anon;
revoke update, delete on site_content_versions from authenticated;
create policy scv_read on site_content_versions for select to authenticated using (has_permission((select auth.uid()), 'cms.manage'));
create policy scv_insert on site_content_versions for insert to authenticated
  with check (has_permission((select auth.uid()), 'cms.manage') and status = 'draft' and created_by = (select auth.uid()));

-- Publishing copies a version into the live setting. Only this function can do that (the settings table stays owner-only).
create or replace function publish_site_content(p_version uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); v site_content_versions;
begin
  if not has_permission(v_uid, 'cms.manage') then raise exception 'You do not have permission to do this.' using errcode = '42501'; end if;
  select * into v from site_content_versions where id = p_version for update;
  if not found then raise exception 'Version not found' using errcode = 'no_data_found'; end if;
  update site_content_versions set status = 'archived' where status = 'published';
  update site_content_versions set status = 'published', published_at = now() where id = p_version;
  insert into settings(key, value, updated_at) values ('site_content', v.content, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  insert into audit_log(user_id, action, entity, entity_id) values (v_uid, 'site_content.published', 'site_content', p_version::text);
end $$;
grant execute on function publish_site_content(uuid) to authenticated;

-- The activity log can be shared with anyone given the "View the activity log" permission (the owner always has it).
create policy audit_perm_read on audit_log for select to authenticated using (has_permission((select auth.uid()), 'audit.view'));

$m0020$;
    raise notice 'Applied 0020';
  else
    raise notice '0020 already applied, skipped';
  end if;
  if to_regprocedure('public.global_search(text)') is null then
    execute $m0021$
-- 0021_global_search.sql
-- One search box for the admin header. SECURITY INVOKER, so every result is limited by the caller's own row-level access
-- (a manager only finds records from their properties; housekeeping finds nothing about guests or money).

create or replace function global_search(p_q text) returns jsonb
language plpgsql stable security invoker as $$
declare
  q text := trim(coalesce(p_q, '')); pat text; digits text; v_book jsonb; v_guest jsonb; v_room jsonb; v_inq jsonb; v_tick jsonb;
begin
  if char_length(q) < 2 then return jsonb_build_object('bookings', '[]'::jsonb, 'guests', '[]'::jsonb, 'rooms', '[]'::jsonb, 'inquiries', '[]'::jsonb, 'tickets', '[]'::jsonb); end if;
  if char_length(q) > 60 then q := left(q, 60); end if;
  pat := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  digits := regexp_replace(q, '\D', '', 'g');
  if digits like '0%' then digits := '254' || substr(digits, 2); end if;

  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_book from (
    select jsonb_build_object('id', b.id, 'reference', b.reference, 'guest', g.full_name, 'status', b.status, 'check_in', b.check_in) x
    from bookings b left join guests g on g.id = b.guest_id
    where b.status <> 'blocked' and (b.reference ilike pat or g.full_name ilike pat or (char_length(digits) >= 4 and g.phone like '%' || digits || '%'))
    order by b.created_at desc limit 6) t;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_guest from (
    select jsonb_build_object('id', g.id, 'name', g.full_name, 'phone', g.phone) x from guests g
    where g.anonymised_at is null and (g.full_name ilike pat or g.email ilike pat or (char_length(digits) >= 4 and g.phone like '%' || digits || '%'))
    order by g.full_name limit 6) t;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_room from (
    select jsonb_build_object('id', u.id, 'name', u.name, 'property', p.name, 'property_id', p.id) x
    from units u join properties p on p.id = u.property_id
    where (u.name ilike pat or p.name ilike pat) and can_manage_property((select auth.uid()), p.id)
    order by p.name, u.name limit 6) t;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_inq from (
    select jsonb_build_object('id', i.id, 'name', i.name, 'status', i.status) x from inquiries i
    where i.name ilike pat or i.message ilike pat or (char_length(digits) >= 4 and i.phone like '%' || digits || '%')
    order by i.created_at desc limit 5) t;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_tick from (
    select jsonb_build_object('id', s.id, 'ticket_no', s.ticket_no, 'subject', s.subject, 'status', s.status) x from support_tickets s
    where s.subject ilike pat or (q ~ '^#?\d+$' and s.ticket_no = regexp_replace(q, '\D', '', 'g')::int)
    order by s.created_at desc limit 5) t;
  return jsonb_build_object('bookings', v_book, 'guests', v_guest, 'rooms', v_room, 'inquiries', v_inq, 'tickets', v_tick);
end $$;
grant execute on function global_search(text) to authenticated;

$m0021$;
    raise notice 'Applied 0021';
  else
    raise notice '0021 already applied, skipped';
  end if;
end
$apply$;
