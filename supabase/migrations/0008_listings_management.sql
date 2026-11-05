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
