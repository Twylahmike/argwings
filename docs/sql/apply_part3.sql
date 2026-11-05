-- apply_pending.sql: paste into the Supabase SQL Editor of project "bnb-system" (ref bxpgpzrtoxjmynyjnfkg) and press Run.
-- PART 3 of 4: migrations 0015 to 0018. Run the parts in order.
-- Stops without changes if this is the wrong project or migration 0008 is missing.
do $apply$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'STOP: this is not the RG Wings project (no bookings table). Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='units' and column_name='maintenance_status') then
    raise exception 'STOP: apply migration 0008 first. Nothing was changed.';
  end if;
  if to_regclass('public.blocked_ranges') is null then
    execute $m0015$
-- 0015_blocked_dates_maintenance.sql
-- Blocking dates for one room, several rooms or a whole property (with a reason), refusing to cover a real booking,
-- plus maintenance requests that can take a room out of service while they are open.

create table blocked_ranges (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties on delete cascade,
  scope text not null check (scope in ('unit','units','property')),
  reason text not null check (reason in ('maintenance','renovation','private_use','closure','other')),
  note text check (note is null or char_length(note) <= 300),
  start_date date not null,
  end_date date not null,                       -- exclusive, like check_out
  created_by uuid references profiles on delete set null,
  released_at timestamptz,
  released_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  check (end_date > start_date)
);
create index on blocked_ranges (property_id, start_date);
alter table bookings add column block_range_id uuid references blocked_ranges on delete set null;
create index on bookings (block_range_id) where block_range_id is not null;

alter table blocked_ranges enable row level security;
revoke all on blocked_ranges from anon;
revoke insert, update, delete on blocked_ranges from authenticated;
create policy blocked_ranges_read on blocked_ranges for select to authenticated using (can_manage_property((select auth.uid()), property_id));
create trigger trg_audit_blocked_range after insert or update on blocked_ranges for each row execute function audit_generic('blocked_range');

-- p_units null = every active unit of the property.
create or replace function block_dates(p_property uuid, p_units uuid[], p_in date, p_out date, p_reason text, p_note text default null)
returns blocked_ranges
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); v_units uuid[]; r blocked_ranges; v_scope text; v_clash text; u uuid;
begin
  perform require_permission('blocked.manage');
  if not can_manage_property(v_uid, p_property) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_out is null or p_in is null or p_out <= p_in then raise exception 'The end date must be after the start date.' using errcode = 'check_violation'; end if;
  if p_reason not in ('maintenance','renovation','private_use','closure','other') then raise exception 'Choose a reason.' using errcode = 'check_violation'; end if;
  perform expire_stale_holds();
  if p_units is null then
    select array_agg(id) into v_units from units where property_id = p_property and active;
    v_scope := 'property';
  else
    select array_agg(id) into v_units from units where property_id = p_property and id = any(p_units);
    if coalesce(array_length(v_units, 1), 0) <> coalesce(array_length(p_units, 1), 0) then raise exception 'One of the rooms does not belong to this property.' using errcode = 'check_violation'; end if;
    v_scope := case when array_length(v_units, 1) = 1 then 'unit' else 'units' end;
  end if;
  if v_units is null then raise exception 'This property has no rooms to block.' using errcode = 'check_violation'; end if;

  -- Never cover a live booking: list what is in the way so it can be moved or cancelled first.
  select string_agg(b.reference || ' (' || un.name || ')', ', ') into v_clash
  from bookings b join units un on un.id = b.unit_id
  where b.unit_id = any(v_units) and b.status in ('pending','confirmed','checked_in','blocked')
    and daterange(b.check_in, b.check_out, '[)') && daterange(p_in, p_out, '[)');
  if v_clash is not null then
    raise exception 'These dates overlap existing reservations or blocks: %. Move or cancel them first.', v_clash using errcode = 'check_violation';
  end if;

  insert into blocked_ranges(property_id, scope, reason, note, start_date, end_date, created_by)
    values (p_property, v_scope, p_reason, nullif(trim(coalesce(p_note, '')), ''), p_in, p_out, v_uid) returning * into r;
  foreach u in array v_units loop
    insert into bookings(property_id, unit_id, check_in, check_out, status, source, num_guests, notes, created_by, block_range_id)
      values (p_property, u, p_in, p_out, 'blocked', 'manual', 1, initcap(replace(p_reason, '_', ' ')) || coalesce(': ' || r.note, ''), v_uid, r.id);
  end loop;
  return r;
