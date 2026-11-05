-- =====================================================================================
-- RG Wings Stays: ALL THE SQL IN ONE FILE (safe to run more than once).
-- Supabase dashboard > SQL Editor > a NEW empty query tab > paste everything > Run.
--
-- BEFORE YOU PRESS RUN:  check the project name at the top-left. It must be "bnb-system".
--   1. Replace PASTE-YOUR-REAL-SERVICE-ROLE-KEY-HERE (in STEP 3 below) with your service_role key
--      (Project Settings > API Keys > the secret one). Never share it or commit it.
--      If you leave it as is, STEP 3 is skipped with a notice and everything else still runs.
--   2. Nothing else to edit.
--
-- What it does, in order:
--   STEP 0  Safety check: refuses to run in another app's project (one with orders / products tables).
--   STEP 1  Installs the database (migrations 0001 to 0006), but ONLY if it is not installed yet.
--           On bnb-system it is already installed, so this step is skipped by itself.
--   STEP 3  Stores the two secrets the scheduled jobs need (updates them if they already exist).
--   STEP 4  Removes the E2E test property / bookings / test guest if they exist.
--   STEP 5  Prints a check. Both rows should say true.
-- =====================================================================================

-- STEP 0: wrong-project guard
do $guard$
begin
  if to_regclass('public.orders') is not null or to_regclass('public.products') is not null then
    raise exception 'STOP: this looks like a DIFFERENT app (it has orders/products tables). Open the bnb-system project and try again. Nothing was changed.';
  end if;
end
$guard$;

-- STEP 1: install the database only if it is not there yet
do $install$
begin
  if to_regclass('public.bookings') is not null then
    raise notice 'STEP 1 skipped: the RG Wings tables already exist in this project.';
    return;
  end if;
  if to_regclass('public.settings') is not null or to_regclass('public.payments') is not null or to_regclass('public.audit_log') is not null then
    raise exception 'STOP: this project already has tables named settings/payments/audit_log from something else. Use a new empty project. Nothing was changed.';
  end if;
    -- ---- 0001_schema.sql ----
    execute $mig1$
-- 0001_schema.sql: core tables, enums, constraints.
-- All money is integer KES. Dates are `date` (no timezone drift). Timestamps are timestamptz.
-- Changes vs the baseline spec DDL (intent unchanged):
--   * nairobi_today() used for "today" defaults (the DB runs in UTC)
--   * bookings.payment_review / review_reason (late-payment and amount-mismatch flags, rule 7.8)
--   * housekeeping_tasks.priority (same-day turnover, rule 7.12)
--   * message_log.property_id (so managers can be scoped by property)
--   * expenses.voided (expenses are voided, not deleted, by managers)
--   * guests.anonymised_at (Kenya DPA delete tool)
--   * rate_limit_events (public endpoint throttling)

create extension if not exists btree_gist;
create extension if not exists pgcrypto;

create type app_role       as enum ('owner','manager','cleaner');
create type booking_status as enum ('pending','confirmed','checked_in','checked_out','cancelled','expired','no_show','blocked');
create type booking_source as enum ('website','whatsapp','walk_in','phone','manual');
create type payment_kind   as enum ('deposit','balance','full','refund','adjustment');
create type payment_method as enum ('mpesa_stk','mpesa_manual','cash','bank','other');
create type payment_status as enum ('pending','succeeded','failed','cancelled');
create type task_status    as enum ('dirty','in_progress','clean','inspected');

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- "Today" in Nairobi. The database clock is UTC; never use current_date for business logic.
create or replace function nairobi_today() returns date language sql stable as $$
  select (now() at time zone 'Africa/Nairobi')::date
$$;

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text not null,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table user_roles (
  user_id uuid not null references profiles on delete cascade,
  role app_role not null,
  primary key (user_id, role)
);

create table properties (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  tagline text,
  description text,
  address text,
  area text,
  city text not null default 'Nairobi',
  lat numeric(9,6), lng numeric(9,6),
  contact_phone text,
  whatsapp_number text,              -- 2547XXXXXXXX, used for wa.me links
  check_in_time time not null default '14:00',
  check_out_time time not null default '10:00',
  house_rules text,
  amenities text[] not null default '{}',
  cover_image text,
  gallery text[] not null default '{}',
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_properties_updated before update on properties for each row execute function set_updated_at();

create table staff_properties (
  user_id uuid not null references profiles on delete cascade,
  property_id uuid not null references properties on delete cascade,
  primary key (user_id, property_id)
);

create table units (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties on delete cascade,
  name text not null,
  code text,
  unit_type text not null default 'room',      -- room | studio | 1BR | 2BR | house
  description text,
  max_guests int not null default 2,
  bedrooms int not null default 1,
  beds int not null default 1,
  base_rate int not null check (base_rate >= 0),
  weekend_rate int check (weekend_rate >= 0),  -- applies to Fri + Sat nights
  cleaning_fee int not null default 0 check (cleaning_fee >= 0),
  min_nights int not null default 1 check (min_nights >= 1),
  amenities text[] not null default '{}',
  images text[] not null default '{}',
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on units (property_id);
create trigger trg_units_updated before update on units for each row execute function set_updated_at();

create table rate_overrides (               -- seasonal / holiday pricing
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references units on delete cascade,
  label text,
  start_date date not null,
  end_date date not null,                   -- inclusive
  nightly_rate int not null check (nightly_rate >= 0),
  created_at timestamptz not null default clock_timestamp(),   -- newest override wins on overlap
  check (end_date >= start_date)
);
create index on rate_overrides (unit_id, start_date);

create table guests (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text unique not null,               -- normalized 2547XXXXXXXX
  email text,
  id_number text,                           -- optional; owner/manager only
  notes text,
  anonymised_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_guests_updated before update on guests for each row execute function set_updated_at();

create sequence booking_seq start 1;
create or replace function next_booking_reference() returns text language sql as $$
  select 'BNB-' || to_char(now() at time zone 'Africa/Nairobi','YYMM') || '-' || lpad(nextval('booking_seq')::text, 4, '0')
$$;

create table bookings (
  id uuid primary key default gen_random_uuid(),
  reference text unique not null default next_booking_reference(),
  public_token uuid unique not null default gen_random_uuid(),   -- guest self-service link
  property_id uuid not null references properties,
  unit_id uuid not null references units,
  guest_id uuid references guests,                              -- null for blocked dates
  check_in date not null,
  check_out date not null,
  nights int generated always as (check_out - check_in) stored,
  num_guests int not null default 1 check (num_guests >= 1),
  status booking_status not null default 'pending',
  source booking_source not null default 'website',
  nightly_total int not null default 0,
  cleaning_fee int not null default 0,
  discount int not null default 0 check (discount >= 0),
  total_amount int not null default 0,
  deposit_required int not null default 0,
  amount_paid int not null default 0,                           -- maintained by trigger
  hold_expires_at timestamptz,                                  -- set for pending website bookings
  payment_review boolean not null default false,                -- "Payment needs review" (rule 7.8)
  review_reason text,
  notes text,
  cancelled_at timestamptz,
  cancel_reason text,
  created_by uuid references profiles,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (check_out > check_in),
  check (status <> 'blocked' or guest_id is null),
  -- THE double-booking guard. Nothing else may be relied on for this.
  -- check_in inclusive, check_out exclusive ('[)') so back-to-back stays are allowed.
  -- Only "live" statuses occupy a unit; cancelled / expired / no_show / checked_out free the dates.
  constraint no_overlapping_bookings exclude using gist (
    unit_id with =,
    daterange(check_in, check_out, '[)') with &&
  ) where (status in ('pending','confirmed','checked_in','blocked'))
);
create index on bookings (property_id, check_in);
create index on bookings (guest_id);
create index on bookings (status, hold_expires_at);
create index on bookings (unit_id, check_in);
create trigger trg_bookings_updated before update on bookings for each row execute function set_updated_at();

create table payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings on delete cascade,
  kind payment_kind not null,
  method payment_method not null,
  status payment_status not null default 'pending',
  amount int not null check (amount > 0),
  phone text,                               -- payer, normalized
  mpesa_receipt text,
  merchant_request_id text,
  checkout_request_id text unique,
  result_code int,
  result_desc text,
  raw jsonb,                                -- raw Daraja callback, for audit
  recorded_by uuid references profiles,     -- null for automatic STK
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);
create index on payments (booking_id);
create index on payments (status, created_at);
-- Idempotency: a replayed callback / double-entered receipt can never credit twice.
create unique index payments_receipt_uniq on payments (mpesa_receipt) where mpesa_receipt is not null;

create table housekeeping_tasks (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties on delete cascade,
  unit_id uuid not null references units on delete cascade,
  booking_id uuid references bookings on delete set null,
  status task_status not null default 'dirty',
  priority boolean not null default false,  -- same-day turnover
  assigned_to uuid references profiles,
  due_date date not null default nairobi_today(),
  notes text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on housekeeping_tasks (property_id, status);
create index on housekeeping_tasks (unit_id, status);
create trigger trg_hk_updated before update on housekeeping_tasks for each row execute function set_updated_at();

create table expenses (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties on delete cascade,
  category text not null,                   -- utilities|cleaning|repairs|staff|internet|supplies|marketing|other
  amount int not null check (amount > 0),
  expense_date date not null default nairobi_today(),
  description text,
  paid_via payment_method default 'cash',
  receipt_url text,
  voided boolean not null default false,
  created_by uuid references profiles,
  created_at timestamptz not null default now()
);
create index on expenses (property_id, expense_date);

create table message_log (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references bookings on delete set null,
  guest_id uuid references guests on delete set null,
  property_id uuid references properties on delete set null,
  channel text not null default 'whatsapp',
  template text not null,                   -- booking_confirmed | payment_receipt | balance_reminder | checkin_reminder | thank_you | custom
  to_phone text not null,
  body text,
  status text not null default 'queued',    -- queued | sent | delivered | read | failed | skipped
  provider_id text,
  error text,
  created_at timestamptz not null default now()
);
create index on message_log (booking_id, template);
create index on message_log (provider_id);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into settings(key,value) values
  ('deposit_percent','50'), ('hold_minutes','15'), ('business_name','"Your BNB Brand"'),
  ('cancellation_policy','"Free cancellation up to 48 hours before check-in. The deposit is non-refundable after that."'),
  ('reminder_days_before','1'), ('balance_reminder_days_before','2'),
  ('logo_url','""'), ('support_whatsapp','""'),
  ('default_check_in_time','"14:00"'), ('default_check_out_time','"10:00"'),
  ('whatsapp_enabled','false'),
  ('mpesa_manual_instructions','"Pay to the Paybill/Till shown below, using your booking reference as the account number."'),
  ('mpesa_paybill_display','""'), ('owner_notify_phone','""');

create table audit_log (
  id bigint generated always as identity primary key,
  user_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  diff jsonb,
  created_at timestamptz not null default now()
);
create index on audit_log (created_at desc);
create index on audit_log (user_id, created_at desc);
create index on audit_log (entity, entity_id);

-- Throttling for public endpoints (create-booking, mpesa-stk-push). Service role only.
create table rate_limit_events (
  id bigint generated always as identity primary key,
  key text not null,
  created_at timestamptz not null default now()
);
create index on rate_limit_events (key, created_at desc);

$mig1$;

    -- ---- 0002_functions.sql ----
    execute $mig2$
-- 0002_functions.sql: pricing, availability, payments->booking triggers, booking RPCs, audit, reporting.

-- ---------------------------------------------------------------------------
-- Role helpers (used by RLS). A deactivated profile has NO roles, so every
-- policy built on these helpers blocks the user (rule: deactivated => blocked).
-- ---------------------------------------------------------------------------
create or replace function has_role(_uid uuid, _role app_role) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from user_roles ur join profiles p on p.id = ur.user_id
    where ur.user_id = _uid and ur.role = _role and p.active)
$$;

create or replace function is_staff(_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from user_roles ur join profiles p on p.id = ur.user_id
    where ur.user_id = _uid and p.active)
$$;

create or replace function can_access_property(_uid uuid, _pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_role(_uid,'owner')
      or (is_staff(_uid) and exists(select 1 from staff_properties where user_id=_uid and property_id=_pid))
$$;

-- Owner or a manager assigned to the property (cleaners excluded).
create or replace function can_manage_property(_uid uuid, _pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_role(_uid,'owner')
      or (has_role(_uid,'manager') and exists(select 1 from staff_properties where user_id=_uid and property_id=_pid))
$$;

-- ---------------------------------------------------------------------------
-- Pricing. The client is NEVER trusted for prices.
-- Priority: seasonal override > weekend rate (Fri+Sat nights) > base rate. Cleaning fee once per stay.
-- SECURITY DEFINER so the public site can quote without being able to read rate_overrides.
-- ---------------------------------------------------------------------------
create or replace function quote_stay(p_unit uuid, p_in date, p_out date)
returns table(nights int, nightly_total int, cleaning_fee int, total int, min_nights int)
language sql stable security definer set search_path = public as $$
  with u as (select * from units where id = p_unit and active),
  d as (select generate_series(p_in, p_out - 1, interval '1 day')::date as night),
  priced as (
    select d.night,
      coalesce(
        (select ro.nightly_rate from rate_overrides ro
          where ro.unit_id = p_unit and d.night between ro.start_date and ro.end_date
          order by ro.created_at desc limit 1),
        case when extract(isodow from d.night) in (5,6) and u.weekend_rate is not null
             then u.weekend_rate else u.base_rate end
      ) as rate
    from d cross join u)
  select (p_out - p_in), sum(rate)::int, u.cleaning_fee, (sum(rate) + u.cleaning_fee)::int, u.min_nights
  from priced cross join u group by u.cleaning_fee, u.min_nights;
$$;
grant execute on function quote_stay(uuid,date,date) to anon, authenticated, service_role;

-- deposit = round(total * pct / 100), then rounded UP to the nearest KES 10, never above the total.
create or replace function calc_deposit(p_total int, p_percent numeric) returns int
language sql immutable as $$
  select least(p_total, (ceil(round(p_total * p_percent / 100.0) / 10.0) * 10)::int)
$$;

create or replace function setting_num(p_key text, p_default numeric) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::numeric from settings where key = p_key), p_default)
$$;

-- ---------------------------------------------------------------------------
-- Holds
-- ---------------------------------------------------------------------------
-- Expire stale pending holds (also called at the start of create-booking and by cron every minute).
create or replace function expire_stale_holds() returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update bookings set status = 'expired'
   where status = 'pending' and hold_expires_at is not null and hold_expires_at < now()
     and amount_paid < deposit_required;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function expire_stale_holds() from public, anon, authenticated;
grant execute on function expire_stale_holds() to service_role;

-- ---------------------------------------------------------------------------
-- Public availability
-- ---------------------------------------------------------------------------
create or replace function get_available_units(p_in date, p_out date, p_guests int default 1, p_property uuid default null)
returns table(unit_id uuid, property_id uuid, nights int, total int)
language sql stable security definer set search_path = public as $$
  select u.id, u.property_id, q.nights, q.total
  from units u
  join properties p on p.id = u.property_id and p.active
  cross join lateral quote_stay(u.id, p_in, p_out) q
  where u.active and u.max_guests >= p_guests
    and p_out > p_in
    and (p_property is null or u.property_id = p_property)
    and q.nights >= q.min_nights
    and not exists (
      select 1 from bookings b
      where b.unit_id = u.id
        and b.status in ('pending','confirmed','checked_in','blocked')
        and not (b.status = 'pending' and b.hold_expires_at < now())
        and daterange(b.check_in, b.check_out, '[)') && daterange(p_in, p_out, '[)'));
$$;
grant execute on function get_available_units(date,date,int,uuid) to anon, authenticated;

-- Date ranges only. No guest data. Used by the date picker to grey out taken nights.
create or replace function get_unit_unavailable_dates(p_unit uuid)
returns table(start_date date, end_date date)
language sql stable security definer set search_path = public as $$
  select b.check_in, b.check_out
  from bookings b
  where b.unit_id = p_unit
    and b.check_out > nairobi_today()
    and b.status in ('pending','confirmed','checked_in','blocked')
    and not (b.status = 'pending' and b.hold_expires_at < now())
  order by b.check_in
$$;
grant execute on function get_unit_unavailable_dates(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Payments -> bookings
-- Keeps bookings.amount_paid correct, auto-confirms when the deposit is covered,
-- and handles late payments on expired holds (rule 7.8): never silently drop money.
-- ---------------------------------------------------------------------------
create or replace function recompute_booking_paid() returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_booking uuid := coalesce(new.booking_id, old.booking_id);
  v_paid int;
  b bookings;
  v_new_success boolean := false;
begin
  select * into b from bookings where id = v_booking for update;
  if not found then return null; end if;   -- booking was deleted (cascade)

  select coalesce(sum(case when kind = 'refund' then -amount else amount end), 0)
    into v_paid from payments where booking_id = v_booking and status = 'succeeded';

  if tg_op <> 'DELETE' then
    v_new_success := new.status = 'succeeded' and new.kind <> 'refund'
                     and (tg_op = 'INSERT' or old.status is distinct from 'succeeded');
  end if;

  update bookings set amount_paid = v_paid where id = v_booking;

  if b.status = 'pending' and b.deposit_required > 0 and v_paid >= b.deposit_required then
    update bookings set status = 'confirmed', hold_expires_at = null where id = v_booking;
  elsif b.status = 'expired' and v_new_success and v_paid >= b.deposit_required and b.deposit_required > 0 then
    -- Late payment on an expired hold: re-activate if the dates are still free.
    begin
      update bookings set status = 'confirmed', hold_expires_at = null, payment_review = false, review_reason = null
       where id = v_booking;
    exception when exclusion_violation then
      update bookings set payment_review = true,
             review_reason = 'Payment arrived after the hold expired and the dates were taken. Refund the guest or move them to other dates.'
       where id = v_booking;
    end;
  elsif b.status in ('expired','cancelled','no_show') and v_new_success then
    update bookings set payment_review = true,
           review_reason = coalesce(review_reason, 'A payment was received on a ' || b.status || ' booking.')
     where id = v_booking;
  end if;
  return null;
end $$;
create trigger trg_payments_paid after insert or update or delete on payments
  for each row execute function recompute_booking_paid();

-- ---------------------------------------------------------------------------
-- Booking status machine + timestamps
-- ---------------------------------------------------------------------------
create or replace function validate_booking_transition() returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if not (
         (old.status = 'pending'     and new.status in ('confirmed','cancelled','expired'))
      or (old.status = 'confirmed'   and new.status in ('checked_in','cancelled','no_show'))
      or (old.status = 'checked_in'  and new.status in ('checked_out'))
      or (old.status = 'expired'     and new.status in ('confirmed'))
      or (old.status = 'blocked'     and new.status in ('cancelled'))
    ) then
      raise exception 'Invalid booking status change: % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;
    if new.status = 'cancelled' then new.cancelled_at := coalesce(new.cancelled_at, now()); end if;
  end if;
  return new;
end $$;
create trigger trg_bookings_transition before update on bookings
  for each row execute function validate_booking_transition();

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------
-- On check-out, create a housekeeping task for the unit (flagged priority on same-day turnover).
create or replace function create_hk_task_on_checkout() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'checked_out' and old.status is distinct from 'checked_out' then
    insert into housekeeping_tasks(property_id, unit_id, booking_id, status, due_date, priority)
    values (new.property_id, new.unit_id, new.id, 'dirty', nairobi_today(),
            exists(select 1 from bookings x
                    where x.unit_id = new.unit_id and x.id <> new.id
                      and x.check_in = nairobi_today() and x.status in ('pending','confirmed')));
  end if;
  return new;
end $$;
create trigger trg_booking_checkout after update on bookings
  for each row execute function create_hk_task_on_checkout();

-- A new arrival on the same day as an open task makes that task a priority.
create or replace function flag_hk_priority() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('pending','confirmed') then
    update housekeeping_tasks set priority = true
     where unit_id = new.unit_id and due_date = new.check_in and status in ('dirty','in_progress') and not priority;
  end if;
  return null;
end $$;
create trigger trg_booking_hk_priority after insert or update of status, check_in, unit_id on bookings
  for each row execute function flag_hk_priority();

-- Cleaners may only change status and notes (and claim an unassigned task); they cannot mark "inspected".
create or replace function guard_hk_update() returns trigger language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is not null and not (has_role(v_uid,'owner') or has_role(v_uid,'manager')) then
    if new.property_id <> old.property_id or new.unit_id <> old.unit_id
       or new.booking_id is distinct from old.booking_id or new.due_date <> old.due_date
       or new.priority <> old.priority then
      raise exception 'Cleaners can only update status and notes';
    end if;
    if new.assigned_to is distinct from old.assigned_to
       and not (old.assigned_to is null and new.assigned_to = v_uid) then
      raise exception 'Cleaners cannot reassign tasks';
    end if;
    if new.status = 'inspected' then
      raise exception 'Only a manager can mark a unit as inspected';
    end if;
  end if;
  if new.status in ('clean','inspected') and old.status not in ('clean','inspected') then
    new.completed_at := now();
  end if;
  return new;
end $$;
create trigger trg_hk_guard before update on housekeeping_tasks
  for each row execute function guard_hk_update();

-- ---------------------------------------------------------------------------
-- Guests
-- ---------------------------------------------------------------------------
-- Staff upsert by phone (managers cannot insert directly: they only see guests tied to their properties).
create or replace function staff_upsert_guest(p_name text, p_phone text, p_email text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not (has_role(auth.uid(),'owner') or has_role(auth.uid(),'manager')) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  insert into guests(full_name, phone, email) values (p_name, p_phone, nullif(p_email,''))
  on conflict (phone) do update set email = coalesce(guests.email, excluded.email)
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function staff_upsert_guest(text,text,text) from public, anon;
grant execute on function staff_upsert_guest(text,text,text) to authenticated;

-- ---------------------------------------------------------------------------
-- Creating bookings. Pricing is always recomputed here from quote_stay.
-- ---------------------------------------------------------------------------
-- Internal: service role only (edge function create-booking) and the staff wrappers below.
create or replace function create_booking(
  p_unit uuid, p_in date, p_out date, p_guests int,
  p_guest_name text, p_guest_phone text, p_guest_email text default null,
  p_source booking_source default 'website',
  p_mode text default 'hold',              -- 'hold' (pending + expiring hold) | 'confirmed' (staff)
  p_discount int default 0,
  p_deposit int default null,              -- null => deposit_percent of total
  p_notes text default null,
  p_created_by uuid default null
) returns bookings
language plpgsql security definer set search_path = public as $$
declare
  u units; q record; v_guest uuid; v_total int; v_deposit int; v_hold int; b bookings;
begin
  perform expire_stale_holds();

  if p_out <= p_in then raise exception 'Check-out must be after check-in' using errcode = 'check_violation'; end if;
  select * into u from units where id = p_unit and active;
  if not found then raise exception 'Unit not found' using errcode = 'no_data_found'; end if;
  if p_guests < 1 or p_guests > u.max_guests then
    raise exception 'This unit sleeps at most % guests', u.max_guests using errcode = 'check_violation';
  end if;
  if p_mode = 'hold' and p_in < nairobi_today() then
    raise exception 'Check-in cannot be in the past' using errcode = 'check_violation';
  end if;

  select * into q from quote_stay(p_unit, p_in, p_out);
  if q.nights < q.min_nights then
    raise exception 'Minimum stay for this unit is % night(s)', q.min_nights using errcode = 'check_violation';
  end if;

  v_total := greatest(0, q.total - coalesce(p_discount, 0));
  if p_deposit is not null then
    v_deposit := least(greatest(p_deposit, 0), v_total);
  else
    v_deposit := calc_deposit(v_total, setting_num('deposit_percent', 50));
  end if;

  insert into guests(full_name, phone, email) values (p_guest_name, p_guest_phone, nullif(p_guest_email,''))
  on conflict (phone) do update set email = coalesce(guests.email, excluded.email)
  returning id into v_guest;

  v_hold := setting_num('hold_minutes', 15)::int;

  -- The exclusion constraint no_overlapping_bookings raises 23P01 if the dates are taken.
  insert into bookings(property_id, unit_id, guest_id, check_in, check_out, num_guests, status, source,
                       nightly_total, cleaning_fee, discount, total_amount, deposit_required,
                       hold_expires_at, notes, created_by)
  values (u.property_id, p_unit, v_guest, p_in, p_out, p_guests,
          case when p_mode = 'confirmed' then 'confirmed'::booking_status else 'pending'::booking_status end,
          p_source, q.nightly_total, q.cleaning_fee, coalesce(p_discount,0), v_total, v_deposit,
          case when p_mode = 'confirmed' then null else now() + make_interval(mins => v_hold) end,
          p_notes, p_created_by)
  returning * into b;
  return b;
end $$;
revoke execute on function create_booking(uuid,date,date,int,text,text,text,booking_source,text,int,int,text,uuid) from public, anon, authenticated;
grant execute on function create_booking(uuid,date,date,int,text,text,text,booking_source,text,int,int,text,uuid) to service_role;

-- Staff wrapper: manual / walk-in / phone / WhatsApp bookings. Created straight as confirmed.
create or replace function staff_create_booking(
  p_unit uuid, p_in date, p_out date, p_guests int,
  p_guest_name text, p_guest_phone text, p_guest_email text default null,
  p_source booking_source default 'manual',
  p_discount int default 0, p_deposit int default 0, p_notes text default null
) returns bookings
language plpgsql security definer set search_path = public as $$
declare v_prop uuid; b bookings;
begin
  select property_id into v_prop from units where id = p_unit;
  if v_prop is null or not can_manage_property(auth.uid(), v_prop) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  b := create_booking(p_unit, p_in, p_out, p_guests, p_guest_name, p_guest_phone, p_guest_email,
                      p_source, 'confirmed', p_discount, p_deposit, p_notes, auth.uid());
  return b;
end $$;
revoke execute on function staff_create_booking(uuid,date,date,int,text,text,text,booking_source,int,int,text) from public, anon;
grant execute on function staff_create_booking(uuid,date,date,int,text,text,text,booking_source,int,int,text) to authenticated;

-- Blocked dates (maintenance, personal use). No guest, no payments.
create or replace function staff_block_dates(p_unit uuid, p_in date, p_out date, p_notes text default null)
returns bookings language plpgsql security definer set search_path = public as $$
declare v_prop uuid; b bookings;
begin
  select property_id into v_prop from units where id = p_unit;
  if v_prop is null or not can_manage_property(auth.uid(), v_prop) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_out <= p_in then raise exception 'End date must be after start date' using errcode = 'check_violation'; end if;
  perform expire_stale_holds();
  insert into bookings(property_id, unit_id, check_in, check_out, status, source, num_guests, notes, created_by)
  values (v_prop, p_unit, p_in, p_out, 'blocked', 'manual', 1, p_notes, auth.uid())
  returning * into b;
  return b;
end $$;
revoke execute on function staff_block_dates(uuid,date,date,text) from public, anon;
grant execute on function staff_block_dates(uuid,date,date,text) to authenticated;

-- ---------------------------------------------------------------------------
-- Guest self-service (no login). Returns ONLY safe fields for the one booking that owns the token.
-- ---------------------------------------------------------------------------
create or replace function get_booking_by_token(p_token uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', b.id, 'reference', b.reference, 'public_token', b.public_token,
    'status', case when b.status = 'pending' and b.hold_expires_at < now() then 'expired' else b.status::text end,
    'check_in', b.check_in, 'check_out', b.check_out, 'nights', b.nights, 'num_guests', b.num_guests,
    'nightly_total', b.nightly_total, 'cleaning_fee', b.cleaning_fee, 'discount', b.discount,
    'total_amount', b.total_amount, 'deposit_required', b.deposit_required, 'amount_paid', b.amount_paid,
    'balance', greatest(b.total_amount - b.amount_paid, 0),
    'hold_expires_at', b.hold_expires_at, 'guest_name', g.full_name, 'guest_phone', g.phone,
    'unit', jsonb_build_object('id', u.id, 'name', u.name),
    'property', jsonb_build_object('id', p.id, 'slug', p.slug, 'name', p.name, 'address', p.address, 'area', p.area,
        'city', p.city, 'contact_phone', p.contact_phone, 'whatsapp_number', p.whatsapp_number,
        'check_in_time', to_char(p.check_in_time,'HH24:MI'), 'check_out_time', to_char(p.check_out_time,'HH24:MI'),
        'house_rules', p.house_rules, 'lat', p.lat, 'lng', p.lng),
    'cancellation_policy', (select value #>> '{}' from settings where key = 'cancellation_policy'),
    'payments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', pay.id, 'kind', pay.kind, 'method', pay.method, 'status', pay.status, 'amount', pay.amount,
        'mpesa_receipt', pay.mpesa_receipt, 'result_code', pay.result_code, 'result_desc', pay.result_desc,
        'created_at', pay.created_at, 'confirmed_at', pay.confirmed_at) order by pay.created_at desc)
      from payments pay where pay.booking_id = b.id), '[]'::jsonb)
  )
  from bookings b
  join properties p on p.id = b.property_id
  join units u on u.id = b.unit_id
  left join guests g on g.id = b.guest_id
  where b.public_token = p_token and b.status <> 'blocked'
$$;
grant execute on function get_booking_by_token(uuid) to anon, authenticated;

-- Printable receipt data. Requires the booking's token.
create or replace function get_receipt(p_payment uuid, p_token uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'payment_id', pay.id, 'receipt_no', coalesce(pay.mpesa_receipt, upper(left(pay.id::text, 8))),
    'kind', pay.kind, 'method', pay.method, 'amount', pay.amount, 'confirmed_at', pay.confirmed_at,
    'booking_reference', b.reference, 'check_in', b.check_in, 'check_out', b.check_out, 'nights', b.nights,
    'total_amount', b.total_amount, 'amount_paid', b.amount_paid,
    'balance', greatest(b.total_amount - b.amount_paid, 0),
    'guest_name', g.full_name, 'property_name', p.name, 'property_address', p.address, 'unit_name', u.name,
    'business_name', (select value #>> '{}' from settings where key = 'business_name'))
  from payments pay
  join bookings b on b.id = pay.booking_id
  join properties p on p.id = b.property_id
  join units u on u.id = b.unit_id
  left join guests g on g.id = b.guest_id
  where pay.id = p_payment and b.public_token = p_token and pay.status = 'succeeded'
$$;
grant execute on function get_receipt(uuid,uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Rate limiting for public endpoints (service role only). Returns true if allowed.
-- ---------------------------------------------------------------------------
create or replace function check_rate_limit(p_key text, p_max int, p_window_seconds int) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from rate_limit_events where created_at < now() - interval '1 day' and random() < 0.02;
  select count(*) into n from rate_limit_events
   where key = p_key and created_at > now() - make_interval(secs => p_window_seconds);
  if n >= p_max then return false; end if;
  insert into rate_limit_events(key) values (p_key);
  return true;
end $$;
revoke execute on function check_rate_limit(text,int,int) from public, anon, authenticated;
grant execute on function check_rate_limit(text,int,int) to service_role;

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
create or replace function audit_booking() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into audit_log(user_id, action, entity, entity_id, diff)
    values (auth.uid(), 'booking.created', 'booking', new.id::text,
            jsonb_build_object('reference', new.reference, 'status', new.status, 'source', new.source, 'total', new.total_amount));
  elsif new.status is distinct from old.status then
    insert into audit_log(user_id, action, entity, entity_id, diff)
    values (auth.uid(), 'booking.status_changed', 'booking', new.id::text,
            jsonb_build_object('reference', new.reference, 'from', old.status, 'to', new.status, 'reason', new.cancel_reason));
  end if;
  return null;
end $$;
create trigger trg_audit_booking after insert or update on bookings for each row execute function audit_booking();

create or replace function audit_payment() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into audit_log(user_id, action, entity, entity_id, diff)
    values (auth.uid(), 'payment.created', 'payment', new.id::text,
            jsonb_build_object('booking_id', new.booking_id, 'kind', new.kind, 'method', new.method, 'status', new.status, 'amount', new.amount));
  elsif new.status is distinct from old.status then
    insert into audit_log(user_id, action, entity, entity_id, diff)
    values (auth.uid(), 'payment.status_changed', 'payment', new.id::text,
            jsonb_build_object('booking_id', new.booking_id, 'from', old.status, 'to', new.status, 'amount', new.amount, 'receipt', new.mpesa_receipt));
  end if;
  return null;
end $$;
create trigger trg_audit_payment after insert or update on payments for each row execute function audit_payment();

-- Generic audit for rate changes, expenses, role/staff changes, settings.
create or replace function audit_generic() returns trigger language plpgsql security definer set search_path = public as $$
declare v_entity text := tg_argv[0]; v_row jsonb; v_old jsonb; v_id text;
begin
  if tg_op = 'DELETE' then v_row := to_jsonb(old); else v_row := to_jsonb(new); end if;
  v_id := coalesce(v_row->>'id', v_row->>'key', v_row->>'user_id');
  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    -- units: only log when a price field changed
    -- (compared through jsonb: this function serves several tables, so NEW.base_rate would not exist on all of them)
    if v_entity = 'unit' and not (v_row->>'base_rate' is distinct from v_old->>'base_rate'
        or v_row->>'weekend_rate' is distinct from v_old->>'weekend_rate' or v_row->>'cleaning_fee' is distinct from v_old->>'cleaning_fee') then
      return null;
    end if;
    insert into audit_log(user_id, action, entity, entity_id, diff)
    values (auth.uid(), v_entity || '.updated', v_entity, v_id, jsonb_build_object('old', v_old, 'new', v_row));
  else
    insert into audit_log(user_id, action, entity, entity_id, diff)
    values (auth.uid(), v_entity || '.' || lower(tg_op), v_entity, v_id, v_row);
  end if;
  return null;
end $$;
create trigger trg_audit_unit      after update on units            for each row execute function audit_generic('unit');
create trigger trg_audit_override  after insert or update or delete on rate_overrides for each row execute function audit_generic('rate_override');
create trigger trg_audit_expense   after insert or update or delete on expenses        for each row execute function audit_generic('expense');
create trigger trg_audit_role      after insert or update or delete on user_roles      for each row execute function audit_generic('user_role');
create trigger trg_audit_staffprop after insert or delete on staff_properties          for each row execute function audit_generic('staff_property');
create trigger trg_audit_settings  after insert or update on settings                  for each row execute function audit_generic('setting');

-- ---------------------------------------------------------------------------
-- Data protection (Kenya DPA 2019): export and anonymise guest data. Financial records are kept.
-- ---------------------------------------------------------------------------
create or replace function export_guest_data(p_guest uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not (has_role(auth.uid(),'owner') or has_role(auth.uid(),'manager')) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'guest', (select to_jsonb(g) from guests g where g.id = p_guest),
    'bookings', coalesce((select jsonb_agg(to_jsonb(b)) from bookings b
                          where b.guest_id = p_guest and can_access_property(auth.uid(), b.property_id)), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', pay.id, 'booking_id', pay.booking_id, 'kind', pay.kind,
                          'amount', pay.amount, 'status', pay.status, 'mpesa_receipt', pay.mpesa_receipt, 'confirmed_at', pay.confirmed_at))
                          from payments pay join bookings b on b.id = pay.booking_id
                          where b.guest_id = p_guest and can_access_property(auth.uid(), b.property_id)), '[]'::jsonb));
end $$;
revoke execute on function export_guest_data(uuid) from public, anon;
grant execute on function export_guest_data(uuid) to authenticated;

create or replace function anonymise_guest(p_guest uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_role(auth.uid(),'owner') then raise exception 'Only the owner can delete guest data' using errcode = '42501'; end if;
  update guests set full_name = 'Deleted guest', phone = 'deleted-' || left(id::text, 8),
         email = null, id_number = null, notes = null, anonymised_at = now()
   where id = p_guest;
  insert into audit_log(user_id, action, entity, entity_id) values (auth.uid(), 'guest.anonymised', 'guest', p_guest::text);
end $$;
revoke execute on function anonymise_guest(uuid) from public, anon;
grant execute on function anonymise_guest(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Finance reporting (SECURITY INVOKER: RLS limits each user to their own properties).
-- Income is attributed to the Nairobi month of payments.confirmed_at.
-- ---------------------------------------------------------------------------
create or replace function monthly_pnl(p_month date)
returns table(property_id uuid, property_name text, income int, refunds int, expenses int, net int)
language sql stable as $$
  with m as (select date_trunc('month', p_month)::date as s, (date_trunc('month', p_month) + interval '1 month')::date as e),
  inc as (
    select b.property_id,
           coalesce(sum(case when pay.kind <> 'refund' then pay.amount end), 0)::int as income,
           coalesce(sum(case when pay.kind = 'refund' then pay.amount end), 0)::int as refunds
    from payments pay join bookings b on b.id = pay.booking_id, m
    where pay.status = 'succeeded'
      and (pay.confirmed_at at time zone 'Africa/Nairobi')::date >= m.s
      and (pay.confirmed_at at time zone 'Africa/Nairobi')::date <  m.e
    group by b.property_id),
  exp as (
    select e.property_id, sum(e.amount)::int as expenses
    from expenses e, m
    where not e.voided and e.expense_date >= m.s and e.expense_date < m.e
    group by e.property_id)
  select p.id, p.name,
         coalesce(inc.income, 0), coalesce(inc.refunds, 0), coalesce(exp.expenses, 0),
         (coalesce(inc.income, 0) - coalesce(inc.refunds, 0) - coalesce(exp.expenses, 0))::int
  from properties p
  left join inc on inc.property_id = p.id
  left join exp on exp.property_id = p.id
  where can_access_property(auth.uid(), p.id)
  order by p.sort, p.name
$$;

create or replace function monthly_expenses_by_category(p_month date, p_property uuid default null)
returns table(category text, amount int)
language sql stable as $$
  select e.category, sum(e.amount)::int
  from expenses e
  where not e.voided
    and e.expense_date >= date_trunc('month', p_month)::date
    and e.expense_date <  (date_trunc('month', p_month) + interval '1 month')::date
    and (p_property is null or e.property_id = p_property)
  group by e.category order by 2 desc
$$;

$mig2$;

    -- ---- 0003_rls.sql ----
    execute $mig3$
-- 0003_rls.sql: Row Level Security on EVERY table. UI hiding is never the security layer.
-- Matrix (see build spec 5.3). Deactivated users have no roles (see has_role), so they match nothing here.

alter table profiles           enable row level security;
alter table user_roles         enable row level security;
alter table properties         enable row level security;
alter table staff_properties   enable row level security;
alter table units              enable row level security;
alter table rate_overrides     enable row level security;
alter table guests             enable row level security;
alter table bookings           enable row level security;
alter table payments           enable row level security;
alter table housekeeping_tasks enable row level security;
alter table expenses           enable row level security;
alter table message_log        enable row level security;
alter table settings           enable row level security;
alter table audit_log          enable row level security;
alter table rate_limit_events  enable row level security;

-- Defence in depth: anon can never touch sensitive tables even if a policy is added by mistake.
revoke all on profiles, user_roles, staff_properties, rate_overrides, guests, bookings, payments,
              housekeeping_tasks, expenses, message_log, audit_log, rate_limit_events from anon;
revoke all on rate_limit_events from authenticated;
revoke update, delete, insert on audit_log from authenticated;   -- audit rows are written by security-definer triggers only

-- ---- properties / units / rate_overrides ----------------------------------
create policy properties_public_read on properties for select to anon, authenticated using (active);
create policy properties_staff_read  on properties for select to authenticated using (can_access_property((select auth.uid()), id));
create policy properties_manager_update on properties for update to authenticated
  using (can_manage_property((select auth.uid()), id)) with check (can_manage_property((select auth.uid()), id));
create policy properties_owner_insert on properties for insert to authenticated with check (has_role((select auth.uid()),'owner'));
create policy properties_owner_delete on properties for delete to authenticated using (has_role((select auth.uid()),'owner'));

create policy units_public_read on units for select to anon, authenticated using (active);
create policy units_staff_read  on units for select to authenticated using (can_access_property((select auth.uid()), property_id));
create policy units_manager_write on units for insert to authenticated with check (can_manage_property((select auth.uid()), property_id));
create policy units_manager_update on units for update to authenticated
  using (can_manage_property((select auth.uid()), property_id)) with check (can_manage_property((select auth.uid()), property_id));
create policy units_owner_delete on units for delete to authenticated using (has_role((select auth.uid()),'owner'));

create policy overrides_staff_read on rate_overrides for select to authenticated
  using (exists (select 1 from units u where u.id = unit_id and can_access_property((select auth.uid()), u.property_id)));
create policy overrides_manager_write on rate_overrides for all to authenticated
  using (exists (select 1 from units u where u.id = unit_id and can_manage_property((select auth.uid()), u.property_id)))
  with check (exists (select 1 from units u where u.id = unit_id and can_manage_property((select auth.uid()), u.property_id)));

-- ---- bookings (staff only; guests use RPCs / edge functions) --------------
create policy bookings_manager_all on bookings for all to authenticated
  using (can_manage_property((select auth.uid()), property_id))
  with check (can_manage_property((select auth.uid()), property_id));

-- ---- guests ----------------------------------------------------------------
create policy guests_owner_all on guests for all to authenticated
  using (has_role((select auth.uid()),'owner')) with check (has_role((select auth.uid()),'owner'));
create policy guests_manager_read on guests for select to authenticated
  using (has_role((select auth.uid()),'manager')
         and exists (select 1 from bookings b where b.guest_id = guests.id and can_manage_property((select auth.uid()), b.property_id)));
create policy guests_manager_update on guests for update to authenticated
  using (has_role((select auth.uid()),'manager')
         and exists (select 1 from bookings b where b.guest_id = guests.id and can_manage_property((select auth.uid()), b.property_id)))
  with check (has_role((select auth.uid()),'manager'));

-- ---- payments ---------------------------------------------------------------
create policy payments_manager_read on payments for select to authenticated
  using (exists (select 1 from bookings b where b.id = booking_id and can_manage_property((select auth.uid()), b.property_id)));
-- Managers record MANUAL payments only (cash / bank / manual M-Pesa). STK rows are written by edge functions.
create policy payments_manager_insert on payments for insert to authenticated
  with check (method <> 'mpesa_stk' and status = 'succeeded' and recorded_by = (select auth.uid())
              and exists (select 1 from bookings b where b.id = booking_id and can_manage_property((select auth.uid()), b.property_id)));
create policy payments_owner_all on payments for all to authenticated
  using (has_role((select auth.uid()),'owner')) with check (has_role((select auth.uid()),'owner'));

-- ---- housekeeping -----------------------------------------------------------
create policy hk_manager_all on housekeeping_tasks for all to authenticated
  using (can_manage_property((select auth.uid()), property_id))
  with check (can_manage_property((select auth.uid()), property_id));
-- Cleaners: tasks at their properties that are theirs or unclaimed. Column limits are enforced by guard_hk_update().
create policy hk_cleaner_read on housekeeping_tasks for select to authenticated
  using (has_role((select auth.uid()),'cleaner') and can_access_property((select auth.uid()), property_id)
         and (assigned_to = (select auth.uid()) or assigned_to is null));
create policy hk_cleaner_update on housekeeping_tasks for update to authenticated
  using (has_role((select auth.uid()),'cleaner') and can_access_property((select auth.uid()), property_id)
         and (assigned_to = (select auth.uid()) or assigned_to is null))
  with check (has_role((select auth.uid()),'cleaner') and can_access_property((select auth.uid()), property_id));

-- ---- expenses (managers cannot delete; they void) ---------------------------
create policy expenses_manager_read on expenses for select to authenticated using (can_manage_property((select auth.uid()), property_id));
create policy expenses_manager_insert on expenses for insert to authenticated with check (can_manage_property((select auth.uid()), property_id));
create policy expenses_manager_update on expenses for update to authenticated
  using (can_manage_property((select auth.uid()), property_id)) with check (can_manage_property((select auth.uid()), property_id));
create policy expenses_owner_delete on expenses for delete to authenticated using (has_role((select auth.uid()),'owner'));

-- ---- message_log -------------------------------------------------------------
create policy messages_manager_read on message_log for select to authenticated
  using (property_id is not null and can_manage_property((select auth.uid()), property_id));
create policy messages_owner_all on message_log for all to authenticated
  using (has_role((select auth.uid()),'owner')) with check (has_role((select auth.uid()),'owner'));
-- Managers may queue a custom message for their own properties (sent by the send-whatsapp function).
create policy messages_manager_insert on message_log for insert to authenticated
  with check (property_id is not null and can_manage_property((select auth.uid()), property_id));

-- ---- settings ----------------------------------------------------------------
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes','mpesa_manual_instructions','mpesa_paybill_display'));
create policy settings_manager_read on settings for select to authenticated
  using (has_role((select auth.uid()),'owner') or has_role((select auth.uid()),'manager'));
create policy settings_owner_write on settings for all to authenticated
  using (has_role((select auth.uid()),'owner')) with check (has_role((select auth.uid()),'owner'));

-- ---- profiles / roles / staff_properties --------------------------------------
create policy profiles_self_read on profiles for select to authenticated using (id = (select auth.uid()));
create policy profiles_manager_read on profiles for select to authenticated
  using (has_role((select auth.uid()),'owner') or has_role((select auth.uid()),'manager'));
create policy profiles_owner_all on profiles for all to authenticated
  using (has_role((select auth.uid()),'owner')) with check (has_role((select auth.uid()),'owner'));

create policy roles_self_read on user_roles for select to authenticated using (user_id = (select auth.uid()));
create policy roles_manager_read on user_roles for select to authenticated
  using (has_role((select auth.uid()),'owner') or has_role((select auth.uid()),'manager'));
create policy roles_owner_all on user_roles for all to authenticated
  using (has_role((select auth.uid()),'owner')) with check (has_role((select auth.uid()),'owner'));

create policy staffprops_self_read on staff_properties for select to authenticated using (user_id = (select auth.uid()));
create policy staffprops_manager_read on staff_properties for select to authenticated
  using (has_role((select auth.uid()),'owner') or has_role((select auth.uid()),'manager'));
create policy staffprops_owner_all on staff_properties for all to authenticated
  using (has_role((select auth.uid()),'owner')) with check (has_role((select auth.uid()),'owner'));

-- ---- audit_log: owner read only -------------------------------------------------
create policy audit_owner_read on audit_log for select to authenticated using (has_role((select auth.uid()),'owner'));

-- rate_limit_events: RLS on, no policies => only the service role can touch it.

-- ---------------------------------------------------------------------------
-- Realtime (dashboard / calendar refresh). RLS still applies to realtime events.
-- ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table bookings, payments, housekeeping_tasks;
  end if;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Storage buckets + policies (skipped automatically when the storage schema does not exist)
-- ---------------------------------------------------------------------------
do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values
      ('property-images', 'property-images', true),
      ('expense-receipts', 'expense-receipts', false)
    on conflict (id) do nothing;

    drop policy if exists "property images public read" on storage.objects;
    create policy "property images public read" on storage.objects for select
      using (bucket_id = 'property-images');

    drop policy if exists "property images staff write" on storage.objects;
    create policy "property images staff write" on storage.objects for insert to authenticated
      with check (bucket_id = 'property-images' and (public.has_role(auth.uid(),'owner') or public.has_role(auth.uid(),'manager')));
    drop policy if exists "property images staff update" on storage.objects;
    create policy "property images staff update" on storage.objects for update to authenticated
      using (bucket_id = 'property-images' and (public.has_role(auth.uid(),'owner') or public.has_role(auth.uid(),'manager')));
    drop policy if exists "property images staff delete" on storage.objects;
    create policy "property images staff delete" on storage.objects for delete to authenticated
      using (bucket_id = 'property-images' and (public.has_role(auth.uid(),'owner') or public.has_role(auth.uid(),'manager')));

    drop policy if exists "receipts staff read" on storage.objects;
    create policy "receipts staff read" on storage.objects for select to authenticated
      using (bucket_id = 'expense-receipts' and (public.has_role(auth.uid(),'owner') or public.has_role(auth.uid(),'manager')));
    drop policy if exists "receipts staff write" on storage.objects;
    create policy "receipts staff write" on storage.objects for insert to authenticated
      with check (bucket_id = 'expense-receipts' and (public.has_role(auth.uid(),'owner') or public.has_role(auth.uid(),'manager')));
    drop policy if exists "receipts staff update" on storage.objects;
    create policy "receipts staff update" on storage.objects for update to authenticated
      using (bucket_id = 'expense-receipts' and (public.has_role(auth.uid(),'owner') or public.has_role(auth.uid(),'manager')));
    drop policy if exists "receipts owner delete" on storage.objects;
    create policy "receipts owner delete" on storage.objects for delete to authenticated
      using (bucket_id = 'expense-receipts' and public.has_role(auth.uid(),'owner'));
  end if;
end $$;

$mig3$;

    -- ---- 0004_cron.sql ----
    execute $mig4$
-- 0004_cron.sql: scheduled jobs. Requires the pg_cron and pg_net extensions (enabled by default on Supabase;
-- enable them under Database > Extensions on a fresh project). Skipped silently where they are unavailable
-- (plain Postgres in the SQL test runner).
--
-- The edge-function jobs read two Vault secrets that DEPLOY.md tells you to create once:
--   select vault.create_secret('https://<project-ref>.supabase.co', 'functions_base_url');
--   select vault.create_secret('<service role key>',               'service_role_key');

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then

    create extension if not exists pg_cron;
    create extension if not exists pg_net;

    create or replace function public.invoke_edge_function(p_name text) returns void
    language plpgsql security definer set search_path = public as $fn$
    declare v_base text; v_key text;
    begin
      select decrypted_secret into v_base from vault.decrypted_secrets where name = 'functions_base_url' limit 1;
      select decrypted_secret into v_key  from vault.decrypted_secrets where name = 'service_role_key'  limit 1;
      if v_base is null or v_key is null then
        raise warning 'invoke_edge_function(%): vault secrets functions_base_url / service_role_key are not set', p_name;
        return;
      end if;
      perform net.http_post(
        url := v_base || '/functions/v1/' || p_name,
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
        body := '{}'::jsonb);
    end $fn$;
    revoke execute on function public.invoke_edge_function(text) from public, anon, authenticated;

    -- Idempotent re-scheduling
    perform cron.unschedule(jobid) from cron.job where jobname in ('bnb-expire-holds','bnb-send-reminders','bnb-mpesa-reconcile');

    -- Every minute: free unpaid holds. Calls the SQL function directly (the expire-holds edge function
    -- does the same thing and exists for manual / external triggering).
    perform cron.schedule('bnb-expire-holds', '* * * * *', 'select public.expire_stale_holds()');
    -- Daily 08:00 Africa/Nairobi (UTC+3, no DST) = 05:00 UTC
    perform cron.schedule('bnb-send-reminders', '0 5 * * *', $c$select public.invoke_edge_function('send-reminders')$c$);
    -- Every 2 minutes: settle STK pushes whose callback never arrived
    perform cron.schedule('bnb-mpesa-reconcile', '*/2 * * * *', $c$select public.invoke_edge_function('mpesa-reconcile')$c$);
  else
    raise notice 'pg_cron / pg_net not available: skipping cron jobs (see DEPLOY.md)';
  end if;
end $$;

$mig4$;

    -- ---- 0005_brand_color.sql ----
    execute $mig5$
-- 0005_brand_color.sql: owner-editable brand colour (Settings > Brand), readable by the public site.
insert into settings(key, value) values ('brand_color', '"#0f766e"') on conflict (key) do nothing;

drop policy if exists settings_public_read on settings;
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes',
                 'mpesa_manual_instructions','mpesa_paybill_display','brand_color'));

$mig5$;

    -- ---- 0006_site_content.sql ----
    execute $mig6$
-- 0006_site_content.sql: marketing copy for the public site (hero headline, reviews, socials...) is edited in
-- Admin > Settings > Website and stored as ONE jsonb value under settings.key = 'site_content'.
-- The only change needed is to let the public site read that key (same allowlist approach as 0005).
drop policy if exists settings_public_read on settings;
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes',
                 'mpesa_manual_instructions','mpesa_paybill_display','brand_color','site_content'));

