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