end $$;
grant execute on function block_dates(uuid, uuid[], date, date, text, text) to authenticated;

create or replace function release_blocked_range(p_range uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); r blocked_ranges;
begin
  perform require_permission('blocked.manage');
  select * into r from blocked_ranges where id = p_range for update;
  if not found or not can_manage_property(v_uid, r.property_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if r.released_at is not null then return; end if;
  update bookings set status = 'cancelled' where block_range_id = p_range and status = 'blocked';
  update blocked_ranges set released_at = now(), released_by = v_uid where id = p_range;
end $$;
grant execute on function release_blocked_range(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Maintenance requests
-- ---------------------------------------------------------------------------
create table maintenance_requests (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties on delete cascade,
  unit_id uuid references units on delete set null,
  title text not null check (char_length(trim(title)) between 3 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'open' check (status in ('open','assigned','in_progress','completed','cancelled')),
  assigned_to uuid references profiles on delete set null,
  reported_by uuid references profiles on delete set null,
  start_date date,
  expected_completion date,
  completed_at timestamptz,
  completion_notes text check (completion_notes is null or char_length(completion_notes) <= 1000),
  takes_unit_offline boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (unit_id is not null or not takes_unit_offline),
  check (expected_completion is null or start_date is null or expected_completion >= start_date),
  check (status <> 'completed' or char_length(trim(coalesce(completion_notes, ''))) >= 3)
);
create index on maintenance_requests (property_id, status);
create index on maintenance_requests (unit_id) where unit_id is not null;
create trigger trg_maint_updated before update on maintenance_requests for each row execute function set_updated_at();

alter table maintenance_requests enable row level security;
revoke all on maintenance_requests from anon;
-- Managers: everything at their properties. Any staff member (housekeeping included) can report an issue and see what they reported
-- or what is assigned to them; assigned staff can move their own request along.
create policy maint_manager_all on maintenance_requests for all to authenticated
  using (can_manage_property((select auth.uid()), property_id)) with check (can_manage_property((select auth.uid()), property_id));
create policy maint_staff_read on maintenance_requests for select to authenticated
  using (reported_by = (select auth.uid()) or assigned_to = (select auth.uid()));
create policy maint_staff_report on maintenance_requests for insert to authenticated
  with check (reported_by = (select auth.uid()) and can_access_property((select auth.uid()), property_id) and assigned_to is null and not takes_unit_offline and status = 'open');
create policy maint_assignee_update on maintenance_requests for update to authenticated
  using (assigned_to = (select auth.uid())) with check (assigned_to = (select auth.uid()));

-- Stamp completion; keep the room's maintenance flag in step with open "takes room offline" requests.
create or replace function maintenance_sync() returns trigger language plpgsql security definer set search_path = public as $$
declare
begin
  if tg_op <> 'DELETE' then
    if new.status = 'completed' and (tg_op = 'INSERT' or old.status <> 'completed') then new.completed_at := now(); end if;
    if new.status <> 'completed' then new.completed_at := null; end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_maint_stamp before insert or update on maintenance_requests for each row execute function maintenance_sync();

create or replace function maintenance_unit_flag() returns trigger language plpgsql security definer set search_path = public as $$
declare v_unit uuid; v_open record;
begin
  for v_unit in select distinct x from unnest(array[case when tg_op <> 'INSERT' then old.unit_id end, case when tg_op <> 'DELETE' then new.unit_id end]) x where x is not null loop
    select id, title into v_open from maintenance_requests
      where unit_id = v_unit and takes_unit_offline and status in ('open','assigned','in_progress') order by created_at limit 1;
    if v_open.id is not null then
      update units set maintenance_status = 'maintenance', maintenance_note = left(v_open.title, 300) where id = v_unit and maintenance_status = 'ok';
    else
      update units set maintenance_status = 'ok', maintenance_note = null
        where id = v_unit and maintenance_status = 'maintenance' and exists (select 1 from maintenance_requests m where m.unit_id = v_unit);
    end if;
  end loop;
  return null;
end $$;
create trigger trg_maint_unit_flag after insert or update or delete on maintenance_requests for each row execute function maintenance_unit_flag();
create trigger trg_audit_maintenance after insert or update or delete on maintenance_requests for each row execute function audit_generic('maintenance_request');

$m0015$;
    raise notice 'Applied 0015';
  else
    raise notice '0015 already applied, skipped';
  end if;
  if to_regclass('public.media_assets') is null then
    execute $m0016$
-- 0016_media_gallery_banners.sql
-- Media library (files already live in the public "property-images" bucket), a managed public gallery with
-- categories, and homepage banners with a publish window. Only staff write; the public sees what is published.

create table media_assets (
  id uuid primary key default gen_random_uuid(),
  url text not null unique check (url ~ '^https://'),
  storage_path text not null,
  kind text not null default 'image' check (kind in ('image','video')),
  title text check (title is null or char_length(title) <= 120),
  alt_text text check (alt_text is null or char_length(alt_text) <= 200),
  category text not null default 'general' check (char_length(category) between 1 and 40),
  size_bytes int check (size_bytes is null or size_bytes >= 0),
  uploaded_by uuid references profiles on delete set null,
  created_at timestamptz not null default now()
);
create index on media_assets (category, created_at desc);

create table gallery_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 40),
  sort int not null default 0,
  published boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index gallery_categories_name_uniq on gallery_categories (lower(name));

create table gallery_items (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references gallery_categories on delete cascade,
  url text not null check (url ~ '^https://'),
  kind text not null default 'image' check (kind in ('image','video')),
  alt_text text check (alt_text is null or char_length(alt_text) <= 200),
  caption text check (caption is null or char_length(caption) <= 140),
  sort int not null default 0,
  published boolean not null default true,
  created_at timestamptz not null default now()
);
create index on gallery_items (category_id, sort);

create table homepage_banners (
  id uuid primary key default gen_random_uuid(),
  placement text not null check (placement in ('hero','promo')),
  title text check (title is null or char_length(title) <= 100),
  subtitle text check (subtitle is null or char_length(subtitle) <= 200),
  image_url text not null check (image_url ~ '^https://'),
  link_url text check (link_url is null or link_url ~ '^(https://|/)'),
  link_label text check (link_label is null or char_length(link_label) <= 40),
  sort int not null default 0,
  published boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create index on homepage_banners (placement, sort);

alter table media_assets enable row level security;
alter table gallery_categories enable row level security;
alter table gallery_items enable row level security;
alter table homepage_banners enable row level security;
revoke insert, update, delete on media_assets, gallery_categories, gallery_items, homepage_banners from anon;
revoke all on media_assets from anon;

create policy media_staff_all on media_assets for all to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy gallery_cat_public on gallery_categories for select to anon, authenticated using (published);
create policy gallery_cat_staff on gallery_categories for all to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy gallery_items_public on gallery_items for select to anon, authenticated
  using (published and exists (select 1 from gallery_categories c where c.id = category_id and c.published));
create policy gallery_items_staff on gallery_items for all to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy banners_public on homepage_banners for select to anon, authenticated
  using (published and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));
create policy banners_staff on homepage_banners for all to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));