$mig6$;
    -- ---- 0007_inquiries_reviews_announcements.sql ----
    execute $mig7$
-- 0007_inquiries_reviews_announcements.sql
-- Guest inquiries (with internal notes and a linked booking), guest reviews (moderated) and announcements
-- (scheduled, never hard-deleted). Public visitors write ONLY through the two RPCs below (throttled);
-- staff read/write through RLS. Everything is audited by the existing audit_generic trigger function.

-- ---------------------------------------------------------------------------
-- Phone normalisation (mirror of src/lib/phone.ts): returns 2547XXXXXXXX / 2541XXXXXXXX or null.
-- ---------------------------------------------------------------------------
create or replace function normalize_ke_phone(p_in text) returns text
language plpgsql immutable as $$
declare d text;
begin
  if p_in is null or p_in ~ '[^0-9 +().\-]' then return null; end if;
  d := regexp_replace(p_in, '[ ().\-]', '', 'g');
  if left(d, 1) = '+' then
    if left(d, 4) <> '+254' then return null; end if;
    d := substr(d, 2);
  end if;
  if position('+' in d) > 0 then return null; end if;
  if left(d, 1) = '0' then d := '254' || substr(d, 2); end if;
  if d !~ '^254[71][0-9]{8}$' then return null; end if;
  return d;
end $$;

create or replace function is_owner_or_manager(_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_role(_uid, 'owner') or has_role(_uid, 'manager')
$$;

-- ---------------------------------------------------------------------------
-- Inquiries
-- ---------------------------------------------------------------------------
create table inquiries (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 80),
  phone text not null,
  email text check (email is null or char_length(email) <= 120),
  message text not null check (char_length(message) between 2 and 2000),
  property_id uuid references properties on delete set null,
  check_in date,
  check_out date,
  guests int check (guests is null or guests between 1 and 30),
  source text not null default 'website',
  status text not null default 'new' check (status in ('new','contacted','awaiting_response','converted','closed')),
  assigned_to uuid references profiles on delete set null,
  follow_up_on date,
  booking_id uuid references bookings on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (check_out is null or check_in is null or check_out > check_in)
);
create index on inquiries (status, created_at desc);
create index on inquiries (assigned_to);
create index on inquiries (property_id);
create trigger trg_inquiries_updated before update on inquiries for each row execute function set_updated_at();

-- An inquiry can only be "converted" when a real booking is linked.
create or replace function guard_inquiry_converted() returns trigger language plpgsql as $$
begin
  if new.status = 'converted' and new.booking_id is null then
    raise exception 'Link a booking before marking an inquiry as converted' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger trg_inquiries_converted before insert or update on inquiries for each row execute function guard_inquiry_converted();

create table inquiry_notes (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references inquiries on delete cascade,
  user_id uuid references profiles on delete set null,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index on inquiry_notes (inquiry_id, created_at);

-- ---------------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------------
create table reviews (
  id uuid primary key default gen_random_uuid(),
  guest_name text not null check (char_length(guest_name) between 2 and 60),
  stay_label text check (stay_label is null or char_length(stay_label) <= 80),
  property_id uuid references properties on delete set null,
  rating int not null check (rating between 1 and 5),
  body text not null check (char_length(body) between 5 and 1000),
  status text not null default 'pending' check (status in ('pending','approved','hidden')),
  flagged boolean not null default false,
  response text check (response is null or char_length(response) <= 1000),
  responded_at timestamptz,
  responded_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on reviews (status, created_at desc);
create trigger trg_reviews_updated before update on reviews for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Announcements (archived with active=false, never deleted by managers: history is kept)
-- ---------------------------------------------------------------------------
create table announcements (
  id uuid primary key default gen_random_uuid(),
  text text not null check (char_length(text) between 2 and 160),
  link text check (link is null or char_length(link) <= 300),
  variant text not null default 'info' check (variant in ('info','promo')),
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create index on announcements (active, starts_at, ends_at);
create trigger trg_announcements_updated before update on announcements for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table inquiries      enable row level security;
alter table inquiry_notes  enable row level security;
alter table reviews        enable row level security;
alter table announcements  enable row level security;

revoke all on inquiries, inquiry_notes from anon;
revoke insert, update, delete on reviews, announcements from anon;

create policy inquiries_staff_all on inquiries for all to authenticated
  using (is_owner_or_manager((select auth.uid())) and (property_id is null or can_manage_property((select auth.uid()), property_id)))
  with check (is_owner_or_manager((select auth.uid())) and (property_id is null or can_manage_property((select auth.uid()), property_id)));

create policy inquiry_notes_staff_all on inquiry_notes for all to authenticated
  using (exists (select 1 from inquiries i where i.id = inquiry_id and is_owner_or_manager((select auth.uid()))
                 and (i.property_id is null or can_manage_property((select auth.uid()), i.property_id))))
  with check (user_id = (select auth.uid()) and exists (select 1 from inquiries i where i.id = inquiry_id and is_owner_or_manager((select auth.uid()))
                 and (i.property_id is null or can_manage_property((select auth.uid()), i.property_id))));

create policy reviews_public_read on reviews for select to anon, authenticated using (status = 'approved');
create policy reviews_staff_all on reviews for all to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));

create policy announcements_public_read on announcements for select to anon, authenticated
  using (active and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at >= now()));
create policy announcements_staff_read on announcements for select to authenticated using (is_owner_or_manager((select auth.uid())));
create policy announcements_staff_write on announcements for insert to authenticated with check (is_owner_or_manager((select auth.uid())));
create policy announcements_staff_update on announcements for update to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy announcements_owner_delete on announcements for delete to authenticated using (has_role((select auth.uid()), 'owner'));

