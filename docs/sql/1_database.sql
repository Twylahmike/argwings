-- RG Wings Stays SQL: 1 of 3, the database (migrations 0001 to 0006)
-- Run in Supabase dashboard > SQL Editor of the project named bnb-system. CHECK THE PROJECT NAME (top-left) BEFORE PRESSING RUN.
-- ONLY for a brand-new EMPTY project. bnb-system already has all of this: do not run it there (the guard below will stop you).

-- SAFETY GUARD: stops this file unless the project is EMPTY (no booking tables, no other app's tables).
do $guard$
begin
  if to_regclass('public.bookings') is not null or to_regclass('public.units') is not null or to_regclass('public.properties') is not null then
    raise exception 'STOP: this project already has the RG Wings booking tables. Part 1 is already applied here. Do not run it again.';
  end if;
  if to_regclass('public.orders') is not null or to_regclass('public.products') is not null or to_regclass('public.payments') is not null
     or to_regclass('public.settings') is not null or to_regclass('public.audit_log') is not null then
    raise exception 'STOP: this looks like a DIFFERENT app (it already has orders/products/payments/settings tables). Open the correct Supabase project and try again. Nothing was changed.';
  end if;
end
$guard$;

-- ===================== 0001_schema.sql =====================
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


-- ===================== 0002_functions.sql =====================
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


-- ===================== 0003_rls.sql =====================
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


-- ===================== 0004_cron.sql =====================
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


-- ===================== 0005_brand_color.sql =====================
-- 0005_brand_color.sql: owner-editable brand colour (Settings > Brand), readable by the public site.
insert into settings(key, value) values ('brand_color', '"#0f766e"') on conflict (key) do nothing;

drop policy if exists settings_public_read on settings;
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes',
                 'mpesa_manual_instructions','mpesa_paybill_display','brand_color'));


-- ===================== 0006_site_content.sql =====================
-- 0006_site_content.sql: marketing copy for the public site (hero headline, reviews, socials...) is edited in
-- Admin > Settings > Website and stored as ONE jsonb value under settings.key = 'site_content'.
-- The only change needed is to let the public site read that key (same allowlist approach as 0005).
drop policy if exists settings_public_read on settings;
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes',
                 'mpesa_manual_instructions','mpesa_paybill_display','brand_color','site_content'));

