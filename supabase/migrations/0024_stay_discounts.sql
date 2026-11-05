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