-- ---------------------------------------------------------------------------
-- Public submissions (the ONLY way visitors write). Throttled; a filled "website" honeypot is silently dropped.
-- ---------------------------------------------------------------------------
create or replace function submit_inquiry(
  p_name text, p_phone text, p_email text, p_message text,
  p_property uuid default null, p_in date default null, p_out date default null, p_guests int default null,
  p_website text default ''
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_phone text; v_id uuid; n int;
begin
  if coalesce(p_website, '') <> '' then return null; end if;
  v_phone := normalize_ke_phone(p_phone);
  if v_phone is null then raise exception 'Enter a valid Kenyan phone number, for example 0712 345 678.' using errcode = 'check_violation'; end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Please enter your name.' using errcode = 'check_violation'; end if;
  if char_length(trim(coalesce(p_message, ''))) < 2 then raise exception 'Please write a message.' using errcode = 'check_violation'; end if;
  select count(*) into n from rate_limit_events where key = 'inquiry:' || v_phone and created_at > now() - interval '1 hour';
  if n >= 3 then raise exception 'Too many messages from this number. Please wait a while and try again.' using errcode = 'check_violation'; end if;
  select count(*) into n from rate_limit_events where key = 'inquiry:all' and created_at > now() - interval '1 hour';
  if n >= 60 then raise exception 'We are receiving many messages right now. Please try again shortly.' using errcode = 'check_violation'; end if;
  insert into rate_limit_events(key) values ('inquiry:' || v_phone), ('inquiry:all');
  insert into inquiries(name, phone, email, message, property_id, check_in, check_out, guests, source)
  values (trim(p_name), v_phone, nullif(trim(coalesce(p_email, '')), ''), trim(p_message),
          (select id from properties where id = p_property and active), p_in, p_out, p_guests, 'website')
  returning id into v_id;
  return v_id;
end $$;
grant execute on function submit_inquiry(text,text,text,text,uuid,date,date,int,text) to anon, authenticated;

create or replace function submit_review(
  p_name text, p_stay text, p_property uuid, p_rating int, p_body text, p_website text default ''
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; n int; k text;
begin
  if coalesce(p_website, '') <> '' then return null; end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Please enter your name.' using errcode = 'check_violation'; end if;
  if char_length(trim(coalesce(p_body, ''))) < 5 then raise exception 'Please write a few words about your stay.' using errcode = 'check_violation'; end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then raise exception 'Choose 1 to 5 stars.' using errcode = 'check_violation'; end if;
  k := 'review:' || lower(trim(p_name));
  select count(*) into n from rate_limit_events where key = k and created_at > now() - interval '1 day';
  if n >= 2 then raise exception 'Thank you, we already received your review.' using errcode = 'check_violation'; end if;
  select count(*) into n from rate_limit_events where key = 'review:all' and created_at > now() - interval '1 hour';
  if n >= 30 then raise exception 'Please try again shortly.' using errcode = 'check_violation'; end if;
  insert into rate_limit_events(key) values (k), ('review:all');
  insert into reviews(guest_name, stay_label, property_id, rating, body, status)
  values (trim(p_name), nullif(trim(coalesce(p_stay, '')), ''), (select id from properties where id = p_property and active), p_rating, trim(p_body), 'pending')
  returning id into v_id;
  return v_id;
end $$;
grant execute on function submit_review(text,text,uuid,int,text,text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Audit trail (existing generic trigger function)
-- ---------------------------------------------------------------------------
create trigger trg_audit_inquiry      after insert or update or delete on inquiries     for each row execute function audit_generic('inquiry');
create trigger trg_audit_review       after insert or update or delete on reviews       for each row execute function audit_generic('review');
create trigger trg_audit_announcement after insert or update or delete on announcements for each row execute function audit_generic('announcement');

$mig7$;
    -- ---- 0008_listings_management.sql ----
    execute $mig8$
-- 0008_listings_management.sql
-- Listing controls (feature / archive / per-property cancellation policy), richer unit details (bathrooms, bed
-- configuration, maximum stay) and a maintenance flag, plus a room status board function.
-- Booking safeguards live in the database: create_booking and get_available_units now refuse units that are under
-- maintenance or stays longer than the unit's maximum.

alter table properties
  add column featured boolean not null default false,
  add column archived_at timestamptz,
  add column cancellation_policy text check (cancellation_policy is null or char_length(cancellation_policy) <= 2000);
-- An archived listing is never public.
alter table properties add constraint properties_archived_hidden check (archived_at is null or active = false);
create index on properties (featured, sort);

alter table units
  add column bathrooms numeric(3,1) not null default 1 check (bathrooms >= 0 and bathrooms <= 20),
  add column bed_config text check (bed_config is null or char_length(bed_config) <= 120),
  add column max_nights int check (max_nights is null or max_nights >= 1),
  add column maintenance_status text not null default 'ok' check (maintenance_status in ('ok','maintenance','out_of_service')),
  add column maintenance_note text check (maintenance_note is null or char_length(maintenance_note) <= 300);
alter table units add constraint units_max_ge_min check (max_nights is null or max_nights >= min_nights);

-- ---------------------------------------------------------------------------
-- Availability and booking creation (same signatures; two extra safeguards)
-- ---------------------------------------------------------------------------
create or replace function get_available_units(p_in date, p_out date, p_guests int default 1, p_property uuid default null)
returns table(unit_id uuid, property_id uuid, nights int, total int)
language sql stable security definer set search_path = public as $$
  select u.id, u.property_id, q.nights, q.total
  from units u
  join properties p on p.id = u.property_id and p.active
  cross join lateral quote_stay(u.id, p_in, p_out) q
  where u.active and u.max_guests >= p_guests
    and p_out > p_in
    and (p_property is null or u.property_id = p_property)
    and q.nights >= q.min_nights
    and (u.max_nights is null or q.nights <= u.max_nights)
    and u.maintenance_status = 'ok'
    and not exists (
      select 1 from bookings b
      where b.unit_id = u.id
        and b.status in ('pending','confirmed','checked_in','blocked')
        and not (b.status = 'pending' and b.hold_expires_at < now())
        and daterange(b.check_in, b.check_out, '[)') && daterange(p_in, p_out, '[)'));
$$;

create or replace function create_booking(
  p_unit uuid, p_in date, p_out date, p_guests int,
  p_guest_name text, p_guest_phone text, p_guest_email text default null,
  p_source booking_source default 'website',
  p_mode text default 'hold',              -- 'hold' (pending + expiring hold) | 'confirmed' (staff)
  p_discount int default 0,
  p_deposit int default null,              -- null => deposit_percent of total
  p_notes text default null,
  p_created_by uuid default null
) returns bookings
language plpgsql security definer set search_path = public as $$
declare
  u units; q record; v_guest uuid; v_total int; v_deposit int; v_hold int; b bookings;
begin
  perform expire_stale_holds();

  if p_out <= p_in then raise exception 'Check-out must be after check-in' using errcode = 'check_violation'; end if;
  select * into u from units where id = p_unit and active;
  if not found then raise exception 'Unit not found' using errcode = 'no_data_found'; end if;
  if u.maintenance_status <> 'ok' then
    raise exception 'This unit is not available right now (maintenance)' using errcode = 'check_violation';
  end if;
  if p_guests < 1 or p_guests > u.max_guests then
    raise exception 'This unit sleeps at most % guests', u.max_guests using errcode = 'check_violation';
  end if;
  if p_mode = 'hold' and p_in < nairobi_today() then
    raise exception 'Check-in cannot be in the past' using errcode = 'check_violation';
  end if;

  select * into q from quote_stay(p_unit, p_in, p_out);
  if q.nights < q.min_nights then
    raise exception 'Minimum stay for this unit is % night(s)', q.min_nights using errcode = 'check_violation';
  end if;

  if u.max_nights is not null and q.nights > u.max_nights then
    raise exception 'Maximum stay for this unit is % night(s)', u.max_nights using errcode = 'check_violation';
  end if;

  v_total := greatest(0, q.total - coalesce(p_discount, 0));
  if p_deposit is not null then
    v_deposit := least(greatest(p_deposit, 0), v_total);
  else
    v_deposit := calc_deposit(v_total, setting_num('deposit_percent', 50));
  end if;

  insert into guests(full_name, phone, email) values (p_guest_name, p_guest_phone, nullif(p_guest_email,''))
  on conflict (phone) do update set email = coalesce(guests.email, excluded.email)
  returning id into v_guest;

  v_hold := setting_num('hold_minutes', 15)::int;

  -- The exclusion constraint no_overlapping_bookings raises 23P01 if the dates are taken.
  insert into bookings(property_id, unit_id, guest_id, check_in, check_out, num_guests, status, source,
                       nightly_total, cleaning_fee, discount, total_amount, deposit_required,
                       hold_expires_at, notes, created_by)
  values (u.property_id, p_unit, v_guest, p_in, p_out, p_guests,
          case when p_mode = 'confirmed' then 'confirmed'::booking_status else 'pending'::booking_status end,
          p_source, q.nightly_total, q.cleaning_fee, coalesce(p_discount,0), v_total, v_deposit,
          case when p_mode = 'confirmed' then null else now() + make_interval(mins => v_hold) end,
          p_notes, p_created_by)
  returning * into b;
  return b;
end $$;
revoke execute on function create_booking(uuid,date,date,int,text,text,text,booking_source,text,int,int,text,uuid) from public, anon, authenticated;
grant execute on function create_booking(uuid,date,date,int,text,text,text,booking_source,text,int,int,text,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Room status board for a day (SECURITY INVOKER: RLS limits each user to their own properties).
-- Priority: out of service > maintenance > occupied > cleaning > dirty > reserved > available.
-- ---------------------------------------------------------------------------
create or replace function room_board(p_date date default nairobi_today())
returns table(unit_id uuid, property_id uuid, unit_name text, property_name text, status text,
              booking_id uuid, guest_name text, check_out date, next_check_in date, maintenance_note text)
language sql stable as $$
  select u.id, u.property_id, u.name, p.name,
    case
      when u.maintenance_status = 'out_of_service' then 'out_of_service'
      when u.maintenance_status = 'maintenance' then 'maintenance'
      when occ.id is not null then 'occupied'
      when hk.status = 'in_progress' then 'cleaning'
      when hk.status = 'dirty' then 'dirty'
      when res.id is not null then 'reserved'
      else 'available'
    end,
    coalesce(occ.id, res.id),
    g.full_name,
    coalesce(occ.check_out, res.check_out),
    nxt.d,
    u.maintenance_note
  from units u
  join properties p on p.id = u.property_id
  left join lateral (select b.id, b.guest_id, b.check_out from bookings b
                      where b.unit_id = u.id and b.status = 'checked_in' order by b.check_in desc limit 1) occ on true
  left join lateral (select b.id, b.guest_id, b.check_out from bookings b
                      where b.unit_id = u.id and b.status = 'confirmed' and b.check_in = p_date limit 1) res on true
  left join lateral (select t.status from housekeeping_tasks t
                      where t.unit_id = u.id and t.status in ('dirty','in_progress') order by t.created_at limit 1) hk on true
  left join lateral (select min(b.check_in) d from bookings b
                      where b.unit_id = u.id and b.status in ('confirmed','pending') and b.check_in > p_date) nxt on true
  left join guests g on g.id = coalesce(occ.guest_id, res.guest_id)
  where u.active and p.archived_at is null
    and can_access_property((select auth.uid()), u.property_id)   -- units are public to read; the board is staff-only
  order by p.sort, p.name, u.sort, u.name
$$;
grant execute on function room_board(date) to authenticated;

$mig8$;
    -- ---- 0009_booking_requests_notifications.sql ----
    execute $mig9$
-- 0009_booking_requests_notifications.sql
-- 1) Booking requests: guests ask for dates, staff approve / reject / offer other dates. Approval creates a REAL booking
--    (a normal pending hold, with a longer payment window) via the existing create_booking, so the overlap guard,
--    pricing and the M-Pesa flow are all reused. Public booking stays "instant" unless settings.booking_mode = 'request'.
-- 2) In-app notification centre: rows are written by triggers (deduplicated), read state and preferences are per user.

-- ---------------------------------------------------------------------------
-- Settings: booking mode and how long an approved request is held for payment
-- ---------------------------------------------------------------------------
insert into settings(key, value) values ('booking_mode', '"instant"'), ('request_hold_hours', '24') on conflict (key) do nothing;
drop policy if exists settings_public_read on settings;
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes',
                 'mpesa_manual_instructions','mpesa_paybill_display','brand_color','site_content','booking_mode'));

-- ---------------------------------------------------------------------------
-- Is a unit bookable for these dates right now? (same rules as public availability)
-- ---------------------------------------------------------------------------
create or replace function unit_is_free(p_unit uuid, p_in date, p_out date) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from units u
    join properties p on p.id = u.property_id and p.active
    cross join lateral quote_stay(u.id, p_in, p_out) q
    where u.id = p_unit and u.active and p_out > p_in
      and q.nights >= q.min_nights and (u.max_nights is null or q.nights <= u.max_nights)
      and u.maintenance_status = 'ok'
      and not exists (
        select 1 from bookings b
        where b.unit_id = u.id and b.status in ('pending','confirmed','checked_in','blocked')
          and not (b.status = 'pending' and b.hold_expires_at < now())
          and daterange(b.check_in, b.check_out, '[)') && daterange(p_in, p_out, '[)')))
$$;

-- ---------------------------------------------------------------------------
-- Booking requests
-- ---------------------------------------------------------------------------
create table booking_requests (
  id uuid primary key default gen_random_uuid(),
  public_token uuid unique not null default gen_random_uuid(),
  property_id uuid not null references properties,
  unit_id uuid not null references units,
  name text not null check (char_length(name) between 2 and 80),
  phone text not null,
  email text check (email is null or char_length(email) <= 120),
  check_in date not null,
  check_out date not null,
  guests int not null check (guests between 1 and 30),
  message text check (message is null or char_length(message) <= 1000),
  status text not null default 'new' check (status in ('new','approved','rejected','alternative_offered','expired','withdrawn')),
  decision_note text check (decision_note is null or char_length(decision_note) <= 1000),
  alt_check_in date,
  alt_check_out date,
  booking_id uuid references bookings on delete set null,
  decided_by uuid references profiles on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (check_out > check_in),
  check (alt_check_in is null or alt_check_out is null or alt_check_out > alt_check_in),
  check (status <> 'approved' or booking_id is not null)
);
create index on booking_requests (status, created_at desc);
create index on booking_requests (property_id);
create index on booking_requests (unit_id);
create trigger trg_booking_requests_updated before update on booking_requests for each row execute function set_updated_at();

