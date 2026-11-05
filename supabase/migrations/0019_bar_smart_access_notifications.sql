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
