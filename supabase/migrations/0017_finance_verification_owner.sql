-- 0017_finance_verification_owner.sql
-- Finance controls and the owner's overview:
--   * payments carry a verification flag: manual M-Pesa / bank entries and every refund recorded by a manager stay
--     "unverified" until the owner verifies them, and unverified money is never counted as collected revenue;
--   * expenses have configurable categories and an approval step (manager entries wait for the owner);
--   * dashboard_overview and monthly_pnl now count only verified payments and approved expenses;
--   * owner_overview: one read-only function behind the owner's dashboard (owner only).

-- ---- payments: verification ------------------------------------------------------------------------------------
alter table payments
  add column verified boolean not null default true,
  add column verified_by uuid references profiles on delete set null,
  add column verified_at timestamptz;

create or replace function payment_verification_default() returns trigger language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  -- Gateway-confirmed payments (STK) and anything recorded by the owner or the service role are verified at once.
  if v_uid is null or has_permission(v_uid, 'payments.verify') or (new.method = 'mpesa_stk') then
    new.verified := true;
  elsif new.kind = 'refund' or new.method in ('mpesa_manual','bank') then
    new.verified := false;
  else
    new.verified := true;
  end if;
  if new.verified then new.verified_at := coalesce(new.verified_at, now()); new.verified_by := coalesce(new.verified_by, v_uid); end if;
  return new;
end $$;
create trigger trg_payment_verification before insert on payments for each row execute function payment_verification_default();

-- Only the owner (or the system) can change the verification fields.
create or replace function guard_payment_verification() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.verified is distinct from old.verified or new.verified_by is distinct from old.verified_by or new.verified_at is distinct from old.verified_at)
     and auth.uid() is not null and not has_permission(auth.uid(), 'payments.verify') then
    raise exception 'You do not have permission to verify payments' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_payment_verification_guard before update on payments for each row execute function guard_payment_verification();

create or replace function verify_payment(p_payment uuid, p_ok boolean default true) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid());
begin
  perform require_permission('payments.verify');
  update payments set verified = p_ok, verified_by = v_uid, verified_at = now() where id = p_payment;
  if not found then raise exception 'Payment not found' using errcode = 'no_data_found'; end if;
end $$;
grant execute on function verify_payment(uuid, boolean) to authenticated;

-- ---- expenses: categories + approval ---------------------------------------------------------------------------
create table expense_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (name = lower(name) and char_length(name) between 2 and 30),
  active boolean not null default true,
  sort int not null default 0
);
create unique index expense_categories_name_uniq on expense_categories (name);
insert into expense_categories(name, sort) values ('utilities',1),('rent',2),('salaries',3),('cleaning',4),('maintenance',5),('supplies',6),('marketing',7),('internet',8),('transport',9),('repairs',10),('staff',11),('other',99);
alter table expense_categories enable row level security;
revoke all on expense_categories from anon;
create policy expense_categories_read on expense_categories for select to authenticated using (is_owner_or_manager((select auth.uid())));
create policy expense_categories_owner on expense_categories for all to authenticated
  using (has_role((select auth.uid()), 'owner')) with check (has_role((select auth.uid()), 'owner'));

alter table expenses
  add column status text not null default 'approved' check (status in ('approved','pending','rejected')),
  add column reviewed_by uuid references profiles on delete set null,
  add column reviewed_at timestamptz,
  add column review_note text check (review_note is null or char_length(review_note) <= 300);

create or replace function expense_status_default() returns trigger language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    if v_uid is not null and not has_permission(v_uid, 'expenses.approve') then new.status := 'pending'; new.reviewed_by := null; new.reviewed_at := null; end if;
  elsif new.status is distinct from old.status or new.reviewed_by is distinct from old.reviewed_by then
    if v_uid is not null and not has_permission(v_uid, 'expenses.approve') then raise exception 'You do not have permission to approve expenses' using errcode = '42501'; end if;
  elsif v_uid is not null and not has_permission(v_uid, 'expenses.approve') and old.status = 'approved'
        and (new.amount is distinct from old.amount or new.category is distinct from old.category or new.expense_date is distinct from old.expense_date) then
    new.status := 'pending';                      -- changing an approved expense sends it back for approval
  end if;
  return new;
end $$;
create trigger trg_expense_status before insert or update on expenses for each row execute function expense_status_default();

create or replace function review_expense(p_expense uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid());
begin
  perform require_permission('expenses.approve');
  if not p_approve and char_length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Say why the expense was rejected.' using errcode = 'check_violation'; end if;
  update expenses set status = case when p_approve then 'approved' else 'rejected' end, reviewed_by = v_uid, reviewed_at = now(), review_note = nullif(trim(coalesce(p_note, '')), '') where id = p_expense;
  if not found then raise exception 'Expense not found' using errcode = 'no_data_found'; end if;