create trigger trg_audit_banner  after insert or update or delete on homepage_banners  for each row execute function audit_generic('homepage_banner');
create trigger trg_audit_galitem after insert or update or delete on gallery_items     for each row execute function audit_generic('gallery_item');

-- Is a file still used anywhere on the site?
create or replace function media_in_use(p_url text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from gallery_items where url = p_url)
      or exists (select 1 from homepage_banners where image_url = p_url)
      or exists (select 1 from properties where cover_image = p_url or p_url = any(gallery))
      or exists (select 1 from units where p_url = any(images))
      or exists (select 1 from settings where key in ('logo_url','site_content') and value::text like '%' || p_url || '%')
$$;
revoke execute on function media_in_use(text) from public, anon;
grant execute on function media_in_use(text) to authenticated;

-- Deleting a library file is refused while it is in use. Returns the storage path so the client can remove the object.
create or replace function delete_media_asset(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare a media_assets;
begin
  if not is_owner_or_manager((select auth.uid())) then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into a from media_assets where id = p_id for update;
  if not found then raise exception 'File not found' using errcode = 'no_data_found'; end if;
  if media_in_use(a.url) then raise exception 'This file is still used on the website. Remove it there first.' using errcode = 'check_violation'; end if;
  delete from media_assets where id = p_id;
  return a.storage_path;
end $$;
grant execute on function delete_media_asset(uuid) to authenticated;

$m0016$;
    raise notice 'Applied 0016';
  else
    raise notice '0016 already applied, skipped';
  end if;
  if to_regclass('public.expense_categories') is null then
    execute $m0017$
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

$m0017$;
    raise notice 'Applied 0017';
  else
    raise notice '0017 already applied, skipped';
  end if;
  if to_regclass('public.contact_numbers') is null then
    execute $m0018$
-- 0018_contacts_comms_settings.sql
-- Business contact numbers (shown on the public site), more site settings (email, address, currency, time zone, tax,
-- maintenance mode, payment methods), a "Card" payment method, editable message templates, per-guest communication
-- preferences and delivery retry bookkeeping.

alter type payment_method add value if not exists 'card';

insert into settings(key, value) values
  ('business_email', '""'), ('business_address', '""'), ('currency', '"KES"'), ('timezone', '"Africa/Nairobi"'), ('tax_percent', '0'),
  ('maintenance_mode', 'false'), ('enabled_payment_methods', '["mpesa_stk","mpesa_manual","cash","bank","card","other"]'),
  ('checkout_reminder_days_before', '0')
on conflict (key) do nothing;

drop policy if exists settings_public_read on settings;
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes',
                 'mpesa_manual_instructions','mpesa_paybill_display','brand_color','site_content','booking_mode',
                 'business_email','business_address','currency','maintenance_mode'));