create table booking_request_notes (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references booking_requests on delete cascade,
  user_id uuid references profiles on delete set null,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index on booking_request_notes (request_id, created_at);

alter table booking_requests      enable row level security;
alter table booking_request_notes enable row level security;
revoke all on booking_requests, booking_request_notes from anon;

create policy requests_staff_all on booking_requests for all to authenticated
  using (is_owner_or_manager((select auth.uid())) and can_manage_property((select auth.uid()), property_id))
  with check (is_owner_or_manager((select auth.uid())) and can_manage_property((select auth.uid()), property_id));
create policy request_notes_staff_all on booking_request_notes for all to authenticated
  using (exists (select 1 from booking_requests r where r.id = request_id and can_manage_property((select auth.uid()), r.property_id)))
  with check (user_id = (select auth.uid()) and exists (select 1 from booking_requests r where r.id = request_id and can_manage_property((select auth.uid()), r.property_id)));

create trigger trg_audit_booking_request after insert or update or delete on booking_requests for each row execute function audit_generic('booking_request');

-- ---- public: submit (throttled), follow by secret token, accept other dates, withdraw -----------------------------
create or replace function submit_booking_request(
  p_unit uuid, p_in date, p_out date, p_guests int, p_name text, p_phone text,
  p_email text default null, p_message text default null, p_website text default ''
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_phone text; v_unit units; v_token uuid; n int;
begin
  if coalesce(p_website, '') <> '' then return null; end if;
  v_phone := normalize_ke_phone(p_phone);
  if v_phone is null then raise exception 'Enter a valid Kenyan phone number, for example 0712 345 678.' using errcode = 'check_violation'; end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Please enter your name.' using errcode = 'check_violation'; end if;
  if p_in is null or p_out is null or p_out <= p_in then raise exception 'Check-out must be after check-in.' using errcode = 'check_violation'; end if;
  if p_in < nairobi_today() then raise exception 'Check-in cannot be in the past.' using errcode = 'check_violation'; end if;
  select * into v_unit from units where id = p_unit and active;
  if not found then raise exception 'That place is not available.' using errcode = 'check_violation'; end if;
  if p_guests is null or p_guests < 1 or p_guests > v_unit.max_guests then raise exception 'This place sleeps at most % guests.', v_unit.max_guests using errcode = 'check_violation'; end if;
  if not unit_is_free(p_unit, p_in, p_out) then raise exception 'Those dates are not available. Please choose other dates.' using errcode = 'check_violation'; end if;
  select count(*) into n from rate_limit_events where key = 'request:' || v_phone and created_at > now() - interval '1 hour';
  if n >= 3 then raise exception 'Too many requests from this number. Please wait a while and try again.' using errcode = 'check_violation'; end if;
  select count(*) into n from rate_limit_events where key = 'request:all' and created_at > now() - interval '1 hour';
  if n >= 60 then raise exception 'We are receiving many requests right now. Please try again shortly.' using errcode = 'check_violation'; end if;
  insert into rate_limit_events(key) values ('request:' || v_phone), ('request:all');
  insert into booking_requests(property_id, unit_id, name, phone, email, check_in, check_out, guests, message)
  values (v_unit.property_id, p_unit, trim(p_name), v_phone, nullif(trim(coalesce(p_email, '')), ''), p_in, p_out, p_guests, nullif(trim(coalesce(p_message, '')), ''))
  returning public_token into v_token;
  return v_token;
end $$;
grant execute on function submit_booking_request(uuid,date,date,int,text,text,text,text,text) to anon, authenticated;

-- Safe fields only: no phone, no email, no internal ids.
create or replace function get_booking_request(p_token uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'status', r.status, 'name', r.name, 'check_in', r.check_in, 'check_out', r.check_out, 'guests', r.guests,
    'decision_note', r.decision_note, 'alt_check_in', r.alt_check_in, 'alt_check_out', r.alt_check_out,
    'created_at', r.created_at,
    'unit_name', u.name, 'property_name', p.name, 'property_slug', p.slug,
    'booking_token', case when r.status = 'approved' then b.public_token end,
    'booking_status', case when r.status = 'approved' then b.status::text end)
  from booking_requests r
  join units u on u.id = r.unit_id
  join properties p on p.id = r.property_id
  left join bookings b on b.id = r.booking_id
  where r.public_token = p_token
$$;
grant execute on function get_booking_request(uuid) to anon, authenticated;

create or replace function accept_alternative_dates(p_token uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r booking_requests;
begin
  select * into r from booking_requests where public_token = p_token for update;
  if not found or r.status <> 'alternative_offered' or r.alt_check_in is null then
    raise exception 'There are no new dates to accept.' using errcode = 'check_violation';
  end if;
  if not unit_is_free(r.unit_id, r.alt_check_in, r.alt_check_out) then
    raise exception 'Sorry, those dates have just been taken. Please contact us.' using errcode = 'check_violation';
  end if;
  update booking_requests set check_in = alt_check_in, check_out = alt_check_out, alt_check_in = null, alt_check_out = null, status = 'new' where id = r.id;
end $$;
grant execute on function accept_alternative_dates(uuid) to anon, authenticated;

create or replace function withdraw_booking_request(p_token uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update booking_requests set status = 'withdrawn' where public_token = p_token and status in ('new','alternative_offered');
  if not found then raise exception 'This request can no longer be withdrawn.' using errcode = 'check_violation'; end if;
end $$;
grant execute on function withdraw_booking_request(uuid) to anon, authenticated;

-- ---- staff decisions ------------------------------------------------------------------------------------------
create or replace function approve_booking_request(p_request uuid, p_note text default null) returns bookings
language plpgsql security definer set search_path = public as $$
declare r booking_requests; b bookings; v_hours int;
begin
  perform require_permission('requests.manage');
  select * into r from booking_requests where id = p_request for update;
  if not found or not (is_owner_or_manager(auth.uid()) and can_manage_property(auth.uid(), r.property_id)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if r.status not in ('new','alternative_offered') then
    raise exception 'This request has already been handled (%).', r.status using errcode = 'check_violation';
  end if;
  -- Reuses the booking rules; the overlap guard raises 23P01 if the dates were taken meanwhile.
  b := create_booking(r.unit_id, r.check_in, r.check_out, r.guests, r.name, r.phone, r.email, 'website', 'hold', 0, null, p_note, auth.uid());
  v_hours := greatest(1, least(168, setting_num('request_hold_hours', 24)::int));
  update bookings set hold_expires_at = now() + make_interval(hours => v_hours) where id = b.id returning * into b;
  update booking_requests set status = 'approved', booking_id = b.id, decision_note = nullif(trim(coalesce(p_note, '')), ''),
         decided_by = auth.uid(), decided_at = now() where id = r.id;
  return b;
end $$;
revoke execute on function approve_booking_request(uuid,text) from public, anon;
grant execute on function approve_booking_request(uuid,text) to authenticated;

create or replace function reject_booking_request(p_request uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r booking_requests;
begin
  perform require_permission('requests.manage');
  select * into r from booking_requests where id = p_request for update;
  if not found or not (is_owner_or_manager(auth.uid()) and can_manage_property(auth.uid(), r.property_id)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if r.status not in ('new','alternative_offered') then raise exception 'This request has already been handled (%).', r.status using errcode = 'check_violation'; end if;
  update booking_requests set status = 'rejected', decision_note = nullif(trim(coalesce(p_note, '')), ''), decided_by = auth.uid(), decided_at = now(), alt_check_in = null, alt_check_out = null where id = r.id;
end $$;
revoke execute on function reject_booking_request(uuid,text) from public, anon;
grant execute on function reject_booking_request(uuid,text) to authenticated;

create or replace function offer_alternative_dates(p_request uuid, p_in date, p_out date, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r booking_requests;
begin
  perform require_permission('requests.manage');
  select * into r from booking_requests where id = p_request for update;
  if not found or not (is_owner_or_manager(auth.uid()) and can_manage_property(auth.uid(), r.property_id)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if r.status not in ('new','alternative_offered') then raise exception 'This request has already been handled (%).', r.status using errcode = 'check_violation'; end if;
  if p_in is null or p_out is null or p_out <= p_in or p_in < nairobi_today() then raise exception 'Choose valid future dates.' using errcode = 'check_violation'; end if;
  if not unit_is_free(r.unit_id, p_in, p_out) then raise exception 'Those dates are not available for this unit.' using errcode = 'check_violation'; end if;
  update booking_requests set status = 'alternative_offered', alt_check_in = p_in, alt_check_out = p_out,
         decision_note = nullif(trim(coalesce(p_note, '')), ''), decided_by = auth.uid(), decided_at = now() where id = r.id;
end $$;
revoke execute on function offer_alternative_dates(uuid,date,date,text) from public, anon;
grant execute on function offer_alternative_dates(uuid,date,date,text) to authenticated;

-- ---------------------------------------------------------------------------
-- Notification centre
-- ---------------------------------------------------------------------------
create table notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('booking_request','request_update','inquiry','review','payment','payment_review','cancellation','checkin_soon','checkout_today','balance_due')),
  title text not null,
  body text,
  link text,
  property_id uuid references properties on delete cascade,
  entity_id uuid,
  created_at timestamptz not null default now()
);
create index on notifications (created_at desc);
-- No duplicates: one notification per (kind, record).
create unique index notifications_dedupe on notifications (kind, entity_id) where entity_id is not null;

create table notification_reads (
  user_id uuid not null references profiles on delete cascade,
  notification_id uuid not null references notifications on delete cascade,
  read_at timestamptz not null default now(),
  primary key (user_id, notification_id)
);
create table notification_prefs (
  user_id uuid not null references profiles on delete cascade,
  kind text not null,
  enabled boolean not null default true,
  primary key (user_id, kind)
);

alter table notifications      enable row level security;
alter table notification_reads enable row level security;
alter table notification_prefs enable row level security;
revoke all on notifications, notification_reads, notification_prefs from anon;
revoke insert, update, delete on notifications from authenticated;   -- written only by the triggers below

create policy notifications_staff_read on notifications for select to authenticated
  using (is_owner_or_manager((select auth.uid())) and (property_id is null or can_manage_property((select auth.uid()), property_id)));
create policy notification_reads_own on notification_reads for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy notification_prefs_own on notification_prefs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create or replace function add_notification(p_kind text, p_title text, p_body text, p_link text, p_property uuid, p_entity uuid)
returns void language sql security definer set search_path = public as $$
  insert into notifications(kind, title, body, link, property_id, entity_id) values (p_kind, p_title, p_body, p_link, p_property, p_entity)
  on conflict do nothing
$$;
revoke execute on function add_notification(text,text,text,text,uuid,uuid) from public, anon, authenticated;

create or replace function trg_notify() returns trigger language plpgsql security definer set search_path = public as $$
declare v_ref text; v_prop uuid; v_amount int;
begin
  if tg_table_name = 'inquiries' then
    perform add_notification('inquiry', 'New inquiry from ' || new.name, left(new.message, 140), '/admin/inquiries', new.property_id, new.id);
  elsif tg_table_name = 'reviews' then
    perform add_notification('review', 'New review from ' || new.guest_name || ' (' || new.rating || ' stars)', left(new.body, 140), '/admin/reviews', new.property_id, new.id);
  elsif tg_table_name = 'booking_requests' then
    if tg_op = 'INSERT' then
      perform add_notification('booking_request', 'New booking request from ' || new.name, to_char(new.check_in, 'DD Mon') || ' to ' || to_char(new.check_out, 'DD Mon YYYY') || ', ' || new.guests || ' guest(s)', '/admin/requests', new.property_id, new.id);
    elsif old.status = 'alternative_offered' and new.status = 'new' then
      perform add_notification('request_update', new.name || ' accepted the new dates', to_char(new.check_in, 'DD Mon') || ' to ' || to_char(new.check_out, 'DD Mon YYYY'), '/admin/requests', new.property_id, gen_random_uuid());
    end if;
  elsif tg_table_name = 'payments' then
    if new.status = 'succeeded' and new.kind <> 'refund' and (tg_op = 'INSERT' or old.status is distinct from 'succeeded') then
      select b.reference, b.property_id into v_ref, v_prop from bookings b where b.id = new.booking_id;
      v_amount := new.amount;
      perform add_notification('payment', 'Payment received: KES ' || to_char(v_amount, 'FM999,999,999'), 'Booking ' || coalesce(v_ref, ''), '/admin/bookings/' || new.booking_id, v_prop, new.id);
    end if;
  elsif tg_table_name = 'bookings' then
    if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
      perform add_notification('cancellation', 'Booking cancelled: ' || new.reference, new.cancel_reason, '/admin/bookings/' || new.id, new.property_id, new.id);
    end if;
    if new.payment_review and not old.payment_review then
      perform add_notification('payment_review', 'Payment needs review: ' || new.reference, new.review_reason, '/admin/bookings/' || new.id, new.property_id, new.id);
    end if;
  end if;
  return null;
end $$;
create trigger trg_notify_inquiry   after insert on inquiries        for each row execute function trg_notify();
create trigger trg_notify_review    after insert on reviews          for each row execute function trg_notify();
create trigger trg_notify_request   after insert or update on booking_requests for each row execute function trg_notify();
create trigger trg_notify_payment   after insert or update on payments         for each row execute function trg_notify();
create trigger trg_notify_booking   after update on bookings         for each row execute function trg_notify();

-- Daily: arrivals tomorrow, departures today, unpaid balances close to arrival; and stale requests expire.
create or replace function generate_daily_notifications() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; c int; t date := nairobi_today();
begin
  update booking_requests set status = 'expired' where status in ('new','alternative_offered') and check_in < t;
  insert into notifications(kind, title, body, link, property_id, entity_id)
    select 'checkin_soon', 'Arriving tomorrow: ' || g.full_name, b.reference || ', ' || b.num_guests || ' guest(s)', '/admin/bookings/' || b.id, b.property_id, b.id
    from bookings b join guests g on g.id = b.guest_id where b.status = 'confirmed' and b.check_in = t + 1
    on conflict do nothing;
  get diagnostics c = row_count; n := n + c;
  insert into notifications(kind, title, body, link, property_id, entity_id)
    select 'checkout_today', 'Departing today: ' || g.full_name, b.reference, '/admin/bookings/' || b.id, b.property_id, b.id
    from bookings b join guests g on g.id = b.guest_id where b.status = 'checked_in' and b.check_out = t
    on conflict do nothing;
  get diagnostics c = row_count; n := n + c;
  insert into notifications(kind, title, body, link, property_id, entity_id)
    select 'balance_due', 'Balance due: ' || b.reference, 'KES ' || to_char(b.total_amount - b.amount_paid, 'FM999,999,999') || ' unpaid, arriving ' || to_char(b.check_in, 'DD Mon'), '/admin/bookings/' || b.id, b.property_id, b.id
    from bookings b where b.status in ('confirmed','checked_in') and b.total_amount > b.amount_paid and b.check_in <= t + 2
    on conflict do nothing;
  get diagnostics c = row_count; n := n + c;
  return n;
end $$;
revoke execute on function generate_daily_notifications() from public, anon, authenticated;
grant execute on function generate_daily_notifications() to service_role;

-- ---- reading (SECURITY INVOKER: RLS scopes rows; preferences filter kinds) --------------------------------------
create or replace function my_notifications(p_limit int default 50, p_only_unread boolean default false)
returns table(id uuid, kind text, title text, body text, link text, property_id uuid, created_at timestamptz, is_read boolean)
language sql stable as $$
  select n.id, n.kind, n.title, n.body, n.link, n.property_id, n.created_at, (r.notification_id is not null)
  from notifications n
  left join notification_reads r on r.notification_id = n.id and r.user_id = (select auth.uid())
  where not exists (select 1 from notification_prefs p where p.user_id = (select auth.uid()) and p.kind = n.kind and not p.enabled)
    and (not p_only_unread or r.notification_id is null)
  order by n.created_at desc
  limit least(greatest(p_limit, 1), 200)
$$;
grant execute on function my_notifications(int, boolean) to authenticated;

create or replace function unread_notification_count() returns int
language sql stable as $$
  select count(*)::int from notifications n
  where not exists (select 1 from notification_reads r where r.notification_id = n.id and r.user_id = (select auth.uid()))
    and not exists (select 1 from notification_prefs p where p.user_id = (select auth.uid()) and p.kind = n.kind and not p.enabled)
$$;
grant execute on function unread_notification_count() to authenticated;

-- Mark the given notifications (or every visible unread one when null) as read for the signed-in user.
create or replace function mark_notifications_read(p_ids uuid[] default null) returns void
language sql security invoker as $$
  insert into notification_reads(user_id, notification_id)
  select (select auth.uid()), n.id from notifications n
  where p_ids is null or n.id = any(p_ids)
  on conflict do nothing
$$;
grant execute on function mark_notifications_read(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Daily job (08:10 Nairobi = 05:10 UTC), only where pg_cron exists (same approach as 0004).
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'bnb-daily-notifications';
    perform cron.schedule('bnb-daily-notifications', '10 5 * * *', 'select public.generate_daily_notifications()');
  end if;
end $$;

$mig9$;
    -- ---- 0010_dashboard_overview.sql ----
    execute $mig10$
-- 0010_dashboard_overview.sql
-- One read-only function behind the executive dashboard. SECURITY INVOKER, so RLS limits every number to the
-- properties the caller may see (managers: their properties; owner: all). Cleaners get an error.
-- Returns the selected period and the equally long period before it, so the UI can show change.

create or replace function dashboard_overview(p_from date, p_to date, p_property uuid default null)
returns jsonb
language plpgsql stable as $$
declare
  v_days int; v_pf date; v_pt date;
  cur jsonb; v_by_source jsonb; v_by_method jsonb; v_daily jsonb; v_units int;
begin
  perform require_permission('dashboard.view');
  if not is_owner_or_manager((select auth.uid())) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Choose a valid date range' using errcode = 'check_violation';
  end if;
  if p_to - p_from > 731 then
    raise exception 'Choose a range of two years or less' using errcode = 'check_violation';
  end if;
  v_days := p_to - p_from + 1;
  v_pt := p_from - 1;
  v_pf := p_from - v_days;

  select count(*) into v_units from units u
   where u.active and (p_property is null or u.property_id = p_property);

  -- KPIs for a window [a, b] (inclusive days)
  with w(label, a, b) as (values ('cur', p_from, p_to), ('prev', v_pf, v_pt)),
  rev as (
    select w.label,
      coalesce((select sum(case when pay.kind = 'refund' then -pay.amount else pay.amount end)
                from payments pay join bookings b on b.id = pay.booking_id
                where pay.status = 'succeeded'
                  and (pay.confirmed_at at time zone 'Africa/Nairobi')::date between w.a and w.b
                  and (p_property is null or b.property_id = p_property)), 0)::bigint as revenue
    from w),
  stay as (
    select w.label,
      coalesce(sum(case when b.id is not null then greatest(0, least(b.check_out, w.b + 1) - greatest(b.check_in, w.a)) end), 0)::bigint as nights,
      coalesce(sum(case when b.nights > 0
        then round(b.nightly_total::numeric * greatest(0, least(b.check_out, w.b + 1) - greatest(b.check_in, w.a)) / b.nights) end), 0)::bigint as room_revenue
    from w left join bookings b
      on b.status in ('confirmed','checked_in','checked_out')
     and b.check_in <= w.b and b.check_out > w.a
     and (p_property is null or b.property_id = p_property)
    group by w.label),
  made as (
    select w.label,
      count(b.id) filter (where b.status <> 'blocked')::int as bookings,
      count(b.id) filter (where b.status = 'cancelled')::int as cancellations,
      count(b.id) filter (where b.status = 'no_show')::int as no_shows
    from w left join bookings b
      on (b.created_at at time zone 'Africa/Nairobi')::date between w.a and w.b
     and (p_property is null or b.property_id = p_property)
    group by w.label),
  arr as (
    select w.label, count(b.id)::int as arrivals
    from w left join bookings b
      on b.check_in between w.a and w.b and b.status in ('confirmed','checked_in','checked_out')
     and (p_property is null or b.property_id = p_property)
    group by w.label)
  select jsonb_object_agg(rev.label, jsonb_build_object(
      'revenue', rev.revenue,
      'occupied_nights', stay.nights,
      'room_revenue', stay.room_revenue,
      'bookings', made.bookings, 'cancellations', made.cancellations, 'no_shows', made.no_shows,
      'arrivals', arr.arrivals,
      'available_nights', v_units::bigint * v_days,
      'occupancy_pct', case when v_units > 0 then round(100.0 * stay.nights / (v_units::numeric * v_days), 1) else 0 end,
      'adr', case when stay.nights > 0 then round(stay.room_revenue::numeric / stay.nights) else 0 end,
      'revpar', case when v_units > 0 then round(stay.room_revenue::numeric / (v_units::numeric * v_days)) else 0 end))
  into cur
  from rev join stay using (label) join made using (label) join arr using (label);

  -- Revenue by payment method and bookings by source (current period)
  select coalesce(jsonb_agg(jsonb_build_object('key', k, 'amount', amt) order by amt desc), '[]'::jsonb) into v_by_method
  from (
    select pay.method::text as k,
           sum(case when pay.kind = 'refund' then -pay.amount else pay.amount end)::bigint as amt
    from payments pay join bookings b on b.id = pay.booking_id
    where pay.status = 'succeeded'
      and (pay.confirmed_at at time zone 'Africa/Nairobi')::date between p_from and p_to
      and (p_property is null or b.property_id = p_property)
    group by pay.method) t;

  select coalesce(jsonb_agg(jsonb_build_object('key', k, 'count', c, 'amount', amt) order by c desc), '[]'::jsonb) into v_by_source
  from (
    select b.source::text as k, count(*)::int as c, sum(b.total_amount)::bigint as amt
    from bookings b
    where b.status in ('confirmed','checked_in','checked_out')
      and (b.created_at at time zone 'Africa/Nairobi')::date between p_from and p_to
      and (p_property is null or b.property_id = p_property)
    group by b.source) t;

  -- Daily series for charts: revenue received and nights occupied
  select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'revenue', coalesce(r.amt, 0), 'occupied', coalesce(o.n, 0)) order by d), '[]'::jsonb)
  into v_daily
  from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
  left join lateral (
    select sum(case when pay.kind = 'refund' then -pay.amount else pay.amount end)::bigint amt
    from payments pay join bookings b on b.id = pay.booking_id
    where pay.status = 'succeeded' and (pay.confirmed_at at time zone 'Africa/Nairobi')::date = d::date
      and (p_property is null or b.property_id = p_property)) r on true
  left join lateral (
    select count(*)::int n from bookings b
    where b.status in ('confirmed','checked_in','checked_out') and b.check_in <= d::date and b.check_out > d::date
      and (p_property is null or b.property_id = p_property)) o on true;

  return jsonb_build_object('from', p_from, 'to', p_to, 'days', v_days, 'units', v_units,
    'current', cur->'cur', 'previous', cur->'prev', 'by_method', v_by_method, 'by_source', v_by_source, 'daily', v_daily);
end $$;
grant execute on function dashboard_overview(date, date, uuid) to authenticated;

$mig10$;
    -- ---- 0011_support_tickets.sql ----
    execute $mig11$
-- 0011_support_tickets.sql
-- Internal support tickets: guest complaints, maintenance issues, billing questions. Staff only (owner and managers,
-- managers limited to their properties). Replies are kept as a thread. Everything is audited.

create sequence ticket_no_seq;

create table support_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_no int not null unique default nextval('ticket_no_seq'),
  subject text not null check (char_length(trim(subject)) between 3 and 140),
  description text not null default '' check (char_length(description) <= 4000),
  category text not null default 'general' check (category in ('general','complaint','maintenance','billing','booking','other')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'open' check (status in ('open','in_progress','waiting','resolved','closed')),
  property_id uuid references properties on delete set null,
  booking_id uuid references bookings on delete set null,
  guest_id uuid references guests on delete set null,
  assigned_to uuid references profiles on delete set null,
  created_by uuid references profiles on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on support_tickets (status, priority, created_at desc);
create index on support_tickets (property_id);
create index on support_tickets (assigned_to);
create trigger trg_tickets_updated before update on support_tickets for each row execute function set_updated_at();

-- resolved_at follows the status: set when resolved/closed, cleared when reopened.
create or replace function ticket_status_stamp() returns trigger language plpgsql as $$
begin
  if new.status in ('resolved','closed') then
    new.resolved_at := coalesce(case when tg_op = 'UPDATE' and old.status in ('resolved','closed') then old.resolved_at end, now());
  else
    new.resolved_at := null;
  end if;
  return new;
end $$;
create trigger trg_ticket_stamp before insert or update on support_tickets for each row execute function ticket_status_stamp();

create table support_ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_tickets on delete cascade,
  user_id uuid not null references profiles on delete restrict,
  body text not null check (char_length(trim(body)) between 1 and 4000),
  internal boolean not null default false,
  created_at timestamptz not null default now()
);
create index on support_ticket_messages (ticket_id, created_at);

alter table support_tickets enable row level security;
alter table support_ticket_messages enable row level security;
revoke all on support_tickets, support_ticket_messages from anon;

create policy tickets_staff_all on support_tickets for all to authenticated
  using (is_owner_or_manager((select auth.uid())) and (property_id is null or can_manage_property((select auth.uid()), property_id)))
  with check (is_owner_or_manager((select auth.uid())) and (property_id is null or can_manage_property((select auth.uid()), property_id)));

create policy ticket_messages_staff_all on support_ticket_messages for all to authenticated
  using (exists (select 1 from support_tickets t where t.id = ticket_id and is_owner_or_manager((select auth.uid()))
                 and (t.property_id is null or can_manage_property((select auth.uid()), t.property_id))))
  with check (user_id = (select auth.uid()) and exists (select 1 from support_tickets t where t.id = ticket_id and is_owner_or_manager((select auth.uid()))
                 and (t.property_id is null or can_manage_property((select auth.uid()), t.property_id))));

create trigger trg_audit_ticket after insert or update or delete on support_tickets for each row execute function audit_generic('support_ticket');

$mig11$;
    -- ---- 0012_discount_codes_seo.sql ----
    execute $mig12$
-- 0012_discount_codes_seo.sql
-- Discount codes (checked and applied in the database, never trusted from the browser) and per-listing SEO fields.
--
-- A code's remaining uses are counted from redemptions whose booking is still live (not cancelled / expired / no-show),
-- so a cancelled booking gives its use back. The code row is locked while a booking is created, so two guests can never
-- both take the last use. The discount applies to the room charge only (never the cleaning fee).

create table discount_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null check (code = upper(code) and code ~ '^[A-Z0-9_-]{3,24}$'),
  description text check (description is null or char_length(description) <= 200),
  kind text not null check (kind in ('percent','fixed')),
  value int not null check (value > 0),
  property_id uuid references properties on delete cascade,      -- null = every property
  min_nights int not null default 1 check (min_nights >= 1),
  min_total int not null default 0 check (min_total >= 0),
  valid_from date,
  valid_to date,
  max_uses int check (max_uses is null or max_uses >= 1),
  active boolean not null default true,
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'percent' or value <= 100),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);
create unique index discount_codes_code_uniq on discount_codes (code);
create trigger trg_discount_codes_updated before update on discount_codes for each row execute function set_updated_at();

create table discount_redemptions (
  id uuid primary key default gen_random_uuid(),
  code_id uuid not null references discount_codes on delete restrict,
  booking_id uuid not null unique references bookings on delete cascade,
  amount int not null check (amount > 0),
  created_at timestamptz not null default now()
);
create index on discount_redemptions (code_id);

alter table discount_codes enable row level security;
alter table discount_redemptions enable row level security;
revoke all on discount_codes, discount_redemptions from anon;
-- Codes are never readable by guests (they could list them). Staff manage; managers only for their own properties.
create policy discount_codes_staff_all on discount_codes for all to authenticated
  using (is_owner_or_manager((select auth.uid())) and (property_id is null and has_role((select auth.uid()), 'owner') or property_id is not null and can_manage_property((select auth.uid()), property_id)))
  with check (is_owner_or_manager((select auth.uid())) and (property_id is null and has_role((select auth.uid()), 'owner') or property_id is not null and can_manage_property((select auth.uid()), property_id)));
create policy discount_redemptions_staff_read on discount_redemptions for select to authenticated
  using (exists (select 1 from bookings b where b.id = booking_id and can_manage_property((select auth.uid()), b.property_id)));
create trigger trg_audit_discount_code after insert or update or delete on discount_codes for each row execute function audit_generic('discount_code');

-- Number of live uses of a code.
create or replace function discount_uses(p_code uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from discount_redemptions r join bookings b on b.id = r.booking_id
  where r.code_id = p_code and b.status not in ('cancelled','expired','no_show')
$$;
revoke execute on function discount_uses(uuid) from public, anon, authenticated;

-- Shared rule check. Returns the discount amount, or a plain-language reason it cannot be used.
create or replace function evaluate_discount(p_code_id uuid, p_unit uuid, p_in date, p_out date)
returns table(ok boolean, message text, amount int)
language plpgsql stable security definer set search_path = public as $$
declare c discount_codes; u units; q record; v_amount int;
begin
  select * into c from discount_codes where id = p_code_id;
  select * into u from units where id = p_unit and active;
  if c.id is null or not c.active or u.id is null then return query select false, 'That code is not valid.', 0; return; end if;
  if c.property_id is not null and c.property_id <> u.property_id then return query select false, 'That code does not apply to this place.', 0; return; end if;
  if c.valid_from is not null and nairobi_today() < c.valid_from then return query select false, 'That code is not active yet.', 0; return; end if;
  if c.valid_to is not null and nairobi_today() > c.valid_to then return query select false, 'That code has expired.', 0; return; end if;
  select * into q from quote_stay(p_unit, p_in, p_out);
  if q.nights < c.min_nights then return query select false, format('This code needs a stay of at least %s night(s).', c.min_nights), 0; return; end if;
  if q.nightly_total < c.min_total then return query select false, format('This code needs a room total of at least KES %s.', c.min_total), 0; return; end if;
  if c.max_uses is not null and discount_uses(c.id) >= c.max_uses then return query select false, 'That code has been fully used.', 0; return; end if;
  v_amount := case c.kind when 'percent' then (q.nightly_total * c.value) / 100 else least(c.value, q.nightly_total) end;
  if v_amount < 1 then return query select false, 'That code gives no discount on this stay.', 0; return; end if;
  return query select true, 'Code applied.', v_amount;
end $$;
revoke execute on function evaluate_discount(uuid, uuid, date, date) from public, anon, authenticated;

-- Guest-facing preview. Throttled so codes cannot be guessed in bulk. Wrong and unknown codes get the same answer.
create or replace function quote_discount_code(p_code text, p_unit uuid, p_in date, p_out date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_code text := upper(trim(coalesce(p_code, ''))); c discount_codes; e record; n int;
begin
  select count(*) into n from rate_limit_events where key = 'discount:all' and created_at > now() - interval '1 hour';
  if n >= 300 then raise exception 'Too many attempts. Please try again later.' using errcode = 'check_violation'; end if;
  insert into rate_limit_events(key) values ('discount:all');
  select * into c from discount_codes where code = v_code;
  if c.id is null then return jsonb_build_object('ok', false, 'message', 'That code is not valid.', 'amount', 0); end if;
  select * into e from evaluate_discount(c.id, p_unit, p_in, p_out);
  return jsonb_build_object('ok', e.ok, 'message', e.message, 'amount', e.amount);
end $$;
grant execute on function quote_discount_code(text, uuid, date, date) to anon, authenticated;

-- Atomic create-with-code (used by the create-booking edge function). Fails the whole booking if the code is no good.
create or replace function create_booking_with_code(
  p_code text,
  p_unit uuid, p_in date, p_out date, p_guests int,
  p_guest_name text, p_guest_phone text, p_guest_email text default null,
  p_source booking_source default 'website'
) returns bookings
language plpgsql security definer set search_path = public as $$
declare c discount_codes; e record; b bookings;
begin
  select * into c from discount_codes where code = upper(trim(coalesce(p_code, ''))) for update;   -- serialises last-use races
  if c.id is null then raise exception 'That code is not valid.' using errcode = 'check_violation'; end if;
  select * into e from evaluate_discount(c.id, p_unit, p_in, p_out);
  if not e.ok then raise exception '%', e.message using errcode = 'check_violation'; end if;
  b := create_booking(p_unit, p_in, p_out, p_guests, p_guest_name, p_guest_phone, p_guest_email, p_source, 'hold', e.amount, null, null, null);
  insert into discount_redemptions(code_id, booking_id, amount) values (c.id, b.id, e.amount);
  return b;
end $$;
revoke execute on function create_booking_with_code(text,uuid,date,date,int,text,text,text,booking_source) from public, anon, authenticated;
grant execute on function create_booking_with_code(text,uuid,date,date,int,text,text,text,booking_source) to service_role;

-- ---------------------------------------------------------------------------
-- Per-listing SEO
-- ---------------------------------------------------------------------------
alter table properties
  add column seo_title text check (seo_title is null or char_length(seo_title) <= 70),
  add column seo_description text check (seo_description is null or char_length(seo_description) <= 200);

$mig12$;
    -- ---- 0013_guest_credit_statements.sql ----
    execute $mig13$
-- 0013_guest_credit_statements.sql
-- Guest credit (an append-only ledger: nothing is ever edited or deleted), applying credit to a booking balance,
-- VIP / do-not-rebook flags, and a guest statement. Credit can never go below zero.

alter table guests
  add column vip boolean not null default false,
  add column flagged boolean not null default false,
  add column flag_reason text check (flag_reason is null or char_length(flag_reason) <= 300),
  add constraint guests_flag_reason_needed check (not flagged or char_length(trim(coalesce(flag_reason, ''))) >= 3);

-- Who may see a guest: owner, or a manager with a booking from that guest at one of their properties.
create or replace function can_see_guest(_uid uuid, _guest uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_role(_uid, 'owner')
      or (has_role(_uid, 'manager') and exists (select 1 from bookings b where b.guest_id = _guest and can_manage_property(_uid, b.property_id)))
$$;

create table guest_credit_entries (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid not null references guests on delete restrict,
  amount int not null check (amount <> 0),
  kind text not null check (kind in ('credit_added','credit_used','adjustment')),
  reason text not null check (char_length(trim(reason)) between 3 and 300),
  booking_id uuid references bookings on delete set null,
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  check ((kind = 'credit_added' and amount > 0) or (kind = 'credit_used' and amount < 0 and booking_id is not null) or kind = 'adjustment')
);
create index on guest_credit_entries (guest_id, created_at);

alter table guest_credit_entries enable row level security;
revoke all on guest_credit_entries from anon;
revoke insert, update, delete on guest_credit_entries from authenticated;   -- writes only through the functions below
create policy credit_staff_read on guest_credit_entries for select to authenticated
  using (can_see_guest((select auth.uid()), guest_id));
create trigger trg_audit_credit after insert on guest_credit_entries for each row execute function audit_generic('guest_credit');

create or replace function guest_credit_balance(p_guest uuid) returns int
language sql stable security definer set search_path = public as $$
  select case when can_see_guest((select auth.uid()), p_guest)
              then coalesce((select sum(amount) from guest_credit_entries where guest_id = p_guest), 0)::int end
$$;
grant execute on function guest_credit_balance(uuid) to authenticated;

-- Add credit (refund held as credit, goodwill, prepayment). Owner or manager who can see the guest.
create or replace function add_guest_credit(p_guest uuid, p_amount int, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); v_bal int;
begin
  perform require_permission('credit.manage');
  if not can_see_guest(v_uid, p_guest) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_amount is null or p_amount < 1 then raise exception 'Enter an amount greater than zero.' using errcode = 'check_violation'; end if;
  perform 1 from guests where id = p_guest for update;
  insert into guest_credit_entries(guest_id, amount, kind, reason, created_by) values (p_guest, p_amount, 'credit_added', trim(p_reason), v_uid);
  select coalesce(sum(amount), 0) into v_bal from guest_credit_entries where guest_id = p_guest;
  return v_bal;
end $$;
grant execute on function add_guest_credit(uuid, int, text) to authenticated;

-- Owner-only correction (positive or negative). The balance may not go below zero.
create or replace function adjust_guest_credit(p_guest uuid, p_amount int, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); v_bal int;
begin
  if not has_role(v_uid, 'owner') then raise exception 'Only the owner can adjust credit' using errcode = '42501'; end if;
  if p_amount is null or p_amount = 0 then raise exception 'Enter a non-zero amount.' using errcode = 'check_violation'; end if;
  perform 1 from guests where id = p_guest for update;
  insert into guest_credit_entries(guest_id, amount, kind, reason, created_by) values (p_guest, p_amount, 'adjustment', trim(p_reason), v_uid);
  select coalesce(sum(amount), 0) into v_bal from guest_credit_entries where guest_id = p_guest;
  if v_bal < 0 then raise exception 'Credit cannot go below zero.' using errcode = 'check_violation'; end if;
  return v_bal;
end $$;
grant execute on function adjust_guest_credit(uuid, int, text) to authenticated;

-- Use credit towards a booking: records a payment (so the booking totals stay correct) and the ledger entry together.
create or replace function apply_guest_credit(p_booking uuid, p_amount int) returns int
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); b bookings; v_bal int; v_due int;
begin
  perform require_permission('credit.manage');
  select * into b from bookings where id = p_booking for update;
  if not found or b.guest_id is null or not can_manage_property(v_uid, b.property_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if b.status not in ('pending','confirmed','checked_in','checked_out') then raise exception 'This booking cannot take a payment.' using errcode = 'check_violation'; end if;
  if p_amount is null or p_amount < 1 then raise exception 'Enter an amount greater than zero.' using errcode = 'check_violation'; end if;
  v_due := b.total_amount - b.amount_paid;
  if p_amount > v_due then raise exception 'That is more than the balance of KES %.', v_due using errcode = 'check_violation'; end if;
  perform 1 from guests where id = b.guest_id for update;
  select coalesce(sum(amount), 0) into v_bal from guest_credit_entries where guest_id = b.guest_id;
  if p_amount > v_bal then raise exception 'The guest only has KES % credit.', v_bal using errcode = 'check_violation'; end if;
  insert into payments(booking_id, kind, method, status, amount, confirmed_at, recorded_by)
    values (b.id, case when p_amount >= v_due and b.amount_paid = 0 then 'full'::payment_kind when b.amount_paid = 0 then 'deposit'::payment_kind else 'balance'::payment_kind end,
            'other', 'succeeded', p_amount, now(), v_uid);
  insert into guest_credit_entries(guest_id, amount, kind, reason, booking_id, created_by)
    values (b.guest_id, -p_amount, 'credit_used', 'Applied to booking ' || b.reference, b.id, v_uid);
  return v_bal - p_amount;
end $$;
grant execute on function apply_guest_credit(uuid, int) to authenticated;

-- Statement: every booking, payment and credit movement for a guest, under the caller's own access rules.
create or replace function guest_statement(p_guest uuid) returns jsonb
language plpgsql stable security invoker as $$
declare g guests; v_bookings jsonb; v_payments jsonb; v_credit jsonb; v_bal int;
begin
  select * into g from guests where id = p_guest;
  if not found then raise exception 'Guest not found' using errcode = 'no_data_found'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('reference', b.reference, 'property', p.name, 'check_in', b.check_in, 'check_out', b.check_out,
      'status', b.status, 'total', b.total_amount, 'discount', b.discount, 'paid', b.amount_paid,
      'balance', case when b.status in ('cancelled','expired','no_show','blocked') then 0 else greatest(b.total_amount - b.amount_paid, 0) end) order by b.check_in desc), '[]'::jsonb)
    into v_bookings from bookings b join properties p on p.id = b.property_id where b.guest_id = p_guest;
  select coalesce(jsonb_agg(jsonb_build_object('reference', b.reference, 'kind', pay.kind, 'method', pay.method, 'amount', pay.amount,
      'receipt', pay.mpesa_receipt, 'at', pay.confirmed_at) order by pay.confirmed_at desc), '[]'::jsonb)
    into v_payments from payments pay join bookings b on b.id = pay.booking_id where b.guest_id = p_guest and pay.status = 'succeeded';
  select coalesce(jsonb_agg(jsonb_build_object('amount', amount, 'kind', kind, 'reason', reason, 'at', created_at) order by created_at desc), '[]'::jsonb),
         coalesce(sum(amount), 0)::int
    into v_credit, v_bal from guest_credit_entries where guest_id = p_guest;
  return jsonb_build_object('guest', jsonb_build_object('name', g.full_name, 'phone', g.phone, 'email', g.email),
    'bookings', v_bookings, 'payments', v_payments, 'credit', v_credit, 'credit_balance', v_bal);
end $$;
grant execute on function guest_statement(uuid) to authenticated;

$mig13$;
    -- ---- 0014_checkin_checkout.sql ----
    execute $mig14$
-- 0014_checkin_checkout.sql
-- Digital check-in / check-out. The rules live in the database: a guest can only be checked in when the deposit is
-- in, the unit is free and clean, and an early arrival is explicitly approved. Check-out refuses to leave money owing
-- unless the balance is acknowledged. Extra charges are a ledger of their own (voided, never deleted).

insert into settings(key, value) values ('early_checkin_fee','0'), ('late_checkout_fee','0') on conflict (key) do nothing;

create table booking_charges (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings on delete restrict,
  label text not null check (char_length(trim(label)) between 2 and 80),
  amount int not null check (amount > 0),
  voided boolean not null default false,
  void_reason text check (void_reason is null or char_length(void_reason) <= 200),
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now()
);
create index on booking_charges (booking_id);

create table checkin_records (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings on delete restrict,
  unit_id uuid not null references units,
  arrived_at timestamptz not null default now(),
  guests int not null check (guests >= 1),
  id_verified boolean not null default false,
  id_note text check (id_note is null or char_length(id_note) <= 300),   -- how identity was verified (no ID numbers stored here)
  early boolean not null default false,
  guest_requests text check (guest_requests is null or char_length(guest_requests) <= 500),
  notes text check (notes is null or char_length(notes) <= 500),
  received_by uuid references profiles on delete set null,
  created_at timestamptz not null default now()
);
create table checkout_records (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings on delete restrict,
  departed_at timestamptz not null default now(),
  late boolean not null default false,
  balance_left int not null default 0 check (balance_left >= 0),
  notes text check (notes is null or char_length(notes) <= 500),
  received_by uuid references profiles on delete set null,
  created_at timestamptz not null default now()
);

alter table booking_charges enable row level security;
alter table checkin_records enable row level security;
alter table checkout_records enable row level security;
revoke all on booking_charges, checkin_records, checkout_records from anon;
revoke insert, update, delete on booking_charges, checkin_records, checkout_records from authenticated;
create policy charges_read on booking_charges for select to authenticated
  using (exists (select 1 from bookings b where b.id = booking_id and can_manage_property((select auth.uid()), b.property_id)));
create policy checkin_read on checkin_records for select to authenticated
  using (exists (select 1 from bookings b where b.id = booking_id and can_manage_property((select auth.uid()), b.property_id)));
create policy checkout_read on checkout_records for select to authenticated
  using (exists (select 1 from bookings b where b.id = booking_id and can_manage_property((select auth.uid()), b.property_id)));
create trigger trg_audit_charge   after insert or update on booking_charges  for each row execute function audit_generic('booking_charge');
create trigger trg_audit_checkin  after insert on checkin_records  for each row execute function audit_generic('checkin');
create trigger trg_audit_checkout after insert on checkout_records for each row execute function audit_generic('checkout');

-- Charges change the booking total. Voiding takes the amount back off. (Totals can never drop below what was paid minus refunds elsewhere.)
create or replace function apply_charge_total() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and not new.voided then
    update bookings set total_amount = total_amount + new.amount where id = new.booking_id;
  elsif tg_op = 'UPDATE' and new.voided and not old.voided then
    update bookings set total_amount = greatest(total_amount - new.amount, 0) where id = new.booking_id;
  end if;
  return new;
end $$;
create trigger trg_charge_total after insert or update on booking_charges for each row execute function apply_charge_total();

create or replace function add_booking_charge(p_booking uuid, p_label text, p_amount int) returns booking_charges
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); b bookings; c booking_charges;
begin
  perform require_permission('bookings.manage');
  select * into b from bookings where id = p_booking for update;
  if not found or not can_manage_property(v_uid, b.property_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if b.status not in ('confirmed','checked_in','checked_out') then raise exception 'Charges can only be added to a confirmed or active stay.' using errcode = 'check_violation'; end if;
  insert into booking_charges(booking_id, label, amount, created_by) values (p_booking, trim(p_label), p_amount, v_uid) returning * into c;
  return c;
end $$;
grant execute on function add_booking_charge(uuid, text, int) to authenticated;

create or replace function void_booking_charge(p_charge uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); c booking_charges; b bookings;
begin
  perform require_permission('bookings.manage');
  select * into c from booking_charges where id = p_charge for update;
  if not found then raise exception 'Charge not found' using errcode = 'no_data_found'; end if;
  select * into b from bookings where id = c.booking_id;
  if not can_manage_property(v_uid, b.property_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if c.voided then return; end if;
  if char_length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason.' using errcode = 'check_violation'; end if;
  update booking_charges set voided = true, void_reason = trim(p_reason) where id = p_charge;
end $$;
grant execute on function void_booking_charge(uuid, text) to authenticated;

create or replace function check_in_booking(
  p_booking uuid, p_unit uuid default null, p_guests int default null, p_id_verified boolean default false,
  p_id_note text default null, p_requests text default null, p_notes text default null,
  p_early_approved boolean default false, p_waive_deposit boolean default false
) returns checkin_records
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); b bookings; v_unit units; v_target uuid; r checkin_records; v_today date := nairobi_today(); v_early boolean;
begin
  perform require_permission('checkin.manage');
  select * into b from bookings where id = p_booking for update;
  if not found or not can_manage_property(v_uid, b.property_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if b.status <> 'confirmed' then raise exception 'Only a confirmed booking can be checked in (this one is %).', b.status using errcode = 'check_violation'; end if;
  if v_today >= b.check_out then raise exception 'The stay has already ended.' using errcode = 'check_violation'; end if;
  v_early := v_today < b.check_in;
  if v_early and not p_early_approved then
    raise exception 'Arrival is before the booked date. Approve the early check-in to continue.' using errcode = 'check_violation';
  end if;
  if b.amount_paid < b.deposit_required and not p_waive_deposit then
    raise exception 'The deposit of KES % has not been received.', b.deposit_required using errcode = 'check_violation';
  end if;
  if p_waive_deposit and not has_role(v_uid, 'owner') and not has_role(v_uid, 'manager') then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_guests is not null and (p_guests < 1) then raise exception 'Guest count must be at least 1.' using errcode = 'check_violation'; end if;

  v_target := coalesce(p_unit, b.unit_id);
  select * into v_unit from units where id = v_target and property_id = b.property_id and active;
  if not found then raise exception 'That room is not available at this property.' using errcode = 'check_violation'; end if;
  if v_unit.maintenance_status <> 'ok' then raise exception 'That room is under maintenance.' using errcode = 'check_violation'; end if;
  if p_guests is not null and p_guests > v_unit.max_guests then raise exception 'That room sleeps at most % guests.', v_unit.max_guests using errcode = 'check_violation'; end if;
  -- the room must be physically free right now (a guest who has not left yet) and clean
  if exists (select 1 from bookings x where x.unit_id = v_target and x.id <> b.id and x.status = 'checked_in') then
    raise exception 'That room still has a guest checked in.' using errcode = 'check_violation';
  end if;
  if exists (select 1 from housekeeping_tasks t where t.unit_id = v_target and t.status in ('dirty','in_progress')) then
    raise exception 'That room still needs cleaning.' using errcode = 'check_violation';
  end if;
  if v_target <> b.unit_id then
    update bookings set unit_id = v_target where id = b.id;      -- the exclusion constraint rejects an overlap (23P01)
  end if;
  update bookings set status = 'checked_in' where id = b.id;
  insert into checkin_records(booking_id, unit_id, guests, id_verified, id_note, early, guest_requests, notes, received_by)
    values (b.id, v_target, coalesce(p_guests, b.num_guests), coalesce(p_id_verified, false), nullif(trim(coalesce(p_id_note, '')), ''), v_early,
            nullif(trim(coalesce(p_requests, '')), ''), nullif(trim(coalesce(p_notes, '')), ''), v_uid)
    returning * into r;
  if p_guests is not null and p_guests <> b.num_guests then update bookings set num_guests = p_guests where id = b.id; end if;
  return r;
end $$;
grant execute on function check_in_booking(uuid, uuid, int, boolean, text, text, text, boolean, boolean) to authenticated;

create or replace function check_out_booking(p_booking uuid, p_notes text default null, p_late_fee int default 0, p_accept_balance boolean default false)
returns checkout_records
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); b bookings; r checkout_records; v_due int; v_late boolean;
begin
  perform require_permission('checkin.manage');
  select * into b from bookings where id = p_booking for update;
  if not found or not can_manage_property(v_uid, b.property_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if b.status <> 'checked_in' then raise exception 'Only a checked-in guest can be checked out (this booking is %).', b.status using errcode = 'check_violation'; end if;
  v_late := nairobi_today() > b.check_out;
  if coalesce(p_late_fee, 0) > 0 then
    insert into booking_charges(booking_id, label, amount, created_by) values (b.id, 'Late check-out', p_late_fee, v_uid);
    select * into b from bookings where id = p_booking;
  end if;
  v_due := greatest(b.total_amount - b.amount_paid, 0);
  if v_due > 0 and not p_accept_balance then
    raise exception 'The guest still owes KES %. Record the payment or confirm the balance.', v_due using errcode = 'check_violation';
  end if;
  update bookings set status = 'checked_out' where id = b.id;       -- the existing trigger creates the housekeeping task
  insert into checkout_records(booking_id, late, balance_left, notes, received_by)
    values (b.id, v_late, v_due, nullif(trim(coalesce(p_notes, '')), ''), v_uid) returning * into r;
  return r;
end $$;
grant execute on function check_out_booking(uuid, text, int, boolean) to authenticated;

-- Today's operational screen: expected arrivals, guests in house due to leave, and room readiness. Respects RLS.
create or replace function arrivals_departures(p_date date default nairobi_today()) returns jsonb
language sql stable security invoker as $$
  select jsonb_build_object(
    'arrivals', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'reference', b.reference, 'guest', g.full_name, 'phone', g.phone,
        'property', p.name, 'unit', u.name, 'unit_id', b.unit_id, 'guests', b.num_guests, 'check_in', b.check_in, 'check_out', b.check_out, 'status', b.status,
        'balance', greatest(b.total_amount - b.amount_paid, 0), 'deposit_ok', b.amount_paid >= b.deposit_required,
        'room_ready', not exists (select 1 from housekeeping_tasks t where t.unit_id = b.unit_id and t.status in ('dirty','in_progress'))
                      and not exists (select 1 from bookings x where x.unit_id = b.unit_id and x.id <> b.id and x.status = 'checked_in'))
        order by p.name, u.name)
      from bookings b join units u on u.id = b.unit_id join properties p on p.id = b.property_id left join guests g on g.id = b.guest_id
      where b.check_in = p_date and b.status in ('confirmed','pending')), '[]'::jsonb),
    'in_house', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'reference', b.reference, 'guest', g.full_name, 'phone', g.phone,
        'property', p.name, 'unit', u.name, 'check_out', b.check_out, 'status', b.status,
        'balance', greatest(b.total_amount - b.amount_paid, 0), 'due_out', b.check_out <= p_date, 'overdue', b.check_out < p_date)
        order by b.check_out, p.name, u.name)
      from bookings b join units u on u.id = b.unit_id join properties p on p.id = b.property_id left join guests g on g.id = b.guest_id
      where b.status = 'checked_in'), '[]'::jsonb))
