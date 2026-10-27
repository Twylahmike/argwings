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
  ('mpesa_manual_instructions','"Pay to the Paybill/Till shown below, using your booking reference as the account number."');

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
