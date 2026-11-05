-- apply_pending.sql: paste into the Supabase SQL Editor of project "bnb-system" (ref bxpgpzrtoxjmynyjnfkg) and press Run.
-- Applies migrations 0009 to 0016. Safe to re-run: each part is skipped if it is already there.
-- Stops without changes if this is the wrong project or migration 0008 is missing.
do $apply$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'STOP: this is not the RG Wings project (no bookings table). Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='units' and column_name='maintenance_status') then
    raise exception 'STOP: apply migration 0008 first. Nothing was changed.';
  end if;
  if to_regclass('public.booking_requests') is null then
    execute $m0009$
-- 0009_booking_requests_notifications.sql
-- 1) Booking requests: guests ask for dates, staff approve / reject / offer other dates. Approval creates a REAL booking
--    (a normal pending hold, with a longer payment window) via the existing create_booking, so the overlap guard,
--    pricing and the M-Pesa flow are all reused. Public booking stays "instant" unless settings.booking_mode = 'request'.
-- 2) In-app notification centre: rows are written by triggers (deduplicated), read state and preferences are per user.

-- ---------------------------------------------------------------------------
-- Settings: booking mode and how long an approved request is held for payment
-- ---------------------------------------------------------------------------
insert into settings(key, value) values ('booking_mode', '"instant"'), ('request_hold_hours', '24') on conflict (key) do nothing;
drop policy if exists settings_public_read on settings;
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes',
                 'mpesa_manual_instructions','mpesa_paybill_display','brand_color','site_content','booking_mode'));

-- ---------------------------------------------------------------------------
-- Is a unit bookable for these dates right now? (same rules as public availability)
-- ---------------------------------------------------------------------------
create or replace function unit_is_free(p_unit uuid, p_in date, p_out date) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from units u
    join properties p on p.id = u.property_id and p.active
    cross join lateral quote_stay(u.id, p_in, p_out) q
    where u.id = p_unit and u.active and p_out > p_in
      and q.nights >= q.min_nights and (u.max_nights is null or q.nights <= u.max_nights)
      and u.maintenance_status = 'ok'
      and not exists (
        select 1 from bookings b
        where b.unit_id = u.id and b.status in ('pending','confirmed','checked_in','blocked')
          and not (b.status = 'pending' and b.hold_expires_at < now())
          and daterange(b.check_in, b.check_out, '[)') && daterange(p_in, p_out, '[)')))
$$;

-- ---------------------------------------------------------------------------
-- Booking requests
-- ---------------------------------------------------------------------------
create table booking_requests (
  id uuid primary key default gen_random_uuid(),
  public_token uuid unique not null default gen_random_uuid(),
  property_id uuid not null references properties,
  unit_id uuid not null references units,
  name text not null check (char_length(name) between 2 and 80),
  phone text not null,
  email text check (email is null or char_length(email) <= 120),
  check_in date not null,
  check_out date not null,
  guests int not null check (guests between 1 and 30),
  message text check (message is null or char_length(message) <= 1000),
  status text not null default 'new' check (status in ('new','approved','rejected','alternative_offered','expired','withdrawn')),
  decision_note text check (decision_note is null or char_length(decision_note) <= 1000),
  alt_check_in date,
  alt_check_out date,
  booking_id uuid references bookings on delete set null,
  decided_by uuid references profiles on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (check_out > check_in),
  check (alt_check_in is null or alt_check_out is null or alt_check_out > alt_check_in),
  check (status <> 'approved' or booking_id is not null)
);
create index on booking_requests (status, created_at desc);
create index on booking_requests (property_id);
create index on booking_requests (unit_id);
create trigger trg_booking_requests_updated before update on booking_requests for each row execute function set_updated_at();