$$;
grant execute on function arrivals_departures(date) to authenticated;

$mig14$;
    -- ---- 0015_blocked_dates_maintenance.sql ----
    execute $mig15$
-- 0015_blocked_dates_maintenance.sql
-- Blocking dates for one room, several rooms or a whole property (with a reason), refusing to cover a real booking,
-- plus maintenance requests that can take a room out of service while they are open.

create table blocked_ranges (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties on delete cascade,
  scope text not null check (scope in ('unit','units','property')),
  reason text not null check (reason in ('maintenance','renovation','private_use','closure','other')),
  note text check (note is null or char_length(note) <= 300),
  start_date date not null,
  end_date date not null,                       -- exclusive, like check_out
  created_by uuid references profiles on delete set null,
  released_at timestamptz,
  released_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  check (end_date > start_date)
);
create index on blocked_ranges (property_id, start_date);
alter table bookings add column block_range_id uuid references blocked_ranges on delete set null;
create index on bookings (block_range_id) where block_range_id is not null;

alter table blocked_ranges enable row level security;
revoke all on blocked_ranges from anon;
revoke insert, update, delete on blocked_ranges from authenticated;
create policy blocked_ranges_read on blocked_ranges for select to authenticated using (can_manage_property((select auth.uid()), property_id));
create trigger trg_audit_blocked_range after insert or update on blocked_ranges for each row execute function audit_generic('blocked_range');

-- p_units null = every active unit of the property.
create or replace function block_dates(p_property uuid, p_units uuid[], p_in date, p_out date, p_reason text, p_note text default null)
returns blocked_ranges
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); v_units uuid[]; r blocked_ranges; v_scope text; v_clash text; u uuid;
begin
  perform require_permission('blocked.manage');
  if not can_manage_property(v_uid, p_property) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_out is null or p_in is null or p_out <= p_in then raise exception 'The end date must be after the start date.' using errcode = 'check_violation'; end if;
  if p_reason not in ('maintenance','renovation','private_use','closure','other') then raise exception 'Choose a reason.' using errcode = 'check_violation'; end if;
  perform expire_stale_holds();
  if p_units is null then
    select array_agg(id) into v_units from units where property_id = p_property and active;
    v_scope := 'property';
  else
    select array_agg(id) into v_units from units where property_id = p_property and id = any(p_units);
    if coalesce(array_length(v_units, 1), 0) <> coalesce(array_length(p_units, 1), 0) then raise exception 'One of the rooms does not belong to this property.' using errcode = 'check_violation'; end if;
    v_scope := case when array_length(v_units, 1) = 1 then 'unit' else 'units' end;
  end if;
  if v_units is null then raise exception 'This property has no rooms to block.' using errcode = 'check_violation'; end if;

  -- Never cover a live booking: list what is in the way so it can be moved or cancelled first.
  select string_agg(b.reference || ' (' || un.name || ')', ', ') into v_clash
  from bookings b join units un on un.id = b.unit_id
  where b.unit_id = any(v_units) and b.status in ('pending','confirmed','checked_in','blocked')
    and daterange(b.check_in, b.check_out, '[)') && daterange(p_in, p_out, '[)');
  if v_clash is not null then
    raise exception 'These dates overlap existing reservations or blocks: %. Move or cancel them first.', v_clash using errcode = 'check_violation';
  end if;

  insert into blocked_ranges(property_id, scope, reason, note, start_date, end_date, created_by)
    values (p_property, v_scope, p_reason, nullif(trim(coalesce(p_note, '')), ''), p_in, p_out, v_uid) returning * into r;
  foreach u in array v_units loop
    insert into bookings(property_id, unit_id, check_in, check_out, status, source, num_guests, notes, created_by, block_range_id)
      values (p_property, u, p_in, p_out, 'blocked', 'manual', 1, initcap(replace(p_reason, '_', ' ')) || coalesce(': ' || r.note, ''), v_uid, r.id);
  end loop;
  return r;
end $$;
grant execute on function block_dates(uuid, uuid[], date, date, text, text) to authenticated;

create or replace function release_blocked_range(p_range uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); r blocked_ranges;
begin
  perform require_permission('blocked.manage');
  select * into r from blocked_ranges where id = p_range for update;
  if not found or not can_manage_property(v_uid, r.property_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if r.released_at is not null then return; end if;
  update bookings set status = 'cancelled' where block_range_id = p_range and status = 'blocked';
  update blocked_ranges set released_at = now(), released_by = v_uid where id = p_range;
end $$;
grant execute on function release_blocked_range(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Maintenance requests
-- ---------------------------------------------------------------------------
create table maintenance_requests (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties on delete cascade,
  unit_id uuid references units on delete set null,
  title text not null check (char_length(trim(title)) between 3 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'open' check (status in ('open','assigned','in_progress','completed','cancelled')),
  assigned_to uuid references profiles on delete set null,
  reported_by uuid references profiles on delete set null,
  start_date date,
  expected_completion date,
  completed_at timestamptz,
  completion_notes text check (completion_notes is null or char_length(completion_notes) <= 1000),
  takes_unit_offline boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (unit_id is not null or not takes_unit_offline),
  check (expected_completion is null or start_date is null or expected_completion >= start_date),
  check (status <> 'completed' or char_length(trim(coalesce(completion_notes, ''))) >= 3)
);
create index on maintenance_requests (property_id, status);
create index on maintenance_requests (unit_id) where unit_id is not null;
create trigger trg_maint_updated before update on maintenance_requests for each row execute function set_updated_at();

alter table maintenance_requests enable row level security;
revoke all on maintenance_requests from anon;
-- Managers: everything at their properties. Any staff member (housekeeping included) can report an issue and see what they reported
-- or what is assigned to them; assigned staff can move their own request along.
create policy maint_manager_all on maintenance_requests for all to authenticated
  using (can_manage_property((select auth.uid()), property_id)) with check (can_manage_property((select auth.uid()), property_id));
create policy maint_staff_read on maintenance_requests for select to authenticated
  using (reported_by = (select auth.uid()) or assigned_to = (select auth.uid()));
create policy maint_staff_report on maintenance_requests for insert to authenticated
  with check (reported_by = (select auth.uid()) and can_access_property((select auth.uid()), property_id) and assigned_to is null and not takes_unit_offline and status = 'open');
create policy maint_assignee_update on maintenance_requests for update to authenticated
  using (assigned_to = (select auth.uid())) with check (assigned_to = (select auth.uid()));

-- Stamp completion; keep the room's maintenance flag in step with open "takes room offline" requests.
create or replace function maintenance_sync() returns trigger language plpgsql security definer set search_path = public as $$
declare
begin
  if tg_op <> 'DELETE' then
    if new.status = 'completed' and (tg_op = 'INSERT' or old.status <> 'completed') then new.completed_at := now(); end if;
    if new.status <> 'completed' then new.completed_at := null; end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_maint_stamp before insert or update on maintenance_requests for each row execute function maintenance_sync();

create or replace function maintenance_unit_flag() returns trigger language plpgsql security definer set search_path = public as $$
declare v_unit uuid; v_open record;
begin
  for v_unit in select distinct x from unnest(array[case when tg_op <> 'INSERT' then old.unit_id end, case when tg_op <> 'DELETE' then new.unit_id end]) x where x is not null loop
    select id, title into v_open from maintenance_requests
      where unit_id = v_unit and takes_unit_offline and status in ('open','assigned','in_progress') order by created_at limit 1;
    if v_open.id is not null then
      update units set maintenance_status = 'maintenance', maintenance_note = left(v_open.title, 300) where id = v_unit and maintenance_status = 'ok';
    else
      update units set maintenance_status = 'ok', maintenance_note = null
        where id = v_unit and maintenance_status = 'maintenance' and exists (select 1 from maintenance_requests m where m.unit_id = v_unit);
    end if;
  end loop;
  return null;
end $$;
create trigger trg_maint_unit_flag after insert or update or delete on maintenance_requests for each row execute function maintenance_unit_flag();
create trigger trg_audit_maintenance after insert or update or delete on maintenance_requests for each row execute function audit_generic('maintenance_request');

$mig15$;
    -- ---- 0016_media_gallery_banners.sql ----
    execute $mig16$
-- 0016_media_gallery_banners.sql
-- Media library (files already live in the public "property-images" bucket), a managed public gallery with
-- categories, and homepage banners with a publish window. Only staff write; the public sees what is published.

create table media_assets (
  id uuid primary key default gen_random_uuid(),
  url text not null unique check (url ~ '^https://'),
  storage_path text not null,
  kind text not null default 'image' check (kind in ('image','video')),
  title text check (title is null or char_length(title) <= 120),
  alt_text text check (alt_text is null or char_length(alt_text) <= 200),
  category text not null default 'general' check (char_length(category) between 1 and 40),
  size_bytes int check (size_bytes is null or size_bytes >= 0),
  uploaded_by uuid references profiles on delete set null,
  created_at timestamptz not null default now()
);
create index on media_assets (category, created_at desc);

create table gallery_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 40),
  sort int not null default 0,
  published boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index gallery_categories_name_uniq on gallery_categories (lower(name));

create table gallery_items (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references gallery_categories on delete cascade,
  url text not null check (url ~ '^https://'),
  kind text not null default 'image' check (kind in ('image','video')),
  alt_text text check (alt_text is null or char_length(alt_text) <= 200),
  caption text check (caption is null or char_length(caption) <= 140),
  sort int not null default 0,
  published boolean not null default true,
  created_at timestamptz not null default now()
);
create index on gallery_items (category_id, sort);

create table homepage_banners (
  id uuid primary key default gen_random_uuid(),
  placement text not null check (placement in ('hero','promo')),
  title text check (title is null or char_length(title) <= 100),
  subtitle text check (subtitle is null or char_length(subtitle) <= 200),
  image_url text not null check (image_url ~ '^https://'),
  link_url text check (link_url is null or link_url ~ '^(https://|/)'),
  link_label text check (link_label is null or char_length(link_label) <= 40),
  sort int not null default 0,
  published boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create index on homepage_banners (placement, sort);

alter table media_assets enable row level security;
alter table gallery_categories enable row level security;
alter table gallery_items enable row level security;
alter table homepage_banners enable row level security;
revoke insert, update, delete on media_assets, gallery_categories, gallery_items, homepage_banners from anon;
revoke all on media_assets from anon;

create policy media_staff_all on media_assets for all to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy gallery_cat_public on gallery_categories for select to anon, authenticated using (published);
create policy gallery_cat_staff on gallery_categories for all to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy gallery_items_public on gallery_items for select to anon, authenticated
  using (published and exists (select 1 from gallery_categories c where c.id = category_id and c.published));
create policy gallery_items_staff on gallery_items for all to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy banners_public on homepage_banners for select to anon, authenticated
  using (published and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));
create policy banners_staff on homepage_banners for all to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));

create trigger trg_audit_banner  after insert or update or delete on homepage_banners  for each row execute function audit_generic('homepage_banner');
create trigger trg_audit_galitem after insert or update or delete on gallery_items     for each row execute function audit_generic('gallery_item');

-- Is a file still used anywhere on the site?
create or replace function media_in_use(p_url text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from gallery_items where url = p_url)
      or exists (select 1 from homepage_banners where image_url = p_url)
      or exists (select 1 from properties where cover_image = p_url or p_url = any(gallery))
      or exists (select 1 from units where p_url = any(images))
      or exists (select 1 from settings where key in ('logo_url','site_content') and value::text like '%' || p_url || '%')
$$;
revoke execute on function media_in_use(text) from public, anon;
grant execute on function media_in_use(text) to authenticated;

-- Deleting a library file is refused while it is in use. Returns the storage path so the client can remove the object.
create or replace function delete_media_asset(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare a media_assets;
begin
  if not is_owner_or_manager((select auth.uid())) then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into a from media_assets where id = p_id for update;
  if not found then raise exception 'File not found' using errcode = 'no_data_found'; end if;
  if media_in_use(a.url) then raise exception 'This file is still used on the website. Remove it there first.' using errcode = 'check_violation'; end if;
  delete from media_assets where id = p_id;
  return a.storage_path;
end $$;
grant execute on function delete_media_asset(uuid) to authenticated;

$mig16$;
    -- ---- 0017_finance_verification_owner.sql ----
    execute $mig17$
-- 0017_finance_verification_owner.sql
-- Finance controls and the owner's overview:
--   * payments carry a verification flag: manual M-Pesa / bank entries and every refund recorded by a manager stay
--     "unverified" until the owner verifies them, and unverified money is never counted as collected revenue;
--   * expenses have configurable categories and an approval step (manager entries wait for the owner);
--   * dashboard_overview and monthly_pnl now count only verified payments and approved expenses;
--   * owner_overview: one read-only function behind the owner's dashboard (owner only).

-- ---- payments: verification ------------------------------------------------------------------------------------
alter table payments
  add column verified boolean not null default true,
  add column verified_by uuid references profiles on delete set null,
  add column verified_at timestamptz;

create or replace function payment_verification_default() returns trigger language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  -- Gateway-confirmed payments (STK) and anything recorded by the owner or the service role are verified at once.
  if v_uid is null or has_permission(v_uid, 'payments.verify') or (new.method = 'mpesa_stk') then
    new.verified := true;
  elsif new.kind = 'refund' or new.method in ('mpesa_manual','bank') then
    new.verified := false;
  else
    new.verified := true;
  end if;
  if new.verified then new.verified_at := coalesce(new.verified_at, now()); new.verified_by := coalesce(new.verified_by, v_uid); end if;
  return new;
end $$;
create trigger trg_payment_verification before insert on payments for each row execute function payment_verification_default();

-- Only the owner (or the system) can change the verification fields.
create or replace function guard_payment_verification() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.verified is distinct from old.verified or new.verified_by is distinct from old.verified_by or new.verified_at is distinct from old.verified_at)
     and auth.uid() is not null and not has_permission(auth.uid(), 'payments.verify') then
    raise exception 'You do not have permission to verify payments' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_payment_verification_guard before update on payments for each row execute function guard_payment_verification();

create or replace function verify_payment(p_payment uuid, p_ok boolean default true) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid());
begin
  perform require_permission('payments.verify');
  update payments set verified = p_ok, verified_by = v_uid, verified_at = now() where id = p_payment;
  if not found then raise exception 'Payment not found' using errcode = 'no_data_found'; end if;
end $$;
grant execute on function verify_payment(uuid, boolean) to authenticated;

-- ---- expenses: categories + approval ---------------------------------------------------------------------------
create table expense_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name = lower(name) and char_length(name) between 2 and 30),
  active boolean not null default true,
  sort int not null default 0
);
create unique index expense_categories_name_uniq on expense_categories (name);
insert into expense_categories(name, sort) values ('utilities',1),('rent',2),('salaries',3),('cleaning',4),('maintenance',5),('supplies',6),('marketing',7),('internet',8),('transport',9),('repairs',10),('staff',11),('other',99);
alter table expense_categories enable row level security;
revoke all on expense_categories from anon;
create policy expense_categories_read on expense_categories for select to authenticated using (is_owner_or_manager((select auth.uid())));
create policy expense_categories_owner on expense_categories for all to authenticated
  using (has_role((select auth.uid()), 'owner')) with check (has_role((select auth.uid()), 'owner'));

alter table expenses
  add column status text not null default 'approved' check (status in ('approved','pending','rejected')),
  add column reviewed_by uuid references profiles on delete set null,
  add column reviewed_at timestamptz,
  add column review_note text check (review_note is null or char_length(review_note) <= 300);

create or replace function expense_status_default() returns trigger language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    if v_uid is not null and not has_permission(v_uid, 'expenses.approve') then new.status := 'pending'; new.reviewed_by := null; new.reviewed_at := null; end if;
  elsif new.status is distinct from old.status or new.reviewed_by is distinct from old.reviewed_by then
    if v_uid is not null and not has_permission(v_uid, 'expenses.approve') then raise exception 'You do not have permission to approve expenses' using errcode = '42501'; end if;
  elsif v_uid is not null and not has_permission(v_uid, 'expenses.approve') and old.status = 'approved'
        and (new.amount is distinct from old.amount or new.category is distinct from old.category or new.expense_date is distinct from old.expense_date) then
    new.status := 'pending';                      -- changing an approved expense sends it back for approval
  end if;
  return new;
end $$;
create trigger trg_expense_status before insert or update on expenses for each row execute function expense_status_default();

create or replace function review_expense(p_expense uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid());
begin
  perform require_permission('expenses.approve');
  if not p_approve and char_length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Say why the expense was rejected.' using errcode = 'check_violation'; end if;
  update expenses set status = case when p_approve then 'approved' else 'rejected' end, reviewed_by = v_uid, reviewed_at = now(), review_note = nullif(trim(coalesce(p_note, '')), '') where id = p_expense;
  if not found then raise exception 'Expense not found' using errcode = 'no_data_found'; end if;
end $$;
grant execute on function review_expense(uuid, boolean, text) to authenticated;

-- ---- reports now count verified money and approved expenses only ------------------------------------------------
create or replace function monthly_pnl(p_month date)
returns table(property_id uuid, property_name text, income int, refunds int, expenses int, net int)
language sql stable as $$
  with m as (select date_trunc('month', p_month)::date as s, (date_trunc('month', p_month) + interval '1 month')::date as e),
  inc as (
    select b.property_id,
           coalesce(sum(case when pay.kind <> 'refund' then pay.amount end), 0)::int as income,
           coalesce(sum(case when pay.kind = 'refund' then pay.amount end), 0)::int as refunds
    from payments pay join bookings b on b.id = pay.booking_id, m
    where pay.status = 'succeeded' and pay.verified
      and (pay.confirmed_at at time zone 'Africa/Nairobi')::date >= m.s
      and (pay.confirmed_at at time zone 'Africa/Nairobi')::date <  m.e
    group by b.property_id),
  exp as (
    select e.property_id, sum(e.amount)::int as expenses
    from expenses e, m
    where not e.voided and e.status = 'approved' and e.expense_date >= m.s and e.expense_date < m.e
    group by e.property_id)
  select p.id, p.name,
         coalesce(inc.income, 0), coalesce(inc.refunds, 0), coalesce(exp.expenses, 0),
         (coalesce(inc.income, 0) - coalesce(inc.refunds, 0) - coalesce(exp.expenses, 0))::int
  from properties p
  left join inc on inc.property_id = p.id
  left join exp on exp.property_id = p.id
  where can_access_property(auth.uid(), p.id)
  order by p.sort, p.name
$$;

create or replace function monthly_expenses_by_category(p_month date, p_property uuid default null)
returns table(category text, amount int)
language sql stable as $$
  select e.category, sum(e.amount)::int
  from expenses e
  where not e.voided and e.status = 'approved'
    and e.expense_date >= date_trunc('month', p_month)::date
    and e.expense_date <  (date_trunc('month', p_month) + interval '1 month')::date
    and (p_property is null or e.property_id = p_property)
  group by e.category order by 2 desc
$$;

create or replace function dashboard_overview(p_from date, p_to date, p_property uuid default null)
returns jsonb
language plpgsql stable as $$
declare
  v_days int; v_pf date; v_pt date;
  cur jsonb; v_by_source jsonb; v_by_method jsonb; v_daily jsonb; v_units int;
begin
  if not is_owner_or_manager((select auth.uid())) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Choose a valid date range' using errcode = 'check_violation';
  end if;
  if p_to - p_from > 731 then
    raise exception 'Choose a range of two years or less' using errcode = 'check_violation';
  end if;
  v_days := p_to - p_from + 1;
  v_pt := p_from - 1;
  v_pf := p_from - v_days;

  select count(*) into v_units from units u
   where u.active and (p_property is null or u.property_id = p_property);

  -- KPIs for a window [a, b] (inclusive days)
  with w(label, a, b) as (values ('cur', p_from, p_to), ('prev', v_pf, v_pt)),
  rev as (
    select w.label,
      coalesce((select sum(case when pay.kind = 'refund' then -pay.amount else pay.amount end)
                from payments pay join bookings b on b.id = pay.booking_id
                where pay.status = 'succeeded' and pay.verified
                  and (pay.confirmed_at at time zone 'Africa/Nairobi')::date between w.a and w.b
                  and (p_property is null or b.property_id = p_property)), 0)::bigint as revenue
    from w),
  stay as (
    select w.label,
      coalesce(sum(case when b.id is not null then greatest(0, least(b.check_out, w.b + 1) - greatest(b.check_in, w.a)) end), 0)::bigint as nights,
      coalesce(sum(case when b.nights > 0
        then round(b.nightly_total::numeric * greatest(0, least(b.check_out, w.b + 1) - greatest(b.check_in, w.a)) / b.nights) end), 0)::bigint as room_revenue
    from w left join bookings b
      on b.status in ('confirmed','checked_in','checked_out')
     and b.check_in <= w.b and b.check_out > w.a
     and (p_property is null or b.property_id = p_property)
    group by w.label),
  made as (
    select w.label,
      count(b.id) filter (where b.status <> 'blocked')::int as bookings,
      count(b.id) filter (where b.status = 'cancelled')::int as cancellations,
      count(b.id) filter (where b.status = 'no_show')::int as no_shows
    from w left join bookings b
      on (b.created_at at time zone 'Africa/Nairobi')::date between w.a and w.b
     and (p_property is null or b.property_id = p_property)
    group by w.label),
  arr as (
    select w.label, count(b.id)::int as arrivals
    from w left join bookings b
      on b.check_in between w.a and w.b and b.status in ('confirmed','checked_in','checked_out')
     and (p_property is null or b.property_id = p_property)
    group by w.label)
  select jsonb_object_agg(rev.label, jsonb_build_object(
      'revenue', rev.revenue,
      'occupied_nights', stay.nights,
      'room_revenue', stay.room_revenue,
      'bookings', made.bookings, 'cancellations', made.cancellations, 'no_shows', made.no_shows,
      'arrivals', arr.arrivals,
      'available_nights', v_units::bigint * v_days,
      'occupancy_pct', case when v_units > 0 then round(100.0 * stay.nights / (v_units::numeric * v_days), 1) else 0 end,
      'adr', case when stay.nights > 0 then round(stay.room_revenue::numeric / stay.nights) else 0 end,
      'revpar', case when v_units > 0 then round(stay.room_revenue::numeric / (v_units::numeric * v_days)) else 0 end))
  into cur
  from rev join stay using (label) join made using (label) join arr using (label);

  -- Revenue by payment method and bookings by source (current period)
  select coalesce(jsonb_agg(jsonb_build_object('key', k, 'amount', amt) order by amt desc), '[]'::jsonb) into v_by_method
  from (
    select pay.method::text as k,
           sum(case when pay.kind = 'refund' then -pay.amount else pay.amount end)::bigint as amt
    from payments pay join bookings b on b.id = pay.booking_id
    where pay.status = 'succeeded' and pay.verified
      and (pay.confirmed_at at time zone 'Africa/Nairobi')::date between p_from and p_to
      and (p_property is null or b.property_id = p_property)
    group by pay.method) t;

  select coalesce(jsonb_agg(jsonb_build_object('key', k, 'count', c, 'amount', amt) order by c desc), '[]'::jsonb) into v_by_source
  from (
    select b.source::text as k, count(*)::int as c, sum(b.total_amount)::bigint as amt
    from bookings b
    where b.status in ('confirmed','checked_in','checked_out')
      and (b.created_at at time zone 'Africa/Nairobi')::date between p_from and p_to
      and (p_property is null or b.property_id = p_property)
    group by b.source) t;

  -- Daily series for charts: revenue received and nights occupied
  select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'revenue', coalesce(r.amt, 0), 'occupied', coalesce(o.n, 0)) order by d), '[]'::jsonb)
  into v_daily
  from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
  left join lateral (
    select sum(case when pay.kind = 'refund' then -pay.amount else pay.amount end)::bigint amt
    from payments pay join bookings b on b.id = pay.booking_id
    where pay.status = 'succeeded' and pay.verified and (pay.confirmed_at at time zone 'Africa/Nairobi')::date = d::date
      and (p_property is null or b.property_id = p_property)) r on true
  left join lateral (
    select count(*)::int n from bookings b
    where b.status in ('confirmed','checked_in','checked_out') and b.check_in <= d::date and b.check_out > d::date
      and (p_property is null or b.property_id = p_property)) o on true;

  return jsonb_build_object('from', p_from, 'to', p_to, 'days', v_days, 'units', v_units,
    'current', cur->'cur', 'previous', cur->'prev', 'by_method', v_by_method, 'by_source', v_by_source, 'daily', v_daily);
end $$;
grant execute on function dashboard_overview(date, date, uuid) to authenticated;

-- ---- owner's overview --------------------------------------------------------------------------------------------
create or replace function owner_overview(p_from date, p_to date) returns jsonb
language plpgsql stable security invoker as $$
declare
  v_uid uuid := (select auth.uid()); v_today date := nairobi_today();
  v_gross bigint; v_collected bigint; v_unverified bigint; v_refunds bigint; v_outstanding bigint; v_exp bigint; v_exp_pending bigint;
  v_monthly jsonb; v_by_prop jsonb; v_units int; v_occupied int; v_maint int; v_book jsonb; v_ops jsonb; v_staff jsonb; v_perf jsonb;
begin
  perform require_permission('owner.overview');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 731 then raise exception 'Choose a valid date range of two years or less' using errcode = 'check_violation'; end if;

  select coalesce(sum(total_amount), 0) into v_gross from bookings
    where status in ('confirmed','checked_in','checked_out') and check_in between p_from and p_to;
  select coalesce(sum(case when kind = 'refund' then -amount else amount end) filter (where verified), 0),
         coalesce(sum(case when kind = 'refund' then -amount else amount end) filter (where not verified), 0),
         coalesce(sum(amount) filter (where kind = 'refund' and verified), 0)
    into v_collected, v_unverified, v_refunds
    from payments where status = 'succeeded' and (confirmed_at at time zone 'Africa/Nairobi')::date between p_from and p_to;
  select coalesce(sum(greatest(total_amount - amount_paid, 0)), 0) into v_outstanding from bookings where status in ('confirmed','checked_in','checked_out');
  select coalesce(sum(amount) filter (where status = 'approved'), 0), coalesce(sum(amount) filter (where status = 'pending'), 0)
    into v_exp, v_exp_pending from expenses where not voided and expense_date between p_from and p_to;

  select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'),
      'revenue', (select coalesce(sum(case when kind = 'refund' then -amount else amount end), 0) from payments
                   where status = 'succeeded' and verified and date_trunc('month', confirmed_at at time zone 'Africa/Nairobi') = m),
      'expenses', (select coalesce(sum(amount), 0) from expenses where not voided and status = 'approved' and date_trunc('month', expense_date) = m)) order by m), '[]'::jsonb)
    into v_monthly from generate_series(date_trunc('month', p_to) - interval '11 months', date_trunc('month', p_to), interval '1 month') m;

  select coalesce(jsonb_agg(x order by (x->>'collected')::bigint desc), '[]'::jsonb) into v_by_prop from (
    select jsonb_build_object('property', p.name,
      'collected', coalesce((select sum(case when pay.kind = 'refund' then -pay.amount else pay.amount end) from payments pay join bookings b on b.id = pay.booking_id
                              where b.property_id = p.id and pay.status = 'succeeded' and pay.verified and (pay.confirmed_at at time zone 'Africa/Nairobi')::date between p_from and p_to), 0),
      'bookings', (select count(*) from bookings b where b.property_id = p.id and b.status in ('confirmed','checked_in','checked_out') and b.check_in between p_from and p_to),
      'occupied_nights', (select coalesce(sum(greatest(0, least(b.check_out, p_to + 1) - greatest(b.check_in, p_from))), 0) from bookings b
                           where b.property_id = p.id and b.status in ('confirmed','checked_in','checked_out') and b.check_in <= p_to and b.check_out > p_from),
      'units', (select count(*) from units u where u.property_id = p.id and u.active)) as x
    from properties p where p.archived_at is null) t;

  select count(*) into v_units from units where active;
  select count(distinct unit_id) into v_occupied from bookings where status = 'checked_in';
  select count(*) into v_maint from units where active and maintenance_status <> 'ok';
  v_perf := (dashboard_overview(p_from, p_to, null))->'current';

  select jsonb_build_object(
    'total', (select count(*) from bookings where status <> 'blocked' and (created_at at time zone 'Africa/Nairobi')::date between p_from and p_to),
    'confirmed', (select count(*) from bookings where status in ('confirmed','checked_in','checked_out') and (created_at at time zone 'Africa/Nairobi')::date between p_from and p_to),
    'pending_requests', (select count(*) from booking_requests where status = 'new'),
    'cancelled', (select count(*) from bookings where status = 'cancelled' and (cancelled_at at time zone 'Africa/Nairobi')::date between p_from and p_to),
    'upcoming_checkins', (select count(*) from bookings where status in ('confirmed','pending') and check_in between v_today and v_today + 7),
    'upcoming_checkouts', (select count(*) from bookings where status = 'checked_in' and check_out between v_today and v_today + 7)) into v_book;

  select jsonb_build_object(
    'rooms_to_clean', (select count(*) from housekeeping_tasks where status in ('dirty','in_progress')),
    'open_maintenance', (select count(*) from maintenance_requests where status in ('open','assigned','in_progress')),
    'open_tickets', (select count(*) from support_tickets where status in ('open','in_progress','waiting')),
    'unverified_payments', (select count(*) from payments where status = 'succeeded' and not verified),
    'pending_expenses', (select count(*) from expenses where status = 'pending' and not voided)) into v_ops;

  select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(pr.full_name, 'System'), 'actions', c) order by c desc), '[]'::jsonb) into v_staff from (
    select user_id, count(*) c from audit_log where (created_at at time zone 'Africa/Nairobi')::date between p_from and p_to group by user_id order by 2 desc limit 8) a
    left join profiles pr on pr.id = a.user_id;

  return jsonb_build_object('from', p_from, 'to', p_to,
    'finance', jsonb_build_object('gross_booking_value', v_gross, 'collected', v_collected, 'unverified', v_unverified, 'refunds', v_refunds,
        'outstanding', v_outstanding, 'expenses', v_exp, 'expenses_pending', v_exp_pending, 'net_operating_income', v_collected - v_exp),
    'monthly', v_monthly, 'by_property', v_by_prop,
    'units', jsonb_build_object('total', v_units, 'occupied', v_occupied, 'maintenance', v_maint, 'available', greatest(v_units - v_occupied - v_maint, 0)),
    'performance', v_perf, 'bookings', v_book, 'operations', v_ops, 'staff_activity', v_staff);
