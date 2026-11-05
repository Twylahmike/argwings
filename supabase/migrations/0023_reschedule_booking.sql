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
