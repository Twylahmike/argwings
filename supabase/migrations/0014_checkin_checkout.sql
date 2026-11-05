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