end $$;
grant execute on function review_expense(uuid, boolean, text) to authenticated;

-- ---- reports now count verified money and approved expenses only ------------------------------------------------
create or replace function monthly_pnl(p_month date)
returns table(property_id uuid, property_name text, income int, refunds int, expenses int, net int)
language sql stable as $$
  with m as (select date_trunc('month', p_month)::date as s, (date_trunc('month', p_month) + interval '1 month')::date as e),
  inc as (
    select b.property_id,
           coalesce(sum(case when pay.kind <> 'refund' then pay.amount end), 0)::int as income,
           coalesce(sum(case when pay.kind = 'refund' then pay.amount end), 0)::int as refunds
    from payments pay join bookings b on b.id = pay.booking_id, m
    where pay.status = 'succeeded' and pay.verified
      and (pay.confirmed_at at time zone 'Africa/Nairobi')::date >= m.s
      and (pay.confirmed_at at time zone 'Africa/Nairobi')::date <  m.e
    group by b.property_id),
  exp as (
    select e.property_id, sum(e.amount)::int as expenses
    from expenses e, m
    where not e.voided and e.status = 'approved' and e.expense_date >= m.s and e.expense_date < m.e
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
  where not e.voided and e.status = 'approved'
    and e.expense_date >= date_trunc('month', p_month)::date
    and e.expense_date <  (date_trunc('month', p_month) + interval '1 month')::date
    and (p_property is null or e.property_id = p_property)
  group by e.category order by 2 desc
$$;

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
                where pay.status = 'succeeded' and pay.verified
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
    where pay.status = 'succeeded' and pay.verified
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
    where pay.status = 'succeeded' and pay.verified and (pay.confirmed_at at time zone 'Africa/Nairobi')::date = d::date
      and (p_property is null or b.property_id = p_property)) r on true
  left join lateral (
    select count(*)::int n from bookings b
    where b.status in ('confirmed','checked_in','checked_out') and b.check_in <= d::date and b.check_out > d::date
      and (p_property is null or b.property_id = p_property)) o on true;

  return jsonb_build_object('from', p_from, 'to', p_to, 'days', v_days, 'units', v_units,
    'current', cur->'cur', 'previous', cur->'prev', 'by_method', v_by_method, 'by_source', v_by_source, 'daily', v_daily);
end $$;
grant execute on function dashboard_overview(date, date, uuid) to authenticated;

-- ---- owner's overview --------------------------------------------------------------------------------------------
create or replace function owner_overview(p_from date, p_to date) returns jsonb
language plpgsql stable security invoker as $$
declare
  v_uid uuid := (select auth.uid()); v_today date := nairobi_today();
  v_gross bigint; v_collected bigint; v_unverified bigint; v_refunds bigint; v_outstanding bigint; v_exp bigint; v_exp_pending bigint;
  v_monthly jsonb; v_by_prop jsonb; v_units int; v_occupied int; v_maint int; v_book jsonb; v_ops jsonb; v_staff jsonb; v_perf jsonb;
