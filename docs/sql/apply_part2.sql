-- apply_pending.sql: paste into the Supabase SQL Editor of project "bnb-system" (ref bxpgpzrtoxjmynyjnfkg) and press Run.
-- PART 2 of 11: migrations 0012 to 0014. Run the parts in order.
-- Stops without changes if this is the wrong project or migration 0008 is missing.
do $apply$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'STOP: this is not the RG Wings project (no bookings table). Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='units' and column_name='maintenance_status') then
    raise exception 'STOP: apply migration 0008 first. Nothing was changed.';
  end if;
  if to_regclass('public.discount_codes') is null then
    execute $m0012$
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

$m0012$;
    raise notice 'Applied 0012';
  else
    raise notice '0012 already applied, skipped';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='guests' and column_name='vip') then
    execute $m0013$
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

$m0013$;
    raise notice 'Applied 0013';
  else
    raise notice '0013 already applied, skipped';
  end if;
  if to_regclass('public.booking_charges') is null then
    execute $m0014$
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

$m0014$;
    raise notice 'Applied 0014';
  else
    raise notice '0014 already applied, skipped';
  end if;
end
$apply$;