-- A manually recorded card payment must also be verified by the owner.
create or replace function payment_verification_default() returns trigger language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or has_role(v_uid, 'owner') or new.method::text = 'mpesa_stk' then
    new.verified := true;
  elsif new.kind = 'refund' or new.method::text in ('mpesa_manual','bank','card') then
    new.verified := false;
  else
    new.verified := true;
  end if;
  if new.verified then new.verified_at := coalesce(new.verified_at, now()); new.verified_by := coalesce(new.verified_by, v_uid); end if;
  return new;
end $$;

-- ---- contact numbers ---------------------------------------------------------------------------------------------
create table contact_numbers (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(trim(label)) between 2 and 40),
  kind text not null default 'other' check (kind in ('reception','reservations','whatsapp','emergency','management','other')),
  phone text not null check (phone ~ '^254[17]\d{8}$'),
  note text check (note is null or char_length(note) <= 120),
  show_on_website boolean not null default false,
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create unique index contact_numbers_kind_phone_uniq on contact_numbers (kind, phone);
alter table contact_numbers enable row level security;
revoke insert, update, delete on contact_numbers from anon;
-- The public sees only numbers the business chose to publish. Emergency and management numbers are staff-only by default.
create policy contacts_public on contact_numbers for select to anon, authenticated using (show_on_website and active and kind not in ('emergency','management'));
create policy contacts_staff_read on contact_numbers for select to authenticated using (is_owner_or_manager((select auth.uid())));
create policy contacts_owner_write on contact_numbers for all to authenticated
  using (has_role((select auth.uid()), 'owner')) with check (has_role((select auth.uid()), 'owner'));
create trigger trg_audit_contact after insert or update or delete on contact_numbers for each row execute function audit_generic('contact_number');

-- ---- editable message templates ----------------------------------------------------------------------------------
create table message_templates (
  key text primary key check (key in ('booking_confirmed','payment_receipt','balance_reminder','checkin_reminder','checkout_reminder','thank_you')),
  label text not null,
  body text check (body is null or char_length(body) between 10 and 1000),     -- null = built-in wording
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles on delete set null
);
insert into message_templates(key, label) values
  ('booking_confirmed','Booking confirmation'), ('payment_receipt','Payment received'), ('balance_reminder','Outstanding payment reminder'),
  ('checkin_reminder','Pre-arrival reminder'), ('checkout_reminder','Check-out reminder'), ('thank_you','Thank you after the stay');
alter table message_templates enable row level security;
revoke all on message_templates from anon;
create policy templates_staff_read on message_templates for select to authenticated using (is_owner_or_manager((select auth.uid())));
create policy templates_owner_write on message_templates for update to authenticated
  using (has_role((select auth.uid()), 'owner')) with check (has_role((select auth.uid()), 'owner'));
create trigger trg_audit_template after update on message_templates for each row execute function audit_generic('message_template');
create trigger trg_templates_updated before update on message_templates for each row execute function set_updated_at();

-- ---- communication preferences + retry bookkeeping ---------------------------------------------------------------
alter table guests add column comms_opt_out boolean not null default false;      -- no reminders or thank-yous (confirmations and receipts still go)
alter table message_log add column attempts int not null default 1 check (attempts between 1 and 10);
alter table message_log add column last_attempt_at timestamptz;
create index on message_log (status, created_at) where status = 'failed';

$m0018$;
    raise notice 'Applied 0018';
  else
    raise notice '0018 already applied, skipped';
  end if;
end
$apply$;