end $$;
grant execute on function owner_overview(date, date) to authenticated;

-- ---- financial records are never hard-deleted ---------------------------------------------------------------------
-- Expenses are voided, payments are corrected with a refund or adjustment. (Cascades from deleting a booking are unaffected.)
drop policy if exists expenses_owner_delete on expenses;
drop policy if exists payments_owner_all on payments;
create policy payments_owner_select on payments for select to authenticated using (has_role((select auth.uid()), 'owner'));
create policy payments_owner_insert on payments for insert to authenticated with check (has_role((select auth.uid()), 'owner'));
create policy payments_owner_update on payments for update to authenticated using (has_role((select auth.uid()), 'owner')) with check (has_role((select auth.uid()), 'owner'));

$mig17$;
    -- ---- 0018_contacts_comms_settings.sql ----
    execute $mig18$
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

$mig18$;
    -- ---- 0019_bar_smart_access_notifications.sql ----
    execute $mig19$
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

$mig19$;
    -- ---- 0020_roles_permissions_login_cms.sql ----
    execute $mig20$
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

$mig20$;
    -- ---- 0021_global_search.sql ----
    execute $mig21$
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

$mig21$;
    -- ---- 0022_fix_notify_more.sql ----
    execute $mig22$
-- 0022_fix_notify_more.sql
-- Fixes trg_notify_more (0019). It was one if/elsif chain whose last branch read NEW.verified; PL/pgSQL resolves that field
-- when the branch is reached, so any message_log row that was not already 'failed' (e.g. the 'queued' row written before every
-- WhatsApp send) raised "record new has no field verified" and the insert was rejected. Each table now gets its own block.

create or replace function trg_notify_more() returns trigger language plpgsql security definer set search_path = public as $$
declare v_unit text;
begin
  if tg_table_name = 'maintenance_requests' then
    if tg_op = 'INSERT' then
      perform add_notification('maintenance', 'Maintenance: ' || new.title, new.priority || ' priority', '/admin/maintenance', new.property_id, new.id);
    end if;
  elsif tg_table_name = 'housekeeping_tasks' then
    if tg_op = 'INSERT' then
      select name into v_unit from units where id = new.unit_id;
      perform add_notification('housekeeping', 'Room to clean: ' || coalesce(v_unit, ''), case when new.priority then 'Same-day turnover' else null end, '/admin/housekeeping', new.property_id, new.id);
    end if;
  elsif tg_table_name = 'support_tickets' then
    if tg_op = 'INSERT' then
      perform add_notification('ticket', 'Ticket #' || new.ticket_no || ': ' || new.subject, new.priority || ' priority', '/admin/support', new.property_id, new.id);
    end if;
  elsif tg_table_name = 'message_log' then
    if new.status = 'failed' and (tg_op = 'INSERT' or old.status is distinct from 'failed') then
      perform add_notification('message_failed', 'Message not delivered', left(coalesce(new.error, 'Delivery failed'), 140), '/admin/messages', new.property_id, new.id);
    end if;
  elsif tg_table_name = 'payments' then
    if tg_op = 'INSERT' and new.status = 'succeeded' and not new.verified then
      perform add_notification('payment_verify', 'Payment to verify: KES ' || to_char(new.amount, 'FM999,999,999'), new.method::text, '/admin/finance', (select property_id from bookings where id = new.booking_id), new.id);
    end if;
  end if;
  return null;
end $$;

$mig22$;
    -- ---- 0023_reschedule_booking.sql ----
    execute $mig23$
-- 0023_reschedule_booking.sql
-- Changing a booking's dates or room after it was made. The rules live in the database: the new dates must be free
-- (the exclusion constraint is the final guard, a friendly pre-check names the clashing booking), the room must be
-- able to take the party, and the price is recalculated from the same quote the website uses. Every change is kept
-- in booking_changes (who, why, old and new values) and can never be edited or deleted.

alter table guests add column country text check (country is null or char_length(country) <= 60);

create table booking_changes (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings on delete cascade,
  changed_by uuid references profiles on delete set null,
  reason text not null check (char_length(trim(reason)) between 3 and 300),
  old_check_in date not null, old_check_out date not null, old_unit_id uuid not null, old_total int not null,
  new_check_in date not null, new_check_out date not null, new_unit_id uuid not null, new_total int not null,
  repriced boolean not null,
  created_at timestamptz not null default now()
);
create index on booking_changes (booking_id, created_at);
alter table booking_changes enable row level security;
revoke all on booking_changes from anon;
revoke insert, update, delete on booking_changes from authenticated;
create policy booking_changes_read on booking_changes for select to authenticated
  using (exists (select 1 from bookings b where b.id = booking_id and can_manage_property((select auth.uid()), b.property_id)));

-- p_dry_run = true: validate and price the change without saving it (the admin screen shows this before confirming).
create or replace function reschedule_booking(
  p_booking uuid, p_in date, p_out date, p_unit uuid default null, p_reprice boolean default true,
  p_reason text default null, p_dry_run boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := (select auth.uid()); b bookings; u units; q record; v_unit uuid; v_clash text;
  v_charges int; v_new_total int; v_new_deposit int; v_today date := nairobi_today();
begin
  perform require_permission('bookings.manage');
  select * into b from bookings where id = p_booking for update;
  if not found or not can_manage_property(v_uid, b.property_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if b.status not in ('pending','confirmed','checked_in') then raise exception 'Only a pending, confirmed or checked-in booking can be changed (this one is %).', b.status using errcode = 'check_violation'; end if;
  if p_in is null or p_out is null or p_out <= p_in then raise exception 'Check-out must be after check-in.' using errcode = 'check_violation'; end if;
  if b.status = 'checked_in' and (p_in <> b.check_in or coalesce(p_unit, b.unit_id) <> b.unit_id) then
    raise exception 'A guest who is checked in can only have the check-out date changed.' using errcode = 'check_violation';
  end if;
  if b.status <> 'checked_in' and p_in < v_today then raise exception 'The new check-in date cannot be in the past.' using errcode = 'check_violation'; end if;
  if not p_dry_run and char_length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Say why the booking is being changed.' using errcode = 'check_violation'; end if;

  v_unit := coalesce(p_unit, b.unit_id);
  select * into u from units where id = v_unit and property_id = b.property_id and active;
  if not found then raise exception 'That room is not available at this property.' using errcode = 'check_violation'; end if;
  if u.maintenance_status <> 'ok' then raise exception 'That room is under maintenance.' using errcode = 'check_violation'; end if;
  if b.num_guests > u.max_guests then raise exception 'That room sleeps at most % guests.', u.max_guests using errcode = 'check_violation'; end if;
  if p_in = b.check_in and p_out = b.check_out and v_unit = b.unit_id then raise exception 'Nothing is changing.' using errcode = 'check_violation'; end if;

  perform expire_stale_holds();
  select string_agg(x.reference || ' (' || to_char(x.check_in, 'DD Mon') || ' to ' || to_char(x.check_out, 'DD Mon') || ')', ', ') into v_clash
  from bookings x
  where x.unit_id = v_unit and x.id <> b.id and x.status in ('pending','confirmed','checked_in','blocked')
    and not (x.status = 'pending' and x.hold_expires_at < now())
    and daterange(x.check_in, x.check_out, '[)') && daterange(p_in, p_out, '[)');
  if v_clash is not null then raise exception 'Those dates are not free in that room: % is in the way.', v_clash using errcode = 'check_violation'; end if;

  select * into q from quote_stay(v_unit, p_in, p_out);
  if q.nights < q.min_nights then raise exception 'Minimum stay for that room is % night(s).', q.min_nights using errcode = 'check_violation'; end if;
  if u.max_nights is not null and q.nights > u.max_nights then raise exception 'Maximum stay for that room is % night(s).', u.max_nights using errcode = 'check_violation'; end if;

  select coalesce(sum(amount), 0) into v_charges from booking_charges where booking_id = b.id and not voided;
  v_new_total := case when p_reprice then greatest(0, q.total - b.discount) + v_charges else b.total_amount end;
  v_new_deposit := case when p_reprice and b.status = 'pending' then calc_deposit(v_new_total, setting_num('deposit_percent', 50)) else least(b.deposit_required, v_new_total) end;

  if p_dry_run then
    return jsonb_build_object('nights', q.nights, 'old_total', b.total_amount, 'new_total', v_new_total, 'difference', v_new_total - b.total_amount,
      'amount_paid', b.amount_paid, 'balance_after', greatest(v_new_total - b.amount_paid, 0), 'refund_due', greatest(b.amount_paid - v_new_total, 0));
  end if;

  insert into booking_changes(booking_id, changed_by, reason, old_check_in, old_check_out, old_unit_id, old_total, new_check_in, new_check_out, new_unit_id, new_total, repriced)
    values (b.id, v_uid, trim(p_reason), b.check_in, b.check_out, b.unit_id, b.total_amount, p_in, p_out, v_unit, v_new_total, p_reprice);
  begin
    update bookings set check_in = p_in, check_out = p_out, unit_id = v_unit,
      nightly_total = case when p_reprice then q.nightly_total else nightly_total end,
      cleaning_fee = case when p_reprice then q.cleaning_fee else cleaning_fee end,
      total_amount = v_new_total, deposit_required = v_new_deposit
    where id = b.id;
  exception when exclusion_violation then
    raise exception 'Those dates were just taken in that room. Please choose other dates.' using errcode = 'check_violation';
  end;
  return jsonb_build_object('nights', q.nights, 'old_total', b.total_amount, 'new_total', v_new_total, 'difference', v_new_total - b.total_amount,
    'amount_paid', b.amount_paid, 'balance_after', greatest(v_new_total - b.amount_paid, 0), 'refund_due', greatest(b.amount_paid - v_new_total, 0));
end $$;
grant execute on function reschedule_booking(uuid, date, date, uuid, boolean, text, boolean) to authenticated;

$mig23$;
    -- ---- 0024_stay_discounts.sql ----
    execute $mig24$
-- 0024_stay_discounts.sql
-- Automatic length-of-stay discounts per property (or per room): "7+ nights: 10% off". Applied inside quote_stay, so the
-- website, availability search, bookings, requests and rescheduling all agree. The best matching rule wins; rules never stack.
-- (Discount codes from migration 0012 still apply on top, to the already-discounted room charge.)

create table stay_discounts (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties on delete cascade,
  unit_id uuid references units on delete cascade,
  min_nights int not null check (min_nights between 2 and 365),
  percent int not null check (percent between 1 and 90),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index stay_discounts_uniq on stay_discounts (property_id, coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid), min_nights);
alter table stay_discounts enable row level security;
revoke insert, update, delete on stay_discounts from anon;
create policy stay_discounts_public on stay_discounts for select to anon, authenticated using (active);
create policy stay_discounts_staff_read on stay_discounts for select to authenticated using (can_manage_property((select auth.uid()), property_id));
create policy stay_discounts_staff_write on stay_discounts for all to authenticated
  using (can_manage_property((select auth.uid()), property_id)) with check (can_manage_property((select auth.uid()), property_id)
    and (unit_id is null or exists (select 1 from units u where u.id = unit_id and u.property_id = stay_discounts.property_id)));
create policy perm_stay_discounts_write on stay_discounts as restrictive for all to authenticated
  using (has_permission((select auth.uid()), 'listings.manage') or active) with check (has_permission((select auth.uid()), 'listings.manage'));
create trigger trg_audit_stay_discount after insert or update or delete on stay_discounts for each row execute function audit_generic('stay_discount');

create or replace function long_stay_percent(p_unit uuid, p_nights int) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(max(d.percent), 0)::int from stay_discounts d join units u on u.id = p_unit
  where d.active and d.property_id = u.property_id and (d.unit_id is null or d.unit_id = p_unit) and d.min_nights <= p_nights
$$;
grant execute on function long_stay_percent(uuid, int) to anon, authenticated, service_role;

create or replace function quote_stay(p_unit uuid, p_in date, p_out date)
returns table(nights int, nightly_total int, cleaning_fee int, total int, min_nights int)
language sql stable security definer set search_path = public as $$
  with u as (select * from units where id = p_unit and active),
  d as (select generate_series(p_in, p_out - 1, interval '1 day')::date as night),
  priced as (
    select d.night,
      coalesce(
        (select ro.nightly_rate from rate_overrides ro
          where ro.unit_id = p_unit and d.night between ro.start_date and ro.end_date
          order by ro.created_at desc limit 1),
        case when extract(isodow from d.night) in (5,6) and u.weekend_rate is not null
             then u.weekend_rate else u.base_rate end
      ) as rate
    from d cross join u),
  s as (select sum(rate)::int as gross, (p_out - p_in) as n from priced)
  select s.n, (s.gross - (s.gross * long_stay_percent(p_unit, s.n)) / 100)::int, u.cleaning_fee,
         (s.gross - (s.gross * long_stay_percent(p_unit, s.n)) / 100 + u.cleaning_fee)::int, u.min_nights
  from s cross join u;
$$;
grant execute on function quote_stay(uuid,date,date) to anon, authenticated, service_role;

$mig24$;
    -- ---- 0025_housekeeping_photos.sql ----
    execute $mig25$
-- 0025_housekeeping_photos.sql
-- Photos on cleaning tasks (damage, a finished room), added by the person doing the task or a manager. Append-only.
-- Floor staff may upload into the "housekeeping/" folder of the public image bucket (nowhere else).

create table housekeeping_task_photos (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references housekeeping_tasks on delete cascade,
  url text not null check (url ~ '^https://'),
  caption text check (caption is null or char_length(caption) <= 200),
  created_by uuid not null references profiles on delete restrict,
  created_at timestamptz not null default now()
);
create index on housekeeping_task_photos (task_id, created_at);
alter table housekeeping_task_photos enable row level security;
revoke all on housekeeping_task_photos from anon;
revoke update, delete on housekeeping_task_photos from authenticated;

-- Seen by anyone who can see the task; added by its assignee (or a manager of the property).
create policy hk_photos_read on housekeeping_task_photos for select to authenticated
  using (exists (select 1 from housekeeping_tasks t where t.id = task_id and can_access_property((select auth.uid()), t.property_id)
                 and (can_manage_property((select auth.uid()), t.property_id) or t.assigned_to = (select auth.uid()) or t.assigned_to is null)));
create policy hk_photos_insert on housekeeping_task_photos for insert to authenticated
  with check (created_by = (select auth.uid()) and has_permission((select auth.uid()), 'housekeeping.update')
              and exists (select 1 from housekeeping_tasks t where t.id = task_id and can_access_property((select auth.uid()), t.property_id)
                          and (can_manage_property((select auth.uid()), t.property_id) or t.assigned_to = (select auth.uid()))));

do $$ begin
  if to_regclass('storage.buckets') is not null then
    drop policy if exists "housekeeping photos staff write" on storage.objects;
    create policy "housekeeping photos staff write" on storage.objects for insert to authenticated
      with check (bucket_id = 'property-images' and name like 'housekeeping/%' and public.is_staff(auth.uid()));
  end if;
end $$;

$mig25$;
    -- ---- 0026_site_pages.sql ----
    execute $mig26$
-- 0026_site_pages.sql
-- Editable policy pages (Terms, Privacy, House rules...) shown on the public site at /p/<slug>. A page is public only while
-- it is published. The two starter pages are created as unpublished drafts with a clear "review this" note, so the site never
-- shows legal text that nobody has read.

create table site_pages (
  slug text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  title text not null check (char_length(trim(title)) between 2 and 80),
  body text not null default '' check (char_length(body) <= 30000),
  published boolean not null default false,
  show_in_footer boolean not null default true,
  sort int not null default 0,
  updated_by uuid references profiles on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table site_pages enable row level security;
revoke insert, update, delete on site_pages from anon;
create policy site_pages_public on site_pages for select to anon, authenticated using (published);
create policy site_pages_staff_read on site_pages for select to authenticated using (is_owner_or_manager((select auth.uid())));
create policy site_pages_staff_write on site_pages for all to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy perm_site_pages_write on site_pages as restrictive for all to authenticated
  using (has_permission((select auth.uid()), 'cms.manage') or published) with check (has_permission((select auth.uid()), 'cms.manage'));
create trigger trg_audit_site_page after insert or update or delete on site_pages for each row execute function audit_generic('site_page');
create or replace function stamp_site_page() returns trigger language plpgsql as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
create trigger trg_site_page_stamp before update on site_pages for each row execute function stamp_site_page();

insert into site_pages(slug, title, body, published, show_in_footer, sort) values
('terms', 'Terms and conditions',
 E'# Review before publishing\nThis is a starting outline, not legal advice. Replace it with your own terms, have a lawyer read it, then tick Published.\n\n# Bookings\nA booking is confirmed once the deposit is received. The balance is due before check-in.\n\n# Cancellations\nSee the cancellation policy shown when you book.\n\n# House rules\nPlease respect the property, your neighbours and the quiet hours.', false, true, 10),
('privacy', 'Privacy notice',
 E'# Review before publishing\nThis is a starting outline, not legal advice. Replace it with a notice that matches how you really handle personal data (Kenya Data Protection Act, 2019), then tick Published.\n\n# What we collect\nName, phone number, email and booking details, so we can manage your stay.\n\n# How we use it\nTo confirm bookings, take payments and send confirmations and reminders.\n\n# Your rights\nYou can ask to see, correct or delete your personal data by contacting us.', false, true, 20);

$mig26$;
    -- ---- 0027_listing_video.sql ----
    execute $mig27$
-- 0027_listing_video.sql
-- An optional walkthrough video per listing (chosen from the media library; the file lives in the public image bucket).

alter table properties add column video_url text check (video_url is null or video_url ~ '^https://');

$mig27$;
    -- ---- 0028_permission_overrides.sql ----
    execute $mig28$
-- 0028_permission_overrides.sql
-- Per-person exceptions on top of their team role: allow one extra permission or block one, without inventing a whole new role.
-- An override always wins over the role, except that an owner can never be blocked, and nobody can grant a permission they do not
-- hold themselves.

create table user_permission_overrides (
  user_id uuid not null references profiles on delete cascade,
  permission_key text not null references permissions_catalog on delete cascade,
  granted boolean not null,
  set_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, permission_key)
);
alter table user_permission_overrides enable row level security;
revoke all on user_permission_overrides from anon;
revoke insert, update, delete on user_permission_overrides from authenticated;      -- changes go through set_user_permission only
create policy overrides_read on user_permission_overrides for select to authenticated
  using (user_id = (select auth.uid()) or has_permission((select auth.uid()), 'users.manage'));

create or replace function has_permission(_uid uuid, _perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when _uid is null then false
    when not exists (select 1 from profiles p where p.id = _uid and p.active) then false
    when has_role(_uid, 'owner') then true
    when exists (select 1 from user_permission_overrides o where o.user_id = _uid and o.permission_key = _perm) then
      (select o.granted from user_permission_overrides o where o.user_id = _uid and o.permission_key = _perm)
    else exists (
      select 1 from team_role_permissions rp
      where rp.permission_key = _perm
        and rp.role_id = coalesce(
          (select p.team_role_id from profiles p where p.id = _uid),
          (select tr.id from team_roles tr where tr.default_for = case when has_role(_uid, 'manager') then 'manager'::app_role when has_role(_uid, 'cleaner') then 'cleaner'::app_role end)))
  end
$$;

-- p_state: 'grant' | 'deny' | 'inherit' (remove the exception)
create or replace function set_user_permission(p_user uuid, p_perm text, p_state text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid());
begin
  perform require_permission('users.manage');
  if p_user = v_uid then raise exception 'You cannot change your own permissions.' using errcode = 'check_violation'; end if;
  if has_role(p_user, 'owner') then raise exception 'Owners always have every permission.' using errcode = 'check_violation'; end if;
  if not exists (select 1 from permissions_catalog where key = p_perm) then raise exception 'Unknown permission.' using errcode = 'check_violation'; end if;
  if p_state not in ('grant','deny','inherit') then raise exception 'Choose allow, block or role default.' using errcode = 'check_violation'; end if;
  if p_state = 'grant' and not has_permission(v_uid, p_perm) then raise exception 'You cannot grant a permission you do not have yourself.' using errcode = '42501'; end if;
  if p_state = 'inherit' then
    delete from user_permission_overrides where user_id = p_user and permission_key = p_perm;
  else
    insert into user_permission_overrides(user_id, permission_key, granted, set_by) values (p_user, p_perm, p_state = 'grant', v_uid)
      on conflict (user_id, permission_key) do update set granted = excluded.granted, set_by = excluded.set_by, created_at = now();
  end if;
  insert into audit_log(user_id, action, entity, entity_id, diff) values (v_uid, 'staff.permission_override', 'staff', p_user::text, jsonb_build_object('permission', p_perm, 'state', p_state));
end $$;
grant execute on function set_user_permission(uuid, text, text) to authenticated;

$mig28$;
    -- ---- 0029_customer_membership.sql ----
    execute $mig29$
-- 0029_customer_membership.sql
-- Customer accounts, membership tiers, member offers, rewards and loyalty, joined to the existing booking engine.
--
-- Design:
--  * Customers are ordinary Supabase Auth users. They have NO row in `profiles` / `user_roles`, so they can never act as staff.
--    Staff checks (has_role, has_permission, can_manage_property) all start from `profiles`, which customers never have.
--  * A customer profile only exists after the email is verified (ensure_customer_profile reads auth.users.email_confirmed_at).
--  * Customers never touch these tables directly for writes. Every change goes through a security-definer function that
--    works from auth.uid(), so a customer can only ever read or change their own records.
--  * Offers are validated in the database when the booking is created. The browser's idea of the discount is never trusted.
--  * A redeemed reward is tied to one booking. If that booking is cancelled, expires or is a no-show, the reward is released.
--  * Tiers are earned from the owner's configured criteria (completed stays, spend), or set by hand by staff.

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
insert into permissions_catalog(key, module, label, sort) values
  ('customers.view','Customers','View customer accounts, membership and activity',120),
  ('customers.manage','Customers','Suspend accounts, set tiers and adjust loyalty points',121),
  ('offers.manage','Customers','Create and manage member offers and the welcome offer',122);
do $perm$
declare v_id uuid;
begin
  for v_id in select id from team_roles where name = 'Super Administrator' loop
    insert into team_role_permissions(role_id, permission_key) values (v_id,'customers.view'),(v_id,'customers.manage'),(v_id,'offers.manage') on conflict do nothing;
  end loop;
  insert into team_role_permissions(role_id, permission_key) select id, k from team_roles, unnest(array['customers.view','customers.manage','offers.manage']) k where name = 'Property Manager' on conflict do nothing;
  insert into team_role_permissions(role_id, permission_key) select id, k from team_roles, unnest(array['customers.view','offers.manage']) k where name = 'Marketing Manager' on conflict do nothing;
  insert into team_role_permissions(role_id, permission_key) select id, 'customers.view' from team_roles where name in ('Receptionist','Booking Manager') on conflict do nothing;
end $perm$;

-- ---------------------------------------------------------------------------
-- Settings made public: whether guests may still book without an account
-- ---------------------------------------------------------------------------
insert into settings(key, value) values ('guest_checkout_enabled', 'true'), ('loyalty_kes_per_point', '100') on conflict (key) do nothing;
drop policy if exists settings_public_read on settings;
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes',
                 'mpesa_manual_instructions','mpesa_paybill_display','brand_color','site_content','booking_mode',
                 'business_email','business_address','currency','maintenance_mode','guest_checkout_enabled'));

-- ---------------------------------------------------------------------------
-- Membership tiers (owner-configurable)
-- ---------------------------------------------------------------------------
create table membership_tiers (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,20}$'),
  name text not null check (char_length(trim(name)) between 2 and 40),
  rank int not null unique check (rank >= 0),
  min_completed_stays int not null default 0 check (min_completed_stays >= 0),
  min_spend int not null default 0 check (min_spend >= 0),         -- KES paid across completed stays
  expiry_months int check (expiry_months is null or expiry_months between 1 and 120),   -- null = never expires
  benefits text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_tiers_updated before update on membership_tiers for each row execute function set_updated_at();
insert into membership_tiers(key, name, rank, min_completed_stays, min_spend, expiry_months, benefits) values
  ('standard','Standard Member',0,0,0,null,array['Welcome discount','Member-exclusive offers','Booking history']),
  ('silver','Silver Member',1,3,60000,24,array['Additional discounts','Priority access to promotions']),
  ('gold','Gold Member',2,6,150000,24,array['Enhanced discounts','Selected complimentary benefits']),
  ('vip','VIP Member',3,12,350000,24,array['Premium offers','Priority booking assistance','Special guest privileges']);

-- ---------------------------------------------------------------------------
-- Customer profiles
-- ---------------------------------------------------------------------------
create table customer_profiles (
  user_id uuid primary key references auth.users on delete cascade,
  full_name text not null check (char_length(trim(full_name)) between 2 and 80),
  email text not null check (email = lower(email)),
  phone text check (phone is null or phone ~ '^254[17][0-9]{8}$'),
  country text check (country is null or char_length(country) <= 60),
  birthday date check (birthday is null or birthday between date '1900-01-01' and current_date),
  guest_id uuid unique references guests on delete set null,        -- the booking-side guest record, linked on first booking
  status text not null default 'active' check (status in ('active','suspended')),
  suspended_reason text,
  tier_key text not null default 'standard' references membership_tiers,
  tier_override boolean not null default false,                      -- set by hand: criteria no longer change it
  tier_expires_at timestamptz,
  marketing_opt_in boolean not null default true,
  verified_at timestamptz not null default now(),
  welcome_emailed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index customer_profiles_email_uniq on customer_profiles (email);
create index on customer_profiles (tier_key);
create trigger trg_customer_profiles_updated before update on customer_profiles for each row execute function set_updated_at();

alter table bookings add column customer_id uuid references customer_profiles(user_id) on delete set null;
create index on bookings (customer_id) where customer_id is not null;

create table customer_activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references customer_profiles(user_id) on delete cascade,
  kind text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index on customer_activity (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Offers, rewards, redemptions, loyalty
-- ---------------------------------------------------------------------------
create table promotional_offers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 3 and 80),
  description text check (description is null or char_length(description) <= 300),
  terms text check (terms is null or char_length(terms) <= 1000),
  -- how it reaches a customer: welcome (issued on verification), birthday (issued on the day), member (offered to every eligible member)
  audience text not null check (audience in ('welcome','birthday','member')),
  kind text not null check (kind in ('percent','fixed')),
  value int not null check (value > 0),
  max_discount int check (max_discount is null or max_discount > 0),
  min_total int not null default 0 check (min_total >= 0),         -- minimum room total (KES)
  property_ids uuid[] not null default '{}',                        -- empty = every accommodation
  min_tier_key text references membership_tiers,
  first_booking_only boolean not null default false,
  returning_only boolean not null default false,
  valid_from date,
  valid_to date,
  valid_days int check (valid_days is null or valid_days between 1 and 730),   -- how long an issued reward lasts
  max_redemptions int check (max_redemptions is null or max_redemptions >= 1),
  per_customer_limit int not null default 1 check (per_customer_limit >= 1),
  stackable boolean not null default false,                         -- may be combined with a discount code
  active boolean not null default true,
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'percent' or value <= 100),
  check (valid_to is null or valid_from is null or valid_to >= valid_from),
  check (not (first_booking_only and returning_only))
);
create trigger trg_offers_updated before update on promotional_offers for each row execute function set_updated_at();

create table customer_rewards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references customer_profiles(user_id) on delete cascade,
  offer_id uuid not null references promotional_offers on delete restrict,
  code text not null unique,
  status text not null default 'available' check (status in ('available','redeemed','expired','void')),
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  booking_id uuid references bookings on delete set null,
  note text,
  emailed_at timestamptz                                 -- when the "your offer is ready" email was accepted by the email provider
);
create index on customer_rewards (user_id, status);
create index on customer_rewards (offer_id);

create table reward_redemptions (
  id uuid primary key default gen_random_uuid(),
  reward_id uuid not null references customer_rewards on delete restrict,
  user_id uuid not null references customer_profiles(user_id) on delete cascade,
  offer_id uuid not null references promotional_offers on delete restrict,
  booking_id uuid not null references bookings on delete cascade,
  amount int not null check (amount > 0),
  created_at timestamptz not null default now(),
  released_at timestamptz                       -- set when the booking was cancelled or expired and the reward went back
);
-- One live redemption per booking and per reward: the discount can never be applied twice to the same booking.
create unique index reward_redemptions_booking_uniq on reward_redemptions (booking_id) where released_at is null;
create unique index reward_redemptions_reward_uniq on reward_redemptions (reward_id) where released_at is null;
create index on reward_redemptions (user_id);
create index on reward_redemptions (offer_id);

create table loyalty_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references customer_profiles(user_id) on delete cascade,
  kind text not null check (kind in ('earn','adjust','reverse')),
  points int not null check (points <> 0),
  booking_id uuid references bookings on delete set null,
  note text,
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now()
);
create index on loyalty_transactions (user_id, created_at desc);
-- A stay earns points once.
create unique index loyalty_earn_once on loyalty_transactions (booking_id) where kind = 'earn';

-- Customer requests to change or cancel a booking. Staff decide; nothing is changed automatically.
create table customer_booking_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references customer_profiles(user_id) on delete cascade,
  booking_id uuid not null references bookings on delete cascade,
  kind text not null check (kind in ('cancellation','modification')),
  message text not null check (char_length(trim(message)) between 3 and 1000),
  new_check_in date,
  new_check_out date,
  status text not null default 'open' check (status in ('open','done','declined')),
  staff_note text,
  resolved_by uuid references profiles on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  check ((new_check_in is null) = (new_check_out is null)),
  check (new_check_out is null or new_check_out > new_check_in)
);
create unique index customer_requests_one_open on customer_booking_requests (booking_id, kind) where status = 'open';

