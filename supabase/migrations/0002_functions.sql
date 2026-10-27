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
