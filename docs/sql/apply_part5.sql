-- apply_pending.sql: paste into the Supabase SQL Editor of project "bnb-system" (ref bxpgpzrtoxjmynyjnfkg) and press Run.
-- PART 5 of 6: migrations 0022 to 0027. Run the parts in order.
-- Stops without changes if this is the wrong project or migration 0008 is missing.
do $apply$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'STOP: this is not the RG Wings project (no bookings table). Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='units' and column_name='maintenance_status') then
    raise exception 'STOP: apply migration 0008 first. Nothing was changed.';
  end if;
  if position('elsif tg_table_name = ''message_log'' then' in pg_get_functiondef('public.trg_notify_more()'::regprocedure)) = 0 then
    execute $m0022$
-- 0022_fix_notify_more.sql
-- Fixes trg_notify_more (0019). It was one if/elsif chain whose last branch read NEW.verified; PL/pgSQL resolves that field
-- when the branch is reached, so any message_log row that was not already 'failed' (e.g. the 'queued' row written before every
-- WhatsApp send) raised "record new has no field verified" and the insert was rejected. Each table now gets its own block.

create or replace function trg_notify_more() returns trigger language plpgsql security definer set search_path = public as $$
declare v_unit text;
begin
  if tg_table_name = 'maintenance_requests' then
    if tg_op = 'INSERT' then
      perform add_notification('maintenance', 'Maintenance: ' || new.title, new.priority || ' priority', '/admin/maintenance', new.property_id, new.id);
    end if;
  elsif tg_table_name = 'housekeeping_tasks' then
    if tg_op = 'INSERT' then
      select name into v_unit from units where id = new.unit_id;
      perform add_notification('housekeeping', 'Room to clean: ' || coalesce(v_unit, ''), case when new.priority then 'Same-day turnover' else null end, '/admin/housekeeping', new.property_id, new.id);
    end if;
  elsif tg_table_name = 'support_tickets' then
    if tg_op = 'INSERT' then
      perform add_notification('ticket', 'Ticket #' || new.ticket_no || ': ' || new.subject, new.priority || ' priority', '/admin/support', new.property_id, new.id);
    end if;
  elsif tg_table_name = 'message_log' then
    if new.status = 'failed' and (tg_op = 'INSERT' or old.status is distinct from 'failed') then
      perform add_notification('message_failed', 'Message not delivered', left(coalesce(new.error, 'Delivery failed'), 140), '/admin/messages', new.property_id, new.id);
    end if;
  elsif tg_table_name = 'payments' then
    if tg_op = 'INSERT' and new.status = 'succeeded' and not new.verified then
      perform add_notification('payment_verify', 'Payment to verify: KES ' || to_char(new.amount, 'FM999,999,999'), new.method::text, '/admin/finance', (select property_id from bookings where id = new.booking_id), new.id);
    end if;
  end if;
  return null;
end $$;

$m0022$;
    raise notice 'Applied 0022';
  else
    raise notice '0022 already applied, skipped';
  end if;
  if to_regclass('public.booking_changes') is null then
    execute $m0023$
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

$m0023$;
    raise notice 'Applied 0023';
  else
    raise notice '0023 already applied, skipped';
  end if;
  if to_regclass('public.stay_discounts') is null then
    execute $m0024$
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

$m0024$;
    raise notice 'Applied 0024';
  else
    raise notice '0024 already applied, skipped';
  end if;
  if to_regclass('public.housekeeping_task_photos') is null then
    execute $m0025$
-- 0025_housekeeping_photos.sql
-- Photos on cleaning tasks (damage, a finished room), added by the person doing the task or a manager. Append-only.
-- Floor staff may upload into the "housekeeping/" folder of the public image bucket (nowhere else).

create table housekeeping_task_photos (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references housekeeping_tasks on delete cascade,
  url text not null check (url ~ '^https://'),
  caption text check (caption is null or char_length(caption) <= 200),
  created_by uuid not null references profiles on delete restrict,
  created_at timestamptz not null default now()
);
create index on housekeeping_task_photos (task_id, created_at);
alter table housekeeping_task_photos enable row level security;
revoke all on housekeeping_task_photos from anon;
revoke update, delete on housekeeping_task_photos from authenticated;

