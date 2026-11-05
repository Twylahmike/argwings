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