alter table notifications drop constraint if exists notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in ('booking_request','request_update','inquiry','review','payment','payment_review','cancellation','checkin_soon','checkout_today','balance_due',
  'low_stock','maintenance','housekeeping','ticket','message_failed','payment_verify','customer_request'));

-- ---------------------------------------------------------------------------
-- Row level security: customers read only their own rows; staff read by permission; nobody writes directly
-- ---------------------------------------------------------------------------
alter table membership_tiers enable row level security;
alter table customer_profiles enable row level security;
alter table customer_activity enable row level security;
alter table promotional_offers enable row level security;
alter table customer_rewards enable row level security;
alter table reward_redemptions enable row level security;
alter table loyalty_transactions enable row level security;
alter table customer_booking_requests enable row level security;
revoke all on customer_profiles, customer_activity, promotional_offers, customer_rewards, reward_redemptions, loyalty_transactions, customer_booking_requests from anon;
revoke insert, update, delete on customer_profiles, customer_activity, customer_rewards, reward_redemptions, loyalty_transactions, customer_booking_requests from authenticated;
revoke all on membership_tiers from anon;
grant select on membership_tiers to anon;

create policy tiers_read on membership_tiers for select to anon, authenticated using (active);
create policy tiers_staff_all on membership_tiers for all to authenticated
  using (has_permission((select auth.uid()), 'customers.manage')) with check (has_permission((select auth.uid()), 'customers.manage'));
create policy tiers_staff_read_all on membership_tiers for select to authenticated using (has_permission((select auth.uid()), 'customers.view'));

create policy cp_own_read on customer_profiles for select to authenticated using (user_id = (select auth.uid()));
create policy cp_staff_read on customer_profiles for select to authenticated using (has_permission((select auth.uid()), 'customers.view'));
create policy ca_staff_read on customer_activity for select to authenticated using (has_permission((select auth.uid()), 'customers.view'));
create policy ca_own_read on customer_activity for select to authenticated using (user_id = (select auth.uid()));
create policy offers_staff_all on promotional_offers for all to authenticated
  using (has_permission((select auth.uid()), 'offers.manage')) with check (has_permission((select auth.uid()), 'offers.manage'));
create policy offers_staff_read on promotional_offers for select to authenticated using (has_permission((select auth.uid()), 'customers.view'));
create policy rewards_own_read on customer_rewards for select to authenticated using (user_id = (select auth.uid()));
create policy rewards_staff_read on customer_rewards for select to authenticated using (has_permission((select auth.uid()), 'customers.view'));
create policy redemptions_own_read on reward_redemptions for select to authenticated using (user_id = (select auth.uid()));
create policy redemptions_staff_read on reward_redemptions for select to authenticated using (has_permission((select auth.uid()), 'customers.view'));
create policy loyalty_own_read on loyalty_transactions for select to authenticated using (user_id = (select auth.uid()));
create policy loyalty_staff_read on loyalty_transactions for select to authenticated using (has_permission((select auth.uid()), 'customers.view'));
create policy creq_own_read on customer_booking_requests for select to authenticated using (user_id = (select auth.uid()));
create policy creq_staff_read on customer_booking_requests for select to authenticated using (has_permission((select auth.uid()), 'bookings.view'));

create trigger trg_audit_offer after insert or update or delete on promotional_offers for each row execute function audit_generic('promotional_offer');
create trigger trg_audit_tier after insert or update or delete on membership_tiers for each row execute function audit_generic('membership_tier');
create trigger trg_audit_customer after update on customer_profiles for each row execute function audit_generic('customer');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function log_customer_activity(p_user uuid, p_kind text, p_detail text default null) returns void
language sql security definer set search_path = public as $$
  insert into customer_activity(user_id, kind, detail) values (p_user, p_kind, p_detail)
$$;
revoke execute on function log_customer_activity(uuid, text, text) from public, anon, authenticated;

create or replace function new_reward_code() returns text
language plpgsql volatile set search_path = public as $$
declare v text;
begin
  loop
    v := 'RGW-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    exit when not exists (select 1 from customer_rewards where code = v);
  end loop;
  return v;
end $$;
revoke execute on function new_reward_code() from public, anon, authenticated;

-- Issue one reward from an offer to a customer, unless they already hold as many as the per-customer limit allows.
create or replace function issue_reward(p_user uuid, p_offer uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare o promotional_offers; v_id uuid; v_exp timestamptz;
begin
  select * into o from promotional_offers where id = p_offer and active;
  if o.id is null then return null; end if;
  if o.valid_to is not null and nairobi_today() > o.valid_to then return null; end if;
  if (select count(*) from customer_rewards where user_id = p_user and offer_id = o.id and status <> 'void') >= o.per_customer_limit then return null; end if;
  v_exp := case when o.valid_days is not null then now() + make_interval(days => o.valid_days) else null end;
  if o.valid_to is not null and (v_exp is null or v_exp > (o.valid_to + 1)::timestamptz) then v_exp := (o.valid_to + 1)::timestamptz; end if;
  insert into customer_rewards(user_id, offer_id, code, expires_at, note) values (p_user, o.id, new_reward_code(), v_exp, p_note) returning id into v_id;
  perform log_customer_activity(p_user, 'reward_issued', o.name);
  return v_id;
end $$;
revoke execute on function issue_reward(uuid, uuid, text) from public, anon, authenticated;

-- Work out the tier a customer has earned. Hand-set tiers are left alone.
create or replace function refresh_customer_tier(p_user uuid) returns text
language plpgsql security definer set search_path = public as $$
declare cp customer_profiles; t membership_tiers;
begin
  select * into cp from customer_profiles where user_id = p_user for update;
  if cp.user_id is null or cp.tier_override then return cp.tier_key; end if;
  -- A tier counts the stays completed inside its own window (its expiry period), or all stays when it never expires.
  select mt.* into t from membership_tiers mt
    where mt.active
      and (select count(*) from bookings b where b.customer_id = p_user and b.status = 'checked_out'
             and (mt.expiry_months is null or b.check_out >= nairobi_today() - make_interval(months => mt.expiry_months))) >= mt.min_completed_stays
      and (select coalesce(sum(b.amount_paid), 0) from bookings b where b.customer_id = p_user and b.status = 'checked_out'
             and (mt.expiry_months is null or b.check_out >= nairobi_today() - make_interval(months => mt.expiry_months))) >= mt.min_spend
    order by mt.rank desc limit 1;
  if t.key is null then select * into t from membership_tiers where key = 'standard'; end if;
  if t.key is distinct from cp.tier_key or cp.tier_expires_at is null or cp.tier_expires_at < now() then
    update customer_profiles set tier_key = t.key,
      tier_expires_at = case when t.expiry_months is null then null else now() + make_interval(months => t.expiry_months) end
      where user_id = p_user;
    if t.key is distinct from cp.tier_key then
      perform log_customer_activity(p_user, 'tier_changed', cp.tier_key || ' -> ' || t.key);
    end if;
  end if;
  return t.key;
end $$;
revoke execute on function refresh_customer_tier(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Activation: called by the signed-in customer after verifying their email
-- ---------------------------------------------------------------------------
create or replace function ensure_customer_profile() returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare v_uid uuid := (select auth.uid()); u record; cp customer_profiles; v_name text; v_new boolean := false; o record; v_issued int := 0;
begin
  if v_uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if exists (select 1 from profiles where id = v_uid) then return jsonb_build_object('status', 'staff'); end if;
  select id, lower(email) as email, email_confirmed_at, raw_user_meta_data into u from auth.users where id = v_uid;
  if u.id is null then raise exception 'Account not found.' using errcode = '42501'; end if;
  if u.email_confirmed_at is null then return jsonb_build_object('status', 'unverified'); end if;
  select * into cp from customer_profiles where user_id = v_uid;
  if cp.user_id is null then
    v_name := left(trim(coalesce(u.raw_user_meta_data ->> 'full_name', split_part(u.email, '@', 1))), 80);
    if char_length(v_name) < 2 then v_name := 'Member'; end if;
    insert into customer_profiles(user_id, full_name, email, verified_at) values (v_uid, v_name, u.email, u.email_confirmed_at) returning * into cp;
    v_new := true;
    perform log_customer_activity(v_uid, 'registered', 'Email verified');
    for o in select id from promotional_offers where audience = 'welcome' and active loop
      if issue_reward(v_uid, o.id, 'Welcome offer') is not null then v_issued := v_issued + 1; end if;
    end loop;
  elsif cp.email <> u.email then
    -- The email was changed through Supabase's verified change flow: follow it.
    update customer_profiles set email = u.email where user_id = v_uid returning * into cp;
    perform log_customer_activity(v_uid, 'email_changed', null);
  end if;
  return jsonb_build_object('status', 'active', 'new', v_new, 'welcome_rewards', v_issued, 'welcome_emailed', cp.welcome_emailed_at is not null,
    'account_status', cp.status, 'full_name', cp.full_name, 'email', cp.email);
end $$;
grant execute on function ensure_customer_profile() to authenticated;

-- The email function records that the welcome email went out (service role only).
create or replace function mark_welcome_emailed(p_user uuid) returns void
language sql security definer set search_path = public as $$
  update customer_profiles set welcome_emailed_at = now() where user_id = p_user and welcome_emailed_at is null
$$;
revoke execute on function mark_welcome_emailed(uuid) from public, anon, authenticated;
grant execute on function mark_welcome_emailed(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Offer rules: one place decides whether an offer applies to a stay, and for how much
-- ---------------------------------------------------------------------------
create or replace function evaluate_offer(p_user uuid, p_offer uuid, p_reward uuid, p_unit uuid, p_in date, p_out date, p_code_discount int, p_has_code boolean)
returns table(ok boolean, message text, amount int)
language plpgsql stable security definer set search_path = public as $$
declare o promotional_offers; cp customer_profiles; u units; q record; r customer_rewards; v_base int; v_amount int; v_tier_rank int; v_min_rank int; v_uses int;
begin
  select * into cp from customer_profiles where user_id = p_user;
  if cp.user_id is null or cp.status <> 'active' then return query select false, 'Your membership is not active.', 0; return; end if;
  select * into o from promotional_offers where id = p_offer;
  select * into u from units where id = p_unit and active;
  if o.id is null or not o.active or u.id is null then return query select false, 'That offer is not available.', 0; return; end if;
  if p_reward is not null then
    select * into r from customer_rewards where id = p_reward;
    if r.id is null or r.user_id <> p_user or r.offer_id <> o.id then return query select false, 'That reward is not yours.', 0; return; end if;
    if r.status <> 'available' then return query select false, case r.status when 'redeemed' then 'That reward has already been used.' else 'That reward is no longer available.' end, 0; return; end if;
    if r.expires_at is not null and r.expires_at < now() then return query select false, 'That reward has expired.', 0; return; end if;
  elsif o.audience <> 'member' then
    return query select false, 'That offer needs to be issued to you first.', 0; return;
  end if;
  if o.valid_from is not null and nairobi_today() < o.valid_from then return query select false, 'That offer has not started yet.', 0; return; end if;
  if o.valid_to is not null and nairobi_today() > o.valid_to then return query select false, 'That offer has expired.', 0; return; end if;
  if cardinality(o.property_ids) > 0 and not (u.property_id = any (o.property_ids)) then return query select false, 'That offer does not apply to this accommodation.', 0; return; end if;
  if o.min_tier_key is not null then
    select rank into v_min_rank from membership_tiers where key = o.min_tier_key;
    select rank into v_tier_rank from membership_tiers where key = cp.tier_key;
    if coalesce(v_tier_rank, 0) < coalesce(v_min_rank, 0) then return query select false, 'That offer is for higher membership tiers.', 0; return; end if;
  end if;
  if o.first_booking_only and exists (select 1 from bookings where customer_id = p_user and status in ('pending','confirmed','checked_in','checked_out')) then
    return query select false, 'That offer is for your first booking only.', 0; return;
  end if;
  if o.returning_only and not exists (select 1 from bookings where customer_id = p_user and status = 'checked_out') then
    return query select false, 'That offer is for returning guests.', 0; return;
  end if;
  if p_has_code and not o.stackable then return query select false, 'That offer cannot be combined with a discount code.', 0; return; end if;
  if o.max_redemptions is not null and (select count(*) from reward_redemptions where offer_id = o.id and released_at is null) >= o.max_redemptions then
    return query select false, 'That offer has been fully redeemed.', 0; return;
  end if;
  select count(*) into v_uses from reward_redemptions where offer_id = o.id and user_id = p_user and released_at is null;
  if p_reward is null and v_uses >= o.per_customer_limit then return query select false, 'You have already used that offer.', 0; return; end if;
  select * into q from quote_stay(p_unit, p_in, p_out);
  if q.nightly_total < o.min_total then return query select false, format('This offer needs a room total of at least KES %s.', o.min_total), 0; return; end if;
  v_base := greatest(0, q.nightly_total - coalesce(p_code_discount, 0));
  v_amount := case o.kind when 'percent' then (v_base * o.value) / 100 else least(o.value, v_base) end;
  if o.max_discount is not null then v_amount := least(v_amount, o.max_discount); end if;
  if v_amount < 1 then return query select false, 'That offer gives no discount on this stay.', 0; return; end if;
  return query select true, 'Offer applied.', v_amount;
end $$;
revoke execute on function evaluate_offer(uuid, uuid, uuid, uuid, date, date, int, boolean) from public, anon, authenticated;

-- What can the signed-in customer use on this stay? (available rewards + open member offers)
create or replace function my_offers_for_stay(p_unit uuid, p_in date, p_out date)
returns table(reward_id uuid, offer_id uuid, name text, audience text, ok boolean, message text, amount int, code text, expires_at timestamptz, terms text)
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then return; end if;
  return query
    select r.id, o.id, o.name, o.audience, e.ok, e.message, e.amount, r.code, r.expires_at, o.terms
    from customer_rewards r join promotional_offers o on o.id = r.offer_id
    cross join lateral evaluate_offer(v_uid, o.id, r.id, p_unit, p_in, p_out, 0, false) e
    where r.user_id = v_uid and r.status = 'available' and (r.expires_at is null or r.expires_at > now())
    union all
    select null::uuid, o.id, o.name, o.audience, e.ok, e.message, e.amount, null::text, null::timestamptz, o.terms
    from promotional_offers o
    cross join lateral evaluate_offer(v_uid, o.id, null, p_unit, p_in, p_out, 0, false) e
    where o.audience = 'member' and o.active
    order by 5 desc, 7 desc;
end $$;
grant execute on function my_offers_for_stay(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Booking as a member: validates the discount code and the offer, creates the booking, records everything atomically.
-- Called by the create-booking edge function with the customer's verified user id (service role only).
-- ---------------------------------------------------------------------------
create or replace function create_booking_member(
  p_user uuid, p_code text, p_reward uuid, p_offer uuid,
  p_unit uuid, p_in date, p_out date, p_guests int,
  p_guest_name text, p_guest_phone text, p_guest_email text default null,
  p_source booking_source default 'website'
) returns bookings
language plpgsql security definer set search_path = public as $$
declare cp customer_profiles; c discount_codes; ce record; oe record; o promotional_offers; r customer_rewards;
        v_code_amt int := 0; v_offer_amt int := 0; b bookings; v_reward uuid := p_reward; v_offer uuid := p_offer;
begin
  select * into cp from customer_profiles where user_id = p_user for update;
  if cp.user_id is null or cp.status <> 'active' then raise exception 'Your membership is not active.' using errcode = 'check_violation'; end if;

  if p_code is not null and trim(p_code) <> '' then
    select * into c from discount_codes where code = upper(trim(p_code)) for update;
    if c.id is null then raise exception 'That code is not valid.' using errcode = 'check_violation'; end if;
    select * into ce from evaluate_discount(c.id, p_unit, p_in, p_out);
    if not ce.ok then raise exception '%', ce.message using errcode = 'check_violation'; end if;
    v_code_amt := ce.amount;
  end if;

  if v_reward is not null then
    select * into r from customer_rewards where id = v_reward for update;      -- serialises two bookings racing for one reward
    if r.id is null then raise exception 'That reward is not valid.' using errcode = 'check_violation'; end if;
    v_offer := r.offer_id;
  end if;
  if v_offer is not null then
    select * into o from promotional_offers where id = v_offer for update;     -- serialises the redemption limit
    select * into oe from evaluate_offer(p_user, v_offer, v_reward, p_unit, p_in, p_out, v_code_amt, v_code_amt > 0);
    if not oe.ok then raise exception '%', oe.message using errcode = 'check_violation'; end if;
    v_offer_amt := oe.amount;
  end if;

  b := create_booking(p_unit, p_in, p_out, p_guests, p_guest_name, p_guest_phone, p_guest_email, p_source, 'hold', v_code_amt + v_offer_amt, null, null, null);

  update bookings set customer_id = p_user where id = b.id returning * into b;
  update customer_profiles set guest_id = coalesce(guest_id, b.guest_id), phone = coalesce(phone, p_guest_phone)
    where user_id = p_user and not exists (select 1 from customer_profiles x where x.guest_id = b.guest_id and x.user_id <> p_user);

  if v_code_amt > 0 then insert into discount_redemptions(code_id, booking_id, amount) values (c.id, b.id, v_code_amt); end if;
  if v_offer_amt > 0 then
    if v_reward is null then
      -- An open member offer is claimed at the moment it is used, so there is always a record behind the discount.
      insert into customer_rewards(user_id, offer_id, code, expires_at, note) values (p_user, v_offer, new_reward_code(), null, 'Claimed at checkout') returning id into v_reward;
    end if;
    insert into reward_redemptions(reward_id, user_id, offer_id, booking_id, amount) values (v_reward, p_user, v_offer, b.id, v_offer_amt);
    update customer_rewards set status = 'redeemed', booking_id = b.id where id = v_reward;
    perform log_customer_activity(p_user, 'reward_redeemed', o.name || ' (' || b.reference || ')');
  end if;
  perform log_customer_activity(p_user, 'booking_made', b.reference);
  return b;
end $$;
revoke execute on function create_booking_member(uuid,text,uuid,uuid,uuid,date,date,int,text,text,text,booking_source) from public, anon, authenticated;
grant execute on function create_booking_member(uuid,text,uuid,uuid,uuid,date,date,int,text,text,text,booking_source) to service_role;

-- A cancelled, expired or no-show booking gives its reward back (if it has not expired meanwhile).
create or replace function trg_release_reward() returns trigger language plpgsql security definer set search_path = public as $$
declare rr record;
begin
  if new.status in ('cancelled','expired','no_show') and old.status is distinct from new.status then
    for rr in update reward_redemptions set released_at = now() where booking_id = new.id and released_at is null returning reward_id, user_id loop
      update customer_rewards set booking_id = null,
        status = case when expires_at is not null and expires_at < now() then 'expired' else 'available' end
        where id = rr.reward_id;
      perform log_customer_activity(rr.user_id, 'reward_released', new.reference);
    end loop;
  end if;
  return new;
end $$;
create trigger trg_bookings_release_reward after update of status on bookings for each row execute function trg_release_reward();

-- A completed stay earns points and may lift the tier.
create or replace function trg_member_checkout() returns trigger language plpgsql security definer set search_path = public as $$
declare v_per numeric; v_pts int;
begin
  if new.customer_id is not null and new.status = 'checked_out' and old.status is distinct from new.status then
    v_per := greatest(1, setting_num('loyalty_kes_per_point', 100));
    v_pts := floor(new.amount_paid / v_per)::int;
    if v_pts > 0 then
      insert into loyalty_transactions(user_id, kind, points, booking_id, note) values (new.customer_id, 'earn', v_pts, new.id, 'Stay ' || new.reference) on conflict do nothing;
    end if;
    perform log_customer_activity(new.customer_id, 'stay_completed', new.reference);
    perform refresh_customer_tier(new.customer_id);
  end if;
  return new;
end $$;
create trigger trg_bookings_member_checkout after update of status on bookings for each row execute function trg_member_checkout();

-- Birthday rewards: run daily. Issues each active birthday offer to members whose birthday is today (once per offer per year).
create or replace function issue_birthday_rewards() returns int
language plpgsql security definer set search_path = public as $$
declare o record; c record; n int := 0; v_today date := nairobi_today();
begin
  for o in select id from promotional_offers where audience = 'birthday' and active loop
    for c in select user_id from customer_profiles where status = 'active' and birthday is not null
             and extract(month from birthday) = extract(month from v_today) and extract(day from birthday) = extract(day from v_today) loop
      if not exists (select 1 from customer_rewards where user_id = c.user_id and offer_id = o.id and issued_at >= date_trunc('year', now())) then
        if issue_reward(c.user_id, o.id, 'Birthday reward') is not null then n := n + 1; end if;
      end if;
    end loop;
  end loop;
  -- Tiers whose term has run out are re-checked against the criteria.
  perform refresh_customer_tier(user_id) from customer_profiles where not tier_override and tier_expires_at is not null and tier_expires_at < now();
  -- Tidy up rewards that ran out.
  update customer_rewards set status = 'expired' where status = 'available' and expires_at is not null and expires_at < now();
  return n;
end $$;
revoke execute on function issue_birthday_rewards() from public, anon, authenticated;
grant execute on function issue_birthday_rewards() to service_role;

-- ---------------------------------------------------------------------------
-- The customer's own data
-- ---------------------------------------------------------------------------
create or replace function my_customer() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); cp customer_profiles; t membership_tiers; v_pts bigint; v_next record; v_stays int; v_spend bigint;
begin
  select * into cp from customer_profiles where user_id = v_uid;
  if cp.user_id is null then return null; end if;
  select * into t from membership_tiers where key = cp.tier_key;
  select coalesce(sum(points), 0) into v_pts from loyalty_transactions where user_id = v_uid;
  select count(*), coalesce(sum(amount_paid), 0) into v_stays, v_spend from bookings where customer_id = v_uid and status = 'checked_out';
  select key, name, min_completed_stays, min_spend into v_next from membership_tiers where active and rank > t.rank order by rank limit 1;
  return jsonb_build_object(
    'user_id', cp.user_id, 'full_name', cp.full_name, 'email', cp.email, 'phone', cp.phone, 'country', cp.country, 'birthday', cp.birthday,
    'status', cp.status, 'marketing_opt_in', cp.marketing_opt_in, 'member_since', cp.created_at,
    'tier', jsonb_build_object('key', t.key, 'name', t.name, 'benefits', to_jsonb(t.benefits), 'expires_at', cp.tier_expires_at),
    'points', v_pts, 'completed_stays', v_stays, 'total_spend', v_spend,
    'next_tier', case when v_next.key is null then null else jsonb_build_object('key', v_next.key, 'name', v_next.name, 'stays_needed', greatest(0, v_next.min_completed_stays - v_stays), 'spend_needed', greatest(0, v_next.min_spend - v_spend)) end);
end $$;
grant execute on function my_customer() to authenticated;

create or replace function update_my_profile(p_name text, p_phone text, p_country text, p_birthday date, p_marketing boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); cp customer_profiles; v_phone text := nullif(trim(coalesce(p_phone, '')), '');
begin
  select * into cp from customer_profiles where user_id = v_uid for update;
  if cp.user_id is null then raise exception 'Verify your email first.' using errcode = '42501'; end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Please enter your name.' using errcode = 'check_violation'; end if;
  if v_phone is not null and v_phone !~ '^254[17][0-9]{8}$' then raise exception 'Enter a valid Kenyan phone number.' using errcode = 'check_violation'; end if;
  if p_birthday is not null and (p_birthday > current_date or p_birthday < date '1900-01-01') then raise exception 'Check the birthday date.' using errcode = 'check_violation'; end if;
  update customer_profiles set full_name = left(trim(p_name), 80), phone = v_phone, country = nullif(left(trim(coalesce(p_country, '')), 60), ''),
    birthday = p_birthday, marketing_opt_in = coalesce(p_marketing, marketing_opt_in) where user_id = v_uid;
  perform log_customer_activity(v_uid, 'profile_updated', null);
end $$;
grant execute on function update_my_profile(text, text, text, date, boolean) to authenticated;

create or replace function my_bookings() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by (x ->> 'check_in') desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', b.id, 'reference', b.reference, 'public_token', b.public_token, 'status', b.status,
      'check_in', b.check_in, 'check_out', b.check_out, 'nights', b.nights, 'guests', b.num_guests,
      'property', p.name, 'property_slug', p.slug, 'unit', u.name, 'total', b.total_amount, 'discount', b.discount, 'paid', b.amount_paid,
      'balance', greatest(0, b.total_amount - b.amount_paid), 'cancelled_at', b.cancelled_at,
      'offer', (select o.name from reward_redemptions rr join promotional_offers o on o.id = rr.offer_id where rr.booking_id = b.id and rr.released_at is null),
      'open_request', (select r.kind from customer_booking_requests r where r.booking_id = b.id and r.status = 'open' limit 1)) as x
    from bookings b join properties p on p.id = b.property_id join units u on u.id = b.unit_id
    where b.customer_id = (select auth.uid()) and b.status <> 'blocked'
  ) s
$$;
grant execute on function my_bookings() to authenticated;

create or replace function my_rewards() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by (x ->> 'issued_at') desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', r.id, 'code', r.code, 'name', o.name, 'description', o.description, 'terms', o.terms, 'audience', o.audience,
      'kind', o.kind, 'value', o.value, 'max_discount', o.max_discount, 'min_total', o.min_total,
      'status', case when r.status = 'available' and r.expires_at is not null and r.expires_at < now() then 'expired' else r.status end,
      'issued_at', r.issued_at, 'expires_at', r.expires_at, 'booking_id', r.booking_id,
      'redeemed_for', (select b.reference from bookings b where b.id = r.booking_id)) as x
    from customer_rewards r join promotional_offers o on o.id = r.offer_id
    where r.user_id = (select auth.uid())
  ) s
$$;
grant execute on function my_rewards() to authenticated;

-- Open member offers the customer may use (shown under "My offers" even before they pick a stay).
create or replace function my_open_offers() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'description', o.description, 'terms', o.terms, 'kind', o.kind, 'value', o.value,
    'max_discount', o.max_discount, 'min_total', o.min_total, 'valid_to', o.valid_to, 'min_tier', o.min_tier_key,
    'used', (select count(*) from reward_redemptions rr where rr.offer_id = o.id and rr.user_id = (select auth.uid()) and rr.released_at is null)) order by o.created_at desc), '[]'::jsonb)
  from promotional_offers o
  where o.audience = 'member' and o.active and (o.valid_to is null or o.valid_to >= nairobi_today())
    and exists (select 1 from customer_profiles cp where cp.user_id = (select auth.uid()) and cp.status = 'active')
$$;
grant execute on function my_open_offers() to authenticated;

-- Ask staff to change or cancel a booking. Only the booking's own customer can ask.
create or replace function request_booking_change(p_booking uuid, p_kind text, p_message text, p_new_in date default null, p_new_out date default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); b bookings; v_id uuid;
begin
  select * into b from bookings where id = p_booking and customer_id = v_uid;
  if b.id is null then raise exception 'Booking not found.' using errcode = 'no_data_found'; end if;
  if b.status not in ('pending','confirmed') then raise exception 'This booking can no longer be changed online. Please contact us.' using errcode = 'check_violation'; end if;
  if p_kind not in ('cancellation','modification') then raise exception 'Choose cancellation or modification.' using errcode = 'check_violation'; end if;
  if p_kind = 'modification' and (p_new_in is null or p_new_out is null) then raise exception 'Choose the new dates.' using errcode = 'check_violation'; end if;
  if (select count(*) from customer_booking_requests where user_id = v_uid and created_at > now() - interval '1 day') >= 10 then
    raise exception 'Too many requests today. Please contact us.' using errcode = 'check_violation';
  end if;
  insert into customer_booking_requests(user_id, booking_id, kind, message, new_check_in, new_check_out)
    values (v_uid, b.id, p_kind, p_message, case when p_kind = 'modification' then p_new_in end, case when p_kind = 'modification' then p_new_out end)
    returning id into v_id;
  insert into notifications(kind, title, body, link, property_id, entity_id)
    values ('customer_request', initcap(p_kind) || ' request: ' || b.reference, left(p_message, 200), '/admin/bookings/' || b.id, b.property_id, v_id) on conflict do nothing;
  perform log_customer_activity(v_uid, 'booking_request', p_kind || ' ' || b.reference);
  return v_id;
exception when unique_violation then
  raise exception 'You already have an open request for this booking.' using errcode = 'check_violation';
end $$;
grant execute on function request_booking_change(uuid, text, text, date, date) to authenticated;

-- Attach an earlier guest booking to the signed-in account. The customer must prove they hold the booking: its reference AND the
-- phone number it was made with, and the booking must not already belong to someone else. Email alone is never enough.
create or replace function claim_booking(p_reference text, p_phone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); cp customer_profiles; b bookings; g guests; n int;
begin
  select * into cp from customer_profiles where user_id = v_uid and status = 'active';
  if cp.user_id is null then raise exception 'Verify your email first.' using errcode = '42501'; end if;
  select count(*) into n from rate_limit_events where key = 'claim:' || v_uid::text and created_at > now() - interval '1 hour';
  if n >= 10 then raise exception 'Too many attempts. Please try again later.' using errcode = 'check_violation'; end if;
  insert into rate_limit_events(key) values ('claim:' || v_uid::text);
  select b2.* into b from bookings b2 join guests g2 on g2.id = b2.guest_id
    where b2.reference = upper(trim(coalesce(p_reference, ''))) and g2.phone = trim(coalesce(p_phone, '')) and b2.status <> 'blocked';
  -- Same answer for "no such booking" and "wrong phone" so references cannot be probed.
  if b.id is null then raise exception 'We could not match that booking. Check the reference and phone number.' using errcode = 'check_violation'; end if;
  if b.customer_id is not null and b.customer_id <> v_uid then raise exception 'We could not match that booking. Check the reference and phone number.' using errcode = 'check_violation'; end if;
  select * into g from guests where id = b.guest_id;
  update bookings set customer_id = v_uid where id = b.id;
  update customer_profiles set guest_id = coalesce(guest_id, b.guest_id), phone = coalesce(phone, g.phone)
    where user_id = v_uid and not exists (select 1 from customer_profiles x where x.guest_id = b.guest_id and x.user_id <> v_uid);
  -- Past stays count towards the tier and points.
  if b.status = 'checked_out' then
    insert into loyalty_transactions(user_id, kind, points, booking_id, note)
      select v_uid, 'earn', floor(b.amount_paid / greatest(1, setting_num('loyalty_kes_per_point', 100)))::int, b.id, 'Stay ' || b.reference
      where floor(b.amount_paid / greatest(1, setting_num('loyalty_kes_per_point', 100))) > 0 on conflict do nothing;
    perform refresh_customer_tier(v_uid);
  end if;
  perform log_customer_activity(v_uid, 'booking_claimed', b.reference);
  return jsonb_build_object('reference', b.reference, 'status', b.status);