begin
  perform require_permission('owner.overview');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 731 then raise exception 'Choose a valid date range of two years or less' using errcode = 'check_violation'; end if;

  select coalesce(sum(total_amount), 0) into v_gross from bookings
    where status in ('confirmed','checked_in','checked_out') and check_in between p_from and p_to;
  select coalesce(sum(case when kind = 'refund' then -amount else amount end) filter (where verified), 0),
         coalesce(sum(case when kind = 'refund' then -amount else amount end) filter (where not verified), 0),
         coalesce(sum(amount) filter (where kind = 'refund' and verified), 0)
    into v_collected, v_unverified, v_refunds
    from payments where status = 'succeeded' and (confirmed_at at time zone 'Africa/Nairobi')::date between p_from and p_to;
  select coalesce(sum(greatest(total_amount - amount_paid, 0)), 0) into v_outstanding from bookings where status in ('confirmed','checked_in','checked_out');
  select coalesce(sum(amount) filter (where status = 'approved'), 0), coalesce(sum(amount) filter (where status = 'pending'), 0)
    into v_exp, v_exp_pending from expenses where not voided and expense_date between p_from and p_to;

  select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'),
      'revenue', (select coalesce(sum(case when kind = 'refund' then -amount else amount end), 0) from payments
                   where status = 'succeeded' and verified and date_trunc('month', confirmed_at at time zone 'Africa/Nairobi') = m),
      'expenses', (select coalesce(sum(amount), 0) from expenses where not voided and status = 'approved' and date_trunc('month', expense_date) = m)) order by m), '[]'::jsonb)
    into v_monthly from generate_series(date_trunc('month', p_to) - interval '11 months', date_trunc('month', p_to), interval '1 month') m;

  select coalesce(jsonb_agg(x order by (x->>'collected')::bigint desc), '[]'::jsonb) into v_by_prop from (
    select jsonb_build_object('property', p.name,
      'collected', coalesce((select sum(case when pay.kind = 'refund' then -pay.amount else pay.amount end) from payments pay join bookings b on b.id = pay.booking_id
                              where b.property_id = p.id and pay.status = 'succeeded' and pay.verified and (pay.confirmed_at at time zone 'Africa/Nairobi')::date between p_from and p_to), 0),
      'bookings', (select count(*) from bookings b where b.property_id = p.id and b.status in ('confirmed','checked_in','checked_out') and b.check_in between p_from and p_to),
      'occupied_nights', (select coalesce(sum(greatest(0, least(b.check_out, p_to + 1) - greatest(b.check_in, p_from))), 0) from bookings b
                           where b.property_id = p.id and b.status in ('confirmed','checked_in','checked_out') and b.check_in <= p_to and b.check_out > p_from),
      'units', (select count(*) from units u where u.property_id = p.id and u.active)) as x
    from properties p where p.archived_at is null) t;

  select count(*) into v_units from units where active;
  select count(distinct unit_id) into v_occupied from bookings where status = 'checked_in';
  select count(*) into v_maint from units where active and maintenance_status <> 'ok';
  v_perf := (dashboard_overview(p_from, p_to, null))->'current';

  select jsonb_build_object(
    'total', (select count(*) from bookings where status <> 'blocked' and (created_at at time zone 'Africa/Nairobi')::date between p_from and p_to),
    'confirmed', (select count(*) from bookings where status in ('confirmed','checked_in','checked_out') and (created_at at time zone 'Africa/Nairobi')::date between p_from and p_to),
    'pending_requests', (select count(*) from booking_requests where status = 'new'),
    'cancelled', (select count(*) from bookings where status = 'cancelled' and (cancelled_at at time zone 'Africa/Nairobi')::date between p_from and p_to),
    'upcoming_checkins', (select count(*) from bookings where status in ('confirmed','pending') and check_in between v_today and v_today + 7),
    'upcoming_checkouts', (select count(*) from bookings where status = 'checked_in' and check_out between v_today and v_today + 7)) into v_book;

  select jsonb_build_object(
    'rooms_to_clean', (select count(*) from housekeeping_tasks where status in ('dirty','in_progress')),
    'open_maintenance', (select count(*) from maintenance_requests where status in ('open','assigned','in_progress')),
    'open_tickets', (select count(*) from support_tickets where status in ('open','in_progress','waiting')),
    'unverified_payments', (select count(*) from payments where status = 'succeeded' and not verified),
    'pending_expenses', (select count(*) from expenses where status = 'pending' and not voided)) into v_ops;

  select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(pr.full_name, 'System'), 'actions', c) order by c desc), '[]'::jsonb) into v_staff from (
    select user_id, count(*) c from audit_log where (created_at at time zone 'Africa/Nairobi')::date between p_from and p_to group by user_id order by 2 desc limit 8) a
    left join profiles pr on pr.id = a.user_id;

  return jsonb_build_object('from', p_from, 'to', p_to,
    'finance', jsonb_build_object('gross_booking_value', v_gross, 'collected', v_collected, 'unverified', v_unverified, 'refunds', v_refunds,
        'outstanding', v_outstanding, 'expenses', v_exp, 'expenses_pending', v_exp_pending, 'net_operating_income', v_collected - v_exp),
    'monthly', v_monthly, 'by_property', v_by_prop,
    'units', jsonb_build_object('total', v_units, 'occupied', v_occupied, 'maintenance', v_maint, 'available', greatest(v_units - v_occupied - v_maint, 0)),
    'performance', v_perf, 'bookings', v_book, 'operations', v_ops, 'staff_activity', v_staff);
end $$;
grant execute on function owner_overview(date, date) to authenticated;

-- ---- financial records are never hard-deleted ---------------------------------------------------------------------
-- Expenses are voided, payments are corrected with a refund or adjustment. (Cascades from deleting a booking are unaffected.)
drop policy if exists expenses_owner_delete on expenses;
drop policy if exists payments_owner_all on payments;
create policy payments_owner_select on payments for select to authenticated using (has_role((select auth.uid()), 'owner'));
create policy payments_owner_insert on payments for insert to authenticated with check (has_role((select auth.uid()), 'owner'));
create policy payments_owner_update on payments for update to authenticated using (has_role((select auth.uid()), 'owner')) with check (has_role((select auth.uid()), 'owner'));