-- Seen by anyone who can see the task; added by its assignee (or a manager of the property).
create policy hk_photos_read on housekeeping_task_photos for select to authenticated
  using (exists (select 1 from housekeeping_tasks t where t.id = task_id and can_access_property((select auth.uid()), t.property_id)
                 and (can_manage_property((select auth.uid()), t.property_id) or t.assigned_to = (select auth.uid()) or t.assigned_to is null)));
create policy hk_photos_insert on housekeeping_task_photos for insert to authenticated
  with check (created_by = (select auth.uid()) and has_permission((select auth.uid()), 'housekeeping.update')
              and exists (select 1 from housekeeping_tasks t where t.id = task_id and can_access_property((select auth.uid()), t.property_id)
                          and (can_manage_property((select auth.uid()), t.property_id) or t.assigned_to = (select auth.uid()))));

do $$ begin
  if to_regclass('storage.buckets') is not null then
    drop policy if exists "housekeeping photos staff write" on storage.objects;
    create policy "housekeeping photos staff write" on storage.objects for insert to authenticated
      with check (bucket_id = 'property-images' and name like 'housekeeping/%' and public.is_staff(auth.uid()));
  end if;
end $$;

$m0025$;
    raise notice 'Applied 0025';
  else
    raise notice '0025 already applied, skipped';
  end if;
  if to_regclass('public.site_pages') is null then
    execute $m0026$
-- 0026_site_pages.sql
-- Editable policy pages (Terms, Privacy, House rules...) shown on the public site at /p/<slug>. A page is public only while
-- it is published. The two starter pages are created as unpublished drafts with a clear "review this" note, so the site never
-- shows legal text that nobody has read.

create table site_pages (
  slug text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  title text not null check (char_length(trim(title)) between 2 and 80),
  body text not null default '' check (char_length(body) <= 30000),
  published boolean not null default false,
  show_in_footer boolean not null default true,
  sort int not null default 0,
  updated_by uuid references profiles on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table site_pages enable row level security;
revoke insert, update, delete on site_pages from anon;
create policy site_pages_public on site_pages for select to anon, authenticated using (published);
create policy site_pages_staff_read on site_pages for select to authenticated using (is_owner_or_manager((select auth.uid())));
create policy site_pages_staff_write on site_pages for all to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy perm_site_pages_write on site_pages as restrictive for all to authenticated
  using (has_permission((select auth.uid()), 'cms.manage') or published) with check (has_permission((select auth.uid()), 'cms.manage'));
create trigger trg_audit_site_page after insert or update or delete on site_pages for each row execute function audit_generic('site_page');
create or replace function stamp_site_page() returns trigger language plpgsql as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
create trigger trg_site_page_stamp before update on site_pages for each row execute function stamp_site_page();

insert into site_pages(slug, title, body, published, show_in_footer, sort) values
('terms', 'Terms and conditions',
 E'# Review before publishing\nThis is a starting outline, not legal advice. Replace it with your own terms, have a lawyer read it, then tick Published.\n\n# Bookings\nA booking is confirmed once the deposit is received. The balance is due before check-in.\n\n# Cancellations\nSee the cancellation policy shown when you book.\n\n# House rules\nPlease respect the property, your neighbours and the quiet hours.', false, true, 10),
('privacy', 'Privacy notice',
 E'# Review before publishing\nThis is a starting outline, not legal advice. Replace it with a notice that matches how you really handle personal data (Kenya Data Protection Act, 2019), then tick Published.\n\n# What we collect\nName, phone number, email and booking details, so we can manage your stay.\n\n# How we use it\nTo confirm bookings, take payments and send confirmations and reminders.\n\n# Your rights\nYou can ask to see, correct or delete your personal data by contacting us.', false, true, 20);

$m0026$;
    raise notice 'Applied 0026';
  else
    raise notice '0026 already applied, skipped';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='properties' and column_name='video_url') then
    execute $m0027$
-- 0027_listing_video.sql
-- An optional walkthrough video per listing (chosen from the media library; the file lives in the public image bucket).

alter table properties add column video_url text check (video_url is null or video_url ~ '^https://');

$m0027$;
    raise notice 'Applied 0027';
  else
    raise notice '0027 already applied, skipped';
  end if;
end
$apply$;