create table booking_request_notes (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references booking_requests on delete cascade,
  user_id uuid references profiles on delete set null,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index on booking_request_notes (request_id, created_at);

alter table booking_requests      enable row level security;
alter table booking_request_notes enable row level security;
revoke all on booking_requests, booking_request_notes from anon;

create policy requests_staff_all on booking_requests for all to authenticated
  using (is_owner_or_manager((select auth.uid())) and can_manage_property((select auth.uid()), property_id))
  with check (is_owner_or_manager((select auth.uid())) and can_manage_property((select auth.uid()), property_id));
create policy request_notes_staff_all on booking_request_notes for all to authenticated
  using (exists (select 1 from booking_requests r where r.id = request_id and can_manage_property((select auth.uid()), r.property_id)))
  with check (user_id = (select auth.uid()) and exists (select 1 from booking_requests r where r.id = request_id and can_manage_property((select auth.uid()), r.property_id)));

create trigger trg_audit_booking_request after insert or update or delete on booking_requests for each row execute function audit_generic('booking_request');

-- ---- public: submit (throttled), follow by secret token, accept other dates, withdraw -----------------------------
create or replace function submit_booking_request(
  p_unit uuid, p_in date, p_out date, p_guests int, p_name text, p_phone text,
  p_email text default null, p_message text default null, p_website text default ''
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_phone text; v_unit units; v_token uuid; n int;
begin
  if coalesce(p_website, '') <> '' then return null; end if;
  v_phone := normalize_ke_phone(p_phone);
  if v_phone is null then raise exception 'Enter a valid Kenyan phone number, for example 0712 345 678.' using errcode = 'check_violation'; end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Please enter your name.' using errcode = 'check_violation'; end if;
  if p_in is null or p_out is null or p_out <= p_in then raise exception 'Check-out must be after check-in.' using errcode = 'check_violation'; end if;
  if p_in < nairobi_today() then raise exception 'Check-in cannot be in the past.' using errcode = 'check_violation'; end if;
  select * into v_unit from units where id = p_unit and active;
  if not found then raise exception 'That place is not available.' using errcode = 'check_violation'; end if;
  if p_guests is null or p_guests < 1 or p_guests > v_unit.max_guests then raise exception 'This place sleeps at most % guests.', v_unit.max_guests using errcode = 'check_violation'; end if;
  if not unit_is_free(p_unit, p_in, p_out) then raise exception 'Those dates are not available. Please choose other dates.' using errcode = 'check_violation'; end if;
  select count(*) into n from rate_limit_events where key = 'request:' || v_phone and created_at > now() - interval '1 hour';
  if n >= 3 then raise exception 'Too many requests from this number. Please wait a while and try again.' using errcode = 'check_violation'; end if;
  select count(*) into n from rate_limit_events where key = 'request:all' and created_at > now() - interval '1 hour';
  if n >= 60 then raise exception 'We are receiving many requests right now. Please try again shortly.' using errcode = 'check_violation'; end if;
  insert into rate_limit_events(key) values ('request:' || v_phone), ('request:all');
  insert into booking_requests(property_id, unit_id, name, phone, email, check_in, check_out, guests, message)
  values (v_unit.property_id, p_unit, trim(p_name), v_phone, nullif(trim(coalesce(p_email, '')), ''), p_in, p_out, p_guests, nullif(trim(coalesce(p_message, '')), ''))
  returning public_token into v_token;
  return v_token;
end $$;
grant execute on function submit_booking_request(uuid,date,date,int,text,text,text,text,text) to anon, authenticated;

-- Safe fields only: no phone, no email, no internal ids.
create or replace function get_booking_request(p_token uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'status', r.status, 'name', r.name, 'check_in', r.check_in, 'check_out', r.check_out, 'guests', r.guests,
    'decision_note', r.decision_note, 'alt_check_in', r.alt_check_in, 'alt_check_out', r.alt_check_out,
    'created_at', r.created_at,
    'unit_name', u.name, 'property_name', p.name, 'property_slug', p.slug,
    'booking_token', case when r.status = 'approved' then b.public_token end,
    'booking_status', case when r.status = 'approved' then b.status::text end)
  from booking_requests r
  join units u on u.id = r.unit_id
  join properties p on p.id = r.property_id
  left join bookings b on b.id = r.booking_id
  where r.public_token = p_token
$$;
grant execute on function get_booking_request(uuid) to anon, authenticated;

create or replace function accept_alternative_dates(p_token uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r booking_requests;
begin
  select * into r from booking_requests where public_token = p_token for update;
  if not found or r.status <> 'alternative_offered' or r.alt_check_in is null then
    raise exception 'There are no new dates to accept.' using errcode = 'check_violation';
  end if;
  if not unit_is_free(r.unit_id, r.alt_check_in, r.alt_check_out) then
    raise exception 'Sorry, those dates have just been taken. Please contact us.' using errcode = 'check_violation';
  end if;
  update booking_requests set check_in = alt_check_in, check_out = alt_check_out, alt_check_in = null, alt_check_out = null, status = 'new' where id = r.id;
end $$;
grant execute on function accept_alternative_dates(uuid) to anon, authenticated;

create or replace function withdraw_booking_request(p_token uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update booking_requests set status = 'withdrawn' where public_token = p_token and status in ('new','alternative_offered');
  if not found then raise exception 'This request can no longer be withdrawn.' using errcode = 'check_violation'; end if;
end $$;
grant execute on function withdraw_booking_request(uuid) to anon, authenticated;

-- ---- staff decisions ------------------------------------------------------------------------------------------
create or replace function approve_booking_request(p_request uuid, p_note text default null) returns bookings
language plpgsql security definer set search_path = public as $$
declare r booking_requests; b bookings; v_hours int;
begin
  select * into r from booking_requests where id = p_request for update;
  if not found or not (is_owner_or_manager(auth.uid()) and can_manage_property(auth.uid(), r.property_id)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if r.status not in ('new','alternative_offered') then
    raise exception 'This request has already been handled (%).', r.status using errcode = 'check_violation';
  end if;
  -- Reuses the booking rules; the overlap guard raises 23P01 if the dates were taken meanwhile.
  b := create_booking(r.unit_id, r.check_in, r.check_out, r.guests, r.name, r.phone, r.email, 'website', 'hold', 0, null, p_note, auth.uid());
  v_hours := greatest(1, least(168, setting_num('request_hold_hours', 24)::int));
  update bookings set hold_expires_at = now() + make_interval(hours => v_hours) where id = b.id returning * into b;
  update booking_requests set status = 'approved', booking_id = b.id, decision_note = nullif(trim(coalesce(p_note, '')), ''),
         decided_by = auth.uid(), decided_at = now() where id = r.id;
  return b;
end $$;
revoke execute on function approve_booking_request(uuid,text) from public, anon;
grant execute on function approve_booking_request(uuid,text) to authenticated;

create or replace function reject_booking_request(p_request uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r booking_requests;
begin
  select * into r from booking_requests where id = p_request for update;
  if not found or not (is_owner_or_manager(auth.uid()) and can_manage_property(auth.uid(), r.property_id)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if r.status not in ('new','alternative_offered') then raise exception 'This request has already been handled (%).', r.status using errcode = 'check_violation'; end if;
  update booking_requests set status = 'rejected', decision_note = nullif(trim(coalesce(p_note, '')), ''), decided_by = auth.uid(), decided_at = now(), alt_check_in = null, alt_check_out = null where id = r.id;
end $$;
revoke execute on function reject_booking_request(uuid,text) from public, anon;
grant execute on function reject_booking_request(uuid,text) to authenticated;

create or replace function offer_alternative_dates(p_request uuid, p_in date, p_out date, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r booking_requests;
begin
  select * into r from booking_requests where id = p_request for update;
  if not found or not (is_owner_or_manager(auth.uid()) and can_manage_property(auth.uid(), r.property_id)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if r.status not in ('new','alternative_offered') then raise exception 'This request has already been handled (%).', r.status using errcode = 'check_violation'; end if;
  if p_in is null or p_out is null or p_out <= p_in or p_in < nairobi_today() then raise exception 'Choose valid future dates.' using errcode = 'check_violation'; end if;
  if not unit_is_free(r.unit_id, p_in, p_out) then raise exception 'Those dates are not available for this unit.' using errcode = 'check_violation'; end if;
  update booking_requests set status = 'alternative_offered', alt_check_in = p_in, alt_check_out = p_out,
         decision_note = nullif(trim(coalesce(p_note, '')), ''), decided_by = auth.uid(), decided_at = now() where id = r.id;
end $$;
revoke execute on function offer_alternative_dates(uuid,date,date,text) from public, anon;
grant execute on function offer_alternative_dates(uuid,date,date,text) to authenticated;

-- ---------------------------------------------------------------------------
-- Notification centre
-- ---------------------------------------------------------------------------
create table notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('booking_request','request_update','inquiry','review','payment','payment_review','cancellation','checkin_soon','checkout_today','balance_due')),
  title text not null,
  body text,
  link text,
  property_id uuid references properties on delete cascade,
  entity_id uuid,
  created_at timestamptz not null default now()
);
create index on notifications (created_at desc);
-- No duplicates: one notification per (kind, record).
create unique index notifications_dedupe on notifications (kind, entity_id) where entity_id is not null;

create table notification_reads (
  user_id uuid not null references profiles on delete cascade,
  notification_id uuid not null references notifications on delete cascade,
  read_at timestamptz not null default now(),
  primary key (user_id, notification_id)
);
create table notification_prefs (
  user_id uuid not null references profiles on delete cascade,
  kind text not null,
  enabled boolean not null default true,
  primary key (user_id, kind)
);

alter table notifications      enable row level security;
alter table notification_reads enable row level security;
alter table notification_prefs enable row level security;
revoke all on notifications, notification_reads, notification_prefs from anon;
revoke insert, update, delete on notifications from authenticated;   -- written only by the triggers below

create policy notifications_staff_read on notifications for select to authenticated
  using (is_owner_or_manager((select auth.uid())) and (property_id is null or can_manage_property((select auth.uid()), property_id)));
create policy notification_reads_own on notification_reads for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy notification_prefs_own on notification_prefs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create or replace function add_notification(p_kind text, p_title text, p_body text, p_link text, p_property uuid, p_entity uuid)
returns void language sql security definer set search_path = public as $$
  insert into notifications(kind, title, body, link, property_id, entity_id) values (p_kind, p_title, p_body, p_link, p_property, p_entity)
  on conflict do nothing
$$;
revoke execute on function add_notification(text,text,text,text,uuid,uuid) from public, anon, authenticated;

create or replace function trg_notify() returns trigger language plpgsql security definer set search_path = public as $$
declare v_ref text; v_prop uuid; v_amount int;
begin
  if tg_table_name = 'inquiries' then
    perform add_notification('inquiry', 'New inquiry from ' || new.name, left(new.message, 140), '/admin/inquiries', new.property_id, new.id);
  elsif tg_table_name = 'reviews' then
    perform add_notification('review', 'New review from ' || new.guest_name || ' (' || new.rating || ' stars)', left(new.body, 140), '/admin/reviews', new.property_id, new.id);
  elsif tg_table_name = 'booking_requests' then
    if tg_op = 'INSERT' then
      perform add_notification('booking_request', 'New booking request from ' || new.name, to_char(new.check_in, 'DD Mon') || ' to ' || to_char(new.check_out, 'DD Mon YYYY') || ', ' || new.guests || ' guest(s)', '/admin/requests', new.property_id, new.id);
    elsif old.status = 'alternative_offered' and new.status = 'new' then
      perform add_notification('request_update', new.name || ' accepted the new dates', to_char(new.check_in, 'DD Mon') || ' to ' || to_char(new.check_out, 'DD Mon YYYY'), '/admin/requests', new.property_id, gen_random_uuid());
    end if;
  elsif tg_table_name = 'payments' then
    if new.status = 'succeeded' and new.kind <> 'refund' and (tg_op = 'INSERT' or old.status is distinct from 'succeeded') then
      select b.reference, b.property_id into v_ref, v_prop from bookings b where b.id = new.booking_id;
      v_amount := new.amount;
      perform add_notification('payment', 'Payment received: KES ' || to_char(v_amount, 'FM999,999,999'), 'Booking ' || coalesce(v_ref, ''), '/admin/bookings/' || new.booking_id, v_prop, new.id);
    end if;
  elsif tg_table_name = 'bookings' then
    if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
      perform add_notification('cancellation', 'Booking cancelled: ' || new.reference, new.cancel_reason, '/admin/bookings/' || new.id, new.property_id, new.id);
    end if;
    if new.payment_review and not old.payment_review then
      perform add_notification('payment_review', 'Payment needs review: ' || new.reference, new.review_reason, '/admin/bookings/' || new.id, new.property_id, new.id);
    end if;
  end if;
  return null;
end $$;
create trigger trg_notify_inquiry   after insert on inquiries        for each row execute function trg_notify();
create trigger trg_notify_review    after insert on reviews          for each row execute function trg_notify();
create trigger trg_notify_request   after insert or update on booking_requests for each row execute function trg_notify();
create trigger trg_notify_payment   after insert or update on payments         for each row execute function trg_notify();
create trigger trg_notify_booking   after update on bookings         for each row execute function trg_notify();

-- Daily: arrivals tomorrow, departures today, unpaid balances close to arrival; and stale requests expire.
create or replace function generate_daily_notifications() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; c int; t date := nairobi_today();
begin
  update booking_requests set status = 'expired' where status in ('new','alternative_offered') and check_in < t;
  insert into notifications(kind, title, body, link, property_id, entity_id)
    select 'checkin_soon', 'Arriving tomorrow: ' || g.full_name, b.reference || ', ' || b.num_guests || ' guest(s)', '/admin/bookings/' || b.id, b.property_id, b.id
    from bookings b join guests g on g.id = b.guest_id where b.status = 'confirmed' and b.check_in = t + 1
    on conflict do nothing;
  get diagnostics c = row_count; n := n + c;
  insert into notifications(kind, title, body, link, property_id, entity_id)
    select 'checkout_today', 'Departing today: ' || g.full_name, b.reference, '/admin/bookings/' || b.id, b.property_id, b.id
    from bookings b join guests g on g.id = b.guest_id where b.status = 'checked_in' and b.check_out = t
    on conflict do nothing;
  get diagnostics c = row_count; n := n + c;
  insert into notifications(kind, title, body, link, property_id, entity_id)
    select 'balance_due', 'Balance due: ' || b.reference, 'KES ' || to_char(b.total_amount - b.amount_paid, 'FM999,999,999') || ' unpaid, arriving ' || to_char(b.check_in, 'DD Mon'), '/admin/bookings/' || b.id, b.property_id, b.id
    from bookings b where b.status in ('confirmed','checked_in') and b.total_amount > b.amount_paid and b.check_in <= t + 2
    on conflict do nothing;
  get diagnostics c = row_count; n := n + c;
  return n;
end $$;
revoke execute on function generate_daily_notifications() from public, anon, authenticated;
grant execute on function generate_daily_notifications() to service_role;

-- ---- reading (SECURITY INVOKER: RLS scopes rows; preferences filter kinds) --------------------------------------
create or replace function my_notifications(p_limit int default 50, p_only_unread boolean default false)
returns table(id uuid, kind text, title text, body text, link text, property_id uuid, created_at timestamptz, is_read boolean)
language sql stable as $$
  select n.id, n.kind, n.title, n.body, n.link, n.property_id, n.created_at, (r.notification_id is not null)
  from notifications n
  left join notification_reads r on r.notification_id = n.id and r.user_id = (select auth.uid())
  where not exists (select 1 from notification_prefs p where p.user_id = (select auth.uid()) and p.kind = n.kind and not p.enabled)
    and (not p_only_unread or r.notification_id is null)
  order by n.created_at desc
  limit least(greatest(p_limit, 1), 200)
$$;
grant execute on function my_notifications(int, boolean) to authenticated;

create or replace function unread_notification_count() returns int
language sql stable as $$
  select count(*)::int from notifications n
  where not exists (select 1 from notification_reads r where r.notification_id = n.id and r.user_id = (select auth.uid()))
    and not exists (select 1 from notification_prefs p where p.user_id = (select auth.uid()) and p.kind = n.kind and not p.enabled)
$$;
grant execute on function unread_notification_count() to authenticated;

-- Mark the given notifications (or every visible unread one when null) as read for the signed-in user.
create or replace function mark_notifications_read(p_ids uuid[] default null) returns void
language sql security invoker as $$
  insert into notification_reads(user_id, notification_id)
  select (select auth.uid()), n.id from notifications n
  where p_ids is null or n.id = any(p_ids)
  on conflict do nothing
$$;
grant execute on function mark_notifications_read(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Daily job (08:10 Nairobi = 05:10 UTC), only where pg_cron exists (same approach as 0004).
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'bnb-daily-notifications';
    perform cron.schedule('bnb-daily-notifications', '10 5 * * *', 'select public.generate_daily_notifications()');
  end if;
end $$;

$m0009$;
    raise notice 'Applied 0009';
  else
    raise notice '0009 already applied, skipped';
  end if;
  if to_regprocedure('public.dashboard_overview(date,date,uuid)') is null then
    execute $m0010$
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

$m0010$;
    raise notice 'Applied 0010';
  else
    raise notice '0010 already applied, skipped';
  end if;
  if to_regclass('public.support_tickets') is null then
    execute $m0011$
-- 0011_support_tickets.sql
-- Internal support tickets: guest complaints, maintenance issues, billing questions. Staff only (owner and managers,
-- managers limited to their properties). Replies are kept as a thread. Everything is audited.

create sequence ticket_no_seq;

create table support_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_no int not null unique default nextval('ticket_no_seq'),
  subject text not null check (char_length(trim(subject)) between 3 and 140),
  description text not null default '' check (char_length(description) <= 4000),
  category text not null default 'general' check (category in ('general','complaint','maintenance','billing','booking','other')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'open' check (status in ('open','in_progress','waiting','resolved','closed')),
  property_id uuid references properties on delete set null,
  booking_id uuid references bookings on delete set null,
  guest_id uuid references guests on delete set null,
  assigned_to uuid references profiles on delete set null,
  created_by uuid references profiles on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on support_tickets (status, priority, created_at desc);
create index on support_tickets (property_id);
create index on support_tickets (assigned_to);
create trigger trg_tickets_updated before update on support_tickets for each row execute function set_updated_at();

-- resolved_at follows the status: set when resolved/closed, cleared when reopened.
create or replace function ticket_status_stamp() returns trigger language plpgsql as $$
begin
  if new.status in ('resolved','closed') then
    new.resolved_at := coalesce(case when tg_op = 'UPDATE' and old.status in ('resolved','closed') then old.resolved_at end, now());
  else
    new.resolved_at := null;
  end if;
  return new;
end $$;
create trigger trg_ticket_stamp before insert or update on support_tickets for each row execute function ticket_status_stamp();

create table support_ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_tickets on delete cascade,
  user_id uuid not null references profiles on delete restrict,
  body text not null check (char_length(trim(body)) between 1 and 4000),
  internal boolean not null default false,
  created_at timestamptz not null default now()
);
create index on support_ticket_messages (ticket_id, created_at);

alter table support_tickets enable row level security;
alter table support_ticket_messages enable row level security;
revoke all on support_tickets, support_ticket_messages from anon;

create policy tickets_staff_all on support_tickets for all to authenticated
  using (is_owner_or_manager((select auth.uid())) and (property_id is null or can_manage_property((select auth.uid()), property_id)))
  with check (is_owner_or_manager((select auth.uid())) and (property_id is null or can_manage_property((select auth.uid()), property_id)));

create policy ticket_messages_staff_all on support_ticket_messages for all to authenticated
  using (exists (select 1 from support_tickets t where t.id = ticket_id and is_owner_or_manager((select auth.uid()))
                 and (t.property_id is null or can_manage_property((select auth.uid()), t.property_id))))
  with check (user_id = (select auth.uid()) and exists (select 1 from support_tickets t where t.id = ticket_id and is_owner_or_manager((select auth.uid()))
                 and (t.property_id is null or can_manage_property((select auth.uid()), t.property_id))));

create trigger trg_audit_ticket after insert or update or delete on support_tickets for each row execute function audit_generic('support_ticket');

$m0011$;
    raise notice 'Applied 0011';
  else
    raise notice '0011 already applied, skipped';
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
end
$apply$;