end $$;
grant execute on function claim_booking(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Staff: customers, analytics, tiers, loyalty
-- ---------------------------------------------------------------------------
create or replace function admin_customer_list(p_search text default null, p_limit int default 200) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission('customers.view');
  return coalesce((
    select jsonb_agg(x order by (x ->> 'created_at') desc) from (
      select jsonb_build_object(
        'user_id', cp.user_id, 'full_name', cp.full_name, 'email', cp.email, 'phone', cp.phone, 'status', cp.status, 'tier', t.name, 'tier_key', cp.tier_key,
        'created_at', cp.created_at, 'verified_at', cp.verified_at,
        'bookings', (select count(*) from bookings b where b.customer_id = cp.user_id and b.status not in ('cancelled','expired')),
        'spend', (select coalesce(sum(b.amount_paid), 0) from bookings b where b.customer_id = cp.user_id),
        'points', (select coalesce(sum(points), 0) from loyalty_transactions l where l.user_id = cp.user_id),
        'rewards_available', (select count(*) from customer_rewards r where r.user_id = cp.user_id and r.status = 'available' and (r.expires_at is null or r.expires_at > now()))) as x
      from customer_profiles cp join membership_tiers t on t.key = cp.tier_key
      where p_search is null or trim(p_search) = '' or cp.full_name ilike '%' || trim(p_search) || '%' or cp.email ilike '%' || trim(p_search) || '%' or cp.phone ilike '%' || trim(p_search) || '%'
      order by cp.created_at desc limit least(greatest(p_limit, 1), 500)
    ) s), '[]'::jsonb);
end $$;
grant execute on function admin_customer_list(text, int) to authenticated;

create or replace function admin_customer_detail(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cp customer_profiles;
begin
  perform require_permission('customers.view');
  select * into cp from customer_profiles where user_id = p_user;
  if cp.user_id is null then raise exception 'Customer not found.' using errcode = 'no_data_found'; end if;
  return jsonb_build_object(
    'profile', to_jsonb(cp),
    'tier', (select to_jsonb(t) from membership_tiers t where t.key = cp.tier_key),
    'points', (select coalesce(sum(points), 0) from loyalty_transactions where user_id = p_user),
    'bookings', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'reference', b.reference, 'status', b.status, 'check_in', b.check_in, 'check_out', b.check_out, 'total', b.total_amount, 'paid', b.amount_paid, 'discount', b.discount) order by b.check_in desc) from bookings b where b.customer_id = p_user), '[]'::jsonb),
    'rewards', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'name', o.name, 'status', r.status, 'issued_at', r.issued_at, 'expires_at', r.expires_at) order by r.issued_at desc) from customer_rewards r join promotional_offers o on o.id = r.offer_id where r.user_id = p_user), '[]'::jsonb),
    'activity', coalesce((select jsonb_agg(jsonb_build_object('kind', a.kind, 'detail', a.detail, 'created_at', a.created_at) order by a.created_at desc) from (select * from customer_activity where user_id = p_user order by created_at desc limit 50) a), '[]'::jsonb));
end $$;
grant execute on function admin_customer_detail(uuid) to authenticated;

-- Every figure here is counted from the records. Nothing is estimated.
create or replace function membership_overview(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare v_since timestamptz := now() - make_interval(days => least(greatest(p_days, 1), 3650));
begin
  perform require_permission('customers.view');
  return jsonb_build_object(
    'registered', (select count(*) from auth.users u where not exists (select 1 from profiles p where p.id = u.id)),
    'verified', (select count(*) from customer_profiles),
    'new_registrations', (select count(*) from customer_profiles where created_at >= v_since),
    'active_members', (select count(*) from customer_profiles where status = 'active'),
    'suspended', (select count(*) from customer_profiles where status = 'suspended'),
    'welcome_issued', (select count(*) from customer_rewards r join promotional_offers o on o.id = r.offer_id where o.audience = 'welcome'),
    'offers_issued', (select count(*) from customer_rewards),
    'offers_redeemed', (select count(*) from reward_redemptions where released_at is null),
    'discount_value', (select coalesce(sum(amount), 0) from reward_redemptions where released_at is null),
    'member_bookings', (select count(*) from bookings where customer_id is not null and status not in ('cancelled','expired','no_show')),
    'member_revenue', (select coalesce(sum(amount_paid), 0) from bookings where customer_id is not null and status not in ('cancelled','expired','no_show')),
    'by_tier', coalesce((select jsonb_agg(jsonb_build_object('key', t.key, 'name', t.name, 'members', (select count(*) from customer_profiles cp where cp.tier_key = t.key)) order by t.rank) from membership_tiers t), '[]'::jsonb));
end $$;
grant execute on function membership_overview(int) to authenticated;

create or replace function admin_redemptions() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission('customers.view');
  return coalesce((select jsonb_agg(x order by (x ->> 'created_at') desc) from (
    select jsonb_build_object('id', rr.id, 'created_at', rr.created_at, 'released_at', rr.released_at, 'amount', rr.amount, 'offer', o.name, 'code', r.code,
      'customer', cp.full_name, 'user_id', cp.user_id, 'booking_id', b.id, 'reference', b.reference) as x
    from reward_redemptions rr join promotional_offers o on o.id = rr.offer_id join customer_rewards r on r.id = rr.reward_id
    join customer_profiles cp on cp.user_id = rr.user_id join bookings b on b.id = rr.booking_id
    order by rr.created_at desc limit 500) s), '[]'::jsonb);
end $$;
grant execute on function admin_redemptions() to authenticated;

create or replace function admin_loyalty_ledger() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission('customers.view');
  return coalesce((select jsonb_agg(x order by (x ->> 'created_at') desc) from (
    select jsonb_build_object('id', l.id, 'created_at', l.created_at, 'kind', l.kind, 'points', l.points, 'note', l.note, 'customer', cp.full_name, 'user_id', cp.user_id, 'reference', b.reference) as x
    from loyalty_transactions l join customer_profiles cp on cp.user_id = l.user_id left join bookings b on b.id = l.booking_id
    order by l.created_at desc limit 500) s), '[]'::jsonb);
end $$;
grant execute on function admin_loyalty_ledger() to authenticated;

create or replace function admin_customer_activity() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission('customers.view');
  return coalesce((select jsonb_agg(x order by (x ->> 'created_at') desc) from (
    select jsonb_build_object('id', a.id, 'created_at', a.created_at, 'kind', a.kind, 'detail', a.detail, 'customer', cp.full_name, 'user_id', cp.user_id) as x
    from customer_activity a join customer_profiles cp on cp.user_id = a.user_id order by a.created_at desc limit 300) s), '[]'::jsonb);
end $$;
grant execute on function admin_customer_activity() to authenticated;

create or replace function set_customer_status(p_user uuid, p_status text, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_permission('customers.manage');
  if p_status not in ('active','suspended') then raise exception 'Unknown status.' using errcode = 'check_violation'; end if;
  if p_status = 'suspended' and char_length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Say why the account is being suspended.' using errcode = 'check_violation'; end if;
  update customer_profiles set status = p_status, suspended_reason = case when p_status = 'suspended' then trim(p_reason) end where user_id = p_user;
  if not found then raise exception 'Customer not found.' using errcode = 'no_data_found'; end if;
  perform log_customer_activity(p_user, 'status_' || p_status, p_reason);
end $$;
grant execute on function set_customer_status(uuid, text, text) to authenticated;

-- p_tier null = go back to the tier the criteria give.
create or replace function set_customer_tier(p_user uuid, p_tier text) returns text
language plpgsql security definer set search_path = public as $$
declare t membership_tiers; cp customer_profiles;
begin
  perform require_permission('customers.manage');
  select * into cp from customer_profiles where user_id = p_user for update;
  if cp.user_id is null then raise exception 'Customer not found.' using errcode = 'no_data_found'; end if;
  if p_tier is null then
    update customer_profiles set tier_override = false where user_id = p_user;
    return refresh_customer_tier(p_user);
  end if;
  select * into t from membership_tiers where key = p_tier and active;
  if t.key is null then raise exception 'Unknown tier.' using errcode = 'check_violation'; end if;
  update customer_profiles set tier_key = t.key, tier_override = true,
    tier_expires_at = case when t.expiry_months is null then null else now() + make_interval(months => t.expiry_months) end where user_id = p_user;
  perform log_customer_activity(p_user, 'tier_set', cp.tier_key || ' -> ' || t.key || ' (by staff)');
  return t.key;
end $$;
grant execute on function set_customer_tier(uuid, text) to authenticated;

create or replace function adjust_loyalty_points(p_user uuid, p_points int, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_permission('customers.manage');
  if p_points = 0 then raise exception 'Enter a number of points.' using errcode = 'check_violation'; end if;
  if char_length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Say why the points are being adjusted.' using errcode = 'check_violation'; end if;
  if not exists (select 1 from customer_profiles where user_id = p_user) then raise exception 'Customer not found.' using errcode = 'no_data_found'; end if;
  if p_points < 0 and (select coalesce(sum(points), 0) from loyalty_transactions where user_id = p_user) + p_points < 0 then
    raise exception 'That would take the balance below zero.' using errcode = 'check_violation';
  end if;
  insert into loyalty_transactions(user_id, kind, points, note, created_by) values (p_user, 'adjust', p_points, trim(p_note), (select auth.uid()));
  perform log_customer_activity(p_user, 'points_adjusted', p_points::text || ' (' || trim(p_note) || ')');
end $$;
grant execute on function adjust_loyalty_points(uuid, int, text) to authenticated;

create or replace function resolve_customer_request(p_request uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_permission('bookings.manage');
  if p_status not in ('done','declined') then raise exception 'Unknown status.' using errcode = 'check_violation'; end if;
  update customer_booking_requests set status = p_status, staff_note = nullif(trim(coalesce(p_note, '')), ''), resolved_by = (select auth.uid()), resolved_at = now()
    where id = p_request and status = 'open';
  if not found then raise exception 'Request not found or already handled.' using errcode = 'no_data_found'; end if;
end $$;
grant execute on function resolve_customer_request(uuid, text, text) to authenticated;

-- Staff can issue a one-off reward to a customer (for example a goodwill gesture).
create or replace function admin_issue_reward(p_user uuid, p_offer uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  perform require_permission('offers.manage');
  v := issue_reward(p_user, p_offer, nullif(trim(coalesce(p_note, '')), ''));
  if v is null then raise exception 'That offer could not be issued (inactive, expired, or already held).' using errcode = 'check_violation'; end if;
  return v;
end $$;
grant execute on function admin_issue_reward(uuid, uuid, text) to authenticated;

-- Emails: the edge function asks which rewards still need their email, and which members to tell about an offer. Service role only.
create or replace function pending_reward_emails(p_user uuid default null)
returns table(reward_id uuid, user_id uuid, email text, full_name text, marketing_opt_in boolean, audience text, name text, description text, terms text,
              kind text, value int, max_discount int, min_total int, code text, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.id, cp.user_id, cp.email, cp.full_name, cp.marketing_opt_in, o.audience, o.name, o.description, o.terms, o.kind, o.value, o.max_discount, o.min_total, r.code, r.expires_at
  from customer_rewards r join promotional_offers o on o.id = r.offer_id join customer_profiles cp on cp.user_id = r.user_id
  where r.emailed_at is null and r.status = 'available' and o.audience in ('welcome','birthday') and cp.status = 'active'
    and r.issued_at > now() - interval '3 days' and (r.expires_at is null or r.expires_at > now())
    and (p_user is null or cp.user_id = p_user)
    and (o.audience = 'welcome' or cp.marketing_opt_in)
$$;
revoke execute on function pending_reward_emails(uuid) from public, anon, authenticated;
grant execute on function pending_reward_emails(uuid) to service_role;

create or replace function mark_reward_emailed(p_reward uuid) returns void
language sql security definer set search_path = public as $$
  update customer_rewards set emailed_at = now() where id = p_reward and emailed_at is null
$$;
revoke execute on function mark_reward_emailed(uuid) from public, anon, authenticated;
grant execute on function mark_reward_emailed(uuid) to service_role;

create or replace function promo_recipients(p_offer uuid)
returns table(user_id uuid, email text, full_name text)
language sql stable security definer set search_path = public as $$
  select cp.user_id, cp.email, cp.full_name from customer_profiles cp
  where cp.status = 'active' and cp.marketing_opt_in
    and exists (select 1 from promotional_offers o where o.id = p_offer and o.active and o.audience = 'member'
                and (o.valid_to is null or o.valid_to >= nairobi_today())
                and (o.min_tier_key is null or (select rank from membership_tiers where key = cp.tier_key) >= (select rank from membership_tiers where key = o.min_tier_key)))
  order by cp.created_at limit 1000
$$;
revoke execute on function promo_recipients(uuid) from public, anon, authenticated;
grant execute on function promo_recipients(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Seed: the welcome offer (5% off the first booking) and an optional birthday offer, switched off until the owner wants it
-- ---------------------------------------------------------------------------
insert into promotional_offers(name, description, terms, audience, kind, value, valid_days, first_booking_only, per_customer_limit, active) values
  ('Welcome offer: 5% off your first stay', '5% off your first eligible booking as a new member.',
   'Valid for one booking, on the room charge only (not the cleaning fee). Cannot be combined with a discount code. Expires 60 days after you join.',
   'welcome', 'percent', 5, 60, true, 1, true),
  ('Birthday treat', 'A little thank-you in your birthday month.',
   'Valid for one booking, on the room charge only. Expires 30 days after it is issued.',
   'birthday', 'percent', 10, 30, false, 1, false);

-- ---------------------------------------------------------------------------
-- Daily birthday job (only where pg_cron exists)
-- ---------------------------------------------------------------------------
do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('bnb-birthday-rewards', '10 3 * * *', 'select public.issue_birthday_rewards()');
    -- Then email whatever rewards are waiting (birthday rewards, and any welcome email that did not go out at sign-up).
    perform cron.schedule('bnb-member-emails', '20 3 * * *', $c$select public.invoke_edge_function('member-emails')$c$);
  end if;
exception when others then null;
end $cron$;

$mig29$;
    -- ---- 0030_optional_membership.sql ----
    execute $mig30$
-- 0030_optional_membership.sql
-- Registration is free and OPTIONAL. Adds: an owner switch for registration, more welcome-offer controls (minimum nights, room-only or
-- whole-total discount), exactly one welcome reward per customer, adding a booking to an account from its secret link, and the guest
-- versus member analytics. Guest checkout is untouched and stays on by default.

alter table promotional_offers
  add column min_nights int not null default 1 check (min_nights >= 1),
  add column applies_to text not null default 'room' check (applies_to in ('room','total'));   -- room = accommodation charge only

insert into settings(key, value) values ('registration_enabled', 'true') on conflict (key) do nothing;
drop policy if exists settings_public_read on settings;
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes',
                 'mpesa_manual_instructions','mpesa_paybill_display','brand_color','site_content','booking_mode',
                 'business_email','business_address','currency','maintenance_mode','guest_checkout_enabled','registration_enabled'));

-- The owner's two switches. Only these keys, only with the customers.manage permission.
create or replace function set_membership_setting(p_key text, p_value boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_permission('customers.manage');
  if p_key not in ('registration_enabled', 'guest_checkout_enabled') then raise exception 'Unknown setting.' using errcode = 'check_violation'; end if;
  insert into settings(key, value, updated_at) values (p_key, to_jsonb(p_value), now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;
grant execute on function set_membership_setting(text, boolean) to authenticated;

-- A customer gets at most one welcome reward, ever (even if the owner later adds a second welcome offer).
create or replace function issue_reward(p_user uuid, p_offer uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare o promotional_offers; v_id uuid; v_exp timestamptz;
begin
  select * into o from promotional_offers where id = p_offer and active;
  if o.id is null then return null; end if;
  if o.valid_from is not null and nairobi_today() < o.valid_from then return null; end if;
  if o.valid_to is not null and nairobi_today() > o.valid_to then return null; end if;
  if (select count(*) from customer_rewards where user_id = p_user and offer_id = o.id and status <> 'void') >= o.per_customer_limit then return null; end if;
  if o.audience = 'welcome' and exists (select 1 from customer_rewards r join promotional_offers x on x.id = r.offer_id
                                         where r.user_id = p_user and x.audience = 'welcome' and r.status <> 'void') then return null; end if;
  v_exp := case when o.valid_days is not null then now() + make_interval(days => o.valid_days) else null end;
  if o.valid_to is not null and (v_exp is null or v_exp > (o.valid_to + 1)::timestamptz) then v_exp := (o.valid_to + 1)::timestamptz; end if;
  insert into customer_rewards(user_id, offer_id, code, expires_at, note) values (p_user, o.id, new_reward_code(), v_exp, p_note) returning id into v_id;
  perform log_customer_activity(p_user, 'reward_issued', o.name);
  return v_id;
end $$;
revoke execute on function issue_reward(uuid, uuid, text) from public, anon, authenticated;

-- When registration is switched off no NEW membership is created (existing members keep theirs).
create or replace function ensure_customer_profile() returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare v_uid uuid := (select auth.uid()); u record; cp customer_profiles; v_name text; v_new boolean := false; o record; v_issued int := 0;
begin
  if v_uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if exists (select 1 from profiles where id = v_uid) then return jsonb_build_object('status', 'staff'); end if;
  select id, lower(email) as email, email_confirmed_at, raw_user_meta_data into u from auth.users where id = v_uid;
  if u.id is null then raise exception 'Account not found.' using errcode = '42501'; end if;
  if u.email_confirmed_at is null then return jsonb_build_object('status', 'unverified'); end if;
  select * into cp from customer_profiles where user_id = v_uid;
  if cp.user_id is null then
    if (select value from settings where key = 'registration_enabled') = 'false'::jsonb then return jsonb_build_object('status', 'closed'); end if;
    v_name := left(trim(coalesce(u.raw_user_meta_data ->> 'full_name', split_part(u.email, '@', 1))), 80);
    if char_length(v_name) < 2 then v_name := 'Member'; end if;
    insert into customer_profiles(user_id, full_name, email, verified_at) values (v_uid, v_name, u.email, u.email_confirmed_at) returning * into cp;
    v_new := true;
    perform log_customer_activity(v_uid, 'registered', 'Email verified');
    for o in select id from promotional_offers where audience = 'welcome' and active order by created_at loop
      if issue_reward(v_uid, o.id, 'Welcome offer') is not null then v_issued := v_issued + 1; end if;
    end loop;
  elsif cp.email <> u.email then
    update customer_profiles set email = u.email where user_id = v_uid returning * into cp;
    perform log_customer_activity(v_uid, 'email_changed', null);
  end if;
  return jsonb_build_object('status', 'active', 'new', v_new, 'welcome_rewards', v_issued, 'welcome_emailed', cp.welcome_emailed_at is not null,
    'account_status', cp.status, 'full_name', cp.full_name, 'email', cp.email);
end $$;
grant execute on function ensure_customer_profile() to authenticated;

-- Offer rules, now with minimum nights, "room only or whole total", and one welcome redemption per customer.
create or replace function evaluate_offer(p_user uuid, p_offer uuid, p_reward uuid, p_unit uuid, p_in date, p_out date, p_code_discount int, p_has_code boolean)
returns table(ok boolean, message text, amount int)
language plpgsql stable security definer set search_path = public as $$
declare o promotional_offers; cp customer_profiles; u units; q record; r customer_rewards; v_base int; v_amount int; v_tier_rank int; v_min_rank int; v_uses int;
begin
  select * into cp from customer_profiles where user_id = p_user;
  if cp.user_id is null or cp.status <> 'active' then return query select false, 'Your membership is not active.', 0; return; end if;
  select * into o from promotional_offers where id = p_offer;
  select * into u from units where id = p_unit and active;
  if o.id is null or not o.active or u.id is null then return query select false, 'That offer is not available.', 0; return; end if;
  if p_reward is not null then
    select * into r from customer_rewards where id = p_reward;
    if r.id is null or r.user_id <> p_user or r.offer_id <> o.id then return query select false, 'That reward is not yours.', 0; return; end if;
    if r.status <> 'available' then return query select false, case r.status when 'redeemed' then 'That reward has already been used.' else 'That reward is no longer available.' end, 0; return; end if;
    if r.expires_at is not null and r.expires_at < now() then return query select false, 'That reward has expired.', 0; return; end if;
  elsif o.audience <> 'member' then
    return query select false, 'That offer needs to be issued to you first.', 0; return;
  end if;
  if o.audience = 'welcome' and exists (select 1 from reward_redemptions rr join promotional_offers x on x.id = rr.offer_id
                                         where rr.user_id = p_user and x.audience = 'welcome' and rr.released_at is null) then
    return query select false, 'Your welcome offer has already been used.', 0; return;
  end if;
  if o.valid_from is not null and nairobi_today() < o.valid_from then return query select false, 'That offer has not started yet.', 0; return; end if;
  if o.valid_to is not null and nairobi_today() > o.valid_to then return query select false, 'That offer has expired.', 0; return; end if;
  if cardinality(o.property_ids) > 0 and not (u.property_id = any (o.property_ids)) then return query select false, 'That offer does not apply to this accommodation.', 0; return; end if;
  if (p_out - p_in) < o.min_nights then return query select false, format('This offer needs a stay of at least %s night(s).', o.min_nights), 0; return; end if;
  if o.min_tier_key is not null then
    select rank into v_min_rank from membership_tiers where key = o.min_tier_key;
    select rank into v_tier_rank from membership_tiers where key = cp.tier_key;
    if coalesce(v_tier_rank, 0) < coalesce(v_min_rank, 0) then return query select false, 'That offer is for higher membership tiers.', 0; return; end if;
  end if;
  if o.first_booking_only and exists (select 1 from bookings where customer_id = p_user and status in ('pending','confirmed','checked_in','checked_out')) then
    return query select false, 'That offer is for your first booking only.', 0; return;
  end if;
  if o.returning_only and not exists (select 1 from bookings where customer_id = p_user and status = 'checked_out') then
    return query select false, 'That offer is for returning guests.', 0; return;
  end if;
  if p_has_code and not o.stackable then return query select false, 'That offer cannot be combined with a discount code.', 0; return; end if;
  if o.max_redemptions is not null and (select count(*) from reward_redemptions where offer_id = o.id and released_at is null) >= o.max_redemptions then
    return query select false, 'That offer has been fully redeemed.', 0; return;
  end if;
  select count(*) into v_uses from reward_redemptions where offer_id = o.id and user_id = p_user and released_at is null;
  if p_reward is null and v_uses >= o.per_customer_limit then return query select false, 'You have already used that offer.', 0; return; end if;
  select * into q from quote_stay(p_unit, p_in, p_out);
  v_base := case o.applies_to when 'total' then q.total else q.nightly_total end;
  if v_base < o.min_total then return query select false, format('This offer needs a booking of at least KES %s.', o.min_total), 0; return; end if;
  v_base := greatest(0, v_base - coalesce(p_code_discount, 0));
  v_amount := case o.kind when 'percent' then (v_base * o.value) / 100 else least(o.value, v_base) end;
  if o.max_discount is not null then v_amount := least(v_amount, o.max_discount); end if;
  if v_amount < 1 then return query select false, 'That offer gives no discount on this stay.', 0; return; end if;
  return query select true, 'Offer applied.', v_amount;
end $$;
revoke execute on function evaluate_offer(uuid, uuid, uuid, uuid, date, date, int, boolean) from public, anon, authenticated;

-- Add the booking behind a secret booking link to the signed-in account. The link token is the proof; it is only ever held by the
-- guest (it is in their confirmation message). A booking already linked to someone else cannot be taken.
create or replace function claim_booking_by_token(p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); cp customer_profiles; b bookings; g guests; n int;
begin
  select * into cp from customer_profiles where user_id = v_uid and status = 'active';
  if cp.user_id is null then raise exception 'Verify your email first.' using errcode = '42501'; end if;
  select count(*) into n from rate_limit_events where key = 'claim:' || v_uid::text and created_at > now() - interval '1 hour';
  if n >= 20 then raise exception 'Too many attempts. Please try again later.' using errcode = 'check_violation'; end if;
  insert into rate_limit_events(key) values ('claim:' || v_uid::text);
  select * into b from bookings where public_token = p_token and status <> 'blocked';
  if b.id is null or (b.customer_id is not null and b.customer_id <> v_uid) then
    raise exception 'We could not add that booking to your account.' using errcode = 'check_violation';
  end if;
  if b.customer_id is null then
    select * into g from guests where id = b.guest_id;
    update bookings set customer_id = v_uid where id = b.id;
    update customer_profiles set guest_id = coalesce(guest_id, b.guest_id), phone = coalesce(phone, g.phone)
      where user_id = v_uid and not exists (select 1 from customer_profiles x where x.guest_id = b.guest_id and x.user_id <> v_uid);
    if b.status = 'checked_out' then
      insert into loyalty_transactions(user_id, kind, points, booking_id, note)
        select v_uid, 'earn', floor(b.amount_paid / greatest(1, setting_num('loyalty_kes_per_point', 100)))::int, b.id, 'Stay ' || b.reference
        where floor(b.amount_paid / greatest(1, setting_num('loyalty_kes_per_point', 100))) > 0 on conflict do nothing;
      perform refresh_customer_tier(v_uid);
    end if;
    perform log_customer_activity(v_uid, 'booking_claimed', b.reference || ' (booking link)');
  end if;
  return jsonb_build_object('reference', b.reference, 'status', b.status);
end $$;
grant execute on function claim_booking_by_token(uuid) to authenticated;

-- How many earlier guest bookings carry my verified email and are not on any account? A count only: never the bookings themselves.
create or replace function unclaimed_bookings_count() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from bookings b join guests g on g.id = b.guest_id join customer_profiles cp on cp.email = lower(g.email)
  where cp.user_id = (select auth.uid()) and b.customer_id is null and b.status not in ('blocked','expired')
$$;
grant execute on function unclaimed_bookings_count() to authenticated;

-- Guest versus member numbers and the returning-customer rate, all counted from bookings.
create or replace function membership_overview(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare v_since timestamptz := now() - make_interval(days => least(greatest(p_days, 1), 3650)); v_guests int; v_returning int;
begin
  perform require_permission('customers.view');
  select count(*), count(*) filter (where n >= 2) into v_guests, v_returning from (
    select guest_id, count(*) n from bookings where guest_id is not null and status in ('confirmed','checked_in','checked_out') group by guest_id) s;
  return jsonb_build_object(
    'registered', (select count(*) from auth.users u where not exists (select 1 from profiles p where p.id = u.id)),
    'verified', (select count(*) from customer_profiles),
    'new_registrations', (select count(*) from customer_profiles where created_at >= v_since),
    'active_members', (select count(*) from customer_profiles where status = 'active'),
    'suspended', (select count(*) from customer_profiles where status = 'suspended'),
    'welcome_issued', (select count(*) from customer_rewards r join promotional_offers o on o.id = r.offer_id where o.audience = 'welcome'),
    'offers_issued', (select count(*) from customer_rewards),
    'offers_redeemed', (select count(*) from reward_redemptions where released_at is null),
    'discount_value', (select coalesce(sum(amount), 0) from reward_redemptions where released_at is null),
    'member_bookings', (select count(*) from bookings where customer_id is not null and status not in ('cancelled','expired','no_show','blocked')),
    'guest_bookings', (select count(*) from bookings where customer_id is null and guest_id is not null and status not in ('cancelled','expired','no_show','blocked')),
    'member_revenue', (select coalesce(sum(amount_paid), 0) from bookings where customer_id is not null and status not in ('cancelled','expired','no_show')),
    'returning_customers', v_returning, 'booked_customers', v_guests,
    'returning_rate', case when v_guests = 0 then 0 else round(100.0 * v_returning / v_guests) end,
    'registration_enabled', coalesce((select value from settings where key = 'registration_enabled') <> 'false'::jsonb, true),
    'guest_checkout_enabled', coalesce((select value from settings where key = 'guest_checkout_enabled') <> 'false'::jsonb, true),
    'by_tier', coalesce((select jsonb_agg(jsonb_build_object('key', t.key, 'name', t.name, 'members', (select count(*) from customer_profiles cp where cp.tier_key = t.key)) order by t.rank) from membership_tiers t), '[]'::jsonb));
end $$;
grant execute on function membership_overview(int) to authenticated;

-- The welcome offer text the owner wrote earlier mentions the cleaning fee and a fixed expiry; keep it accurate without hardcoding the number.
update promotional_offers set terms = 'Valid for one booking, on the accommodation charge only. Cannot be combined with a discount code unless stated. Your reward expires after the period shown in your account.'
 where audience = 'welcome' and terms like 'Valid for one booking, on the room charge only (not the cleaning fee)%';

$mig30$;
end
$install$;

-- STEP 3: secrets for the scheduled jobs (reminders + M-Pesa reconcile)
do $secrets$
declare
  v_url  constant text := 'https://bxpgpzrtoxjmynyjnfkg.supabase.co';
  v_key  constant text := 'PASTE-YOUR-REAL-SERVICE-ROLE-KEY-HERE';
  v_id   uuid;
begin
  if v_key like 'PASTE-%' or length(v_key) < 40 then
    raise notice 'STEP 3 skipped: you have not pasted your real service_role key yet (the check at the end will show false).';
    return;
  end if;
  select id into v_id from vault.secrets where name = 'functions_base_url';
  if v_id is null then perform vault.create_secret(v_url, 'functions_base_url');
  else perform vault.update_secret(v_id, v_url); end if;
  select id into v_id from vault.secrets where name = 'service_role_key';
  if v_id is null then perform vault.create_secret(v_key, 'service_role_key');
  else perform vault.update_secret(v_id, v_key); end if;
end
$secrets$;

-- STEP 4: remove the E2E test data (only rows for slug e2e-test-property and the guest "E2E Test Guest")
do $cleanup$
begin
  delete from payments where booking_id in (select b.id from bookings b join properties p on p.id = b.property_id where p.slug = 'e2e-test-property');
  delete from message_log where property_id in (select id from properties where slug = 'e2e-test-property');
  delete from housekeeping_tasks where property_id in (select id from properties where slug = 'e2e-test-property');
  delete from bookings where property_id in (select id from properties where slug = 'e2e-test-property');
  delete from guests where full_name = 'E2E Test Guest';
  delete from units where property_id in (select id from properties where slug = 'e2e-test-property');
  delete from properties where slug = 'e2e-test-property';
end
$cleanup$;

-- STEP 5: check (does not show the key). Both should say true.
select name,
  case when name = 'functions_base_url' then decrypted_secret = 'https://bxpgpzrtoxjmynyjnfkg.supabase.co'
       else length(decrypted_secret) > 40 and decrypted_secret not like 'PASTE-%' end as looks_right
from vault.decrypted_secrets where name in ('functions_base_url', 'service_role_key');
