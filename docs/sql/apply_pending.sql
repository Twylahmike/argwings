-- apply_pending.sql: paste into the Supabase SQL Editor of project "bnb-system" (ref bxpgpzrtoxjmynyjnfkg) and press Run.
-- Applies migrations 0009 to 0020. Safe to re-run: each part is skipped if it is already there.
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
  perform require_permission('requests.manage');
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
  perform require_permission('requests.manage');
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
  perform require_permission('requests.manage');
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
  perform require_permission('credit.manage');
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
  perform require_permission('credit.manage');
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
  if to_regclass('public.bar_products') is null then
    execute $m0019$
-- 0019_bar_smart_access_notifications.sql
-- 1. Optional bar menu + stock modules (off by default; the public menu shows only when switched on).
-- 2. Smart access framework: devices, temporary credentials (PINs are shown once and stored only as a salted digest),
--    and an access log. Nothing is ever reported as programmed on a lock unless a provider adapter confirmed it.
-- 3. More notification kinds: maintenance, housekeeping, low stock, failed messages, tickets, payments to verify.

insert into settings(key, value) values ('module_bar_menu','false'), ('module_bar_stock','false') on conflict (key) do nothing;
drop policy if exists settings_public_read on settings;
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes',
                 'mpesa_manual_instructions','mpesa_paybill_display','brand_color','site_content','booking_mode',
                 'business_email','business_address','currency','maintenance_mode','module_bar_menu'));

create or replace function module_on(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true'::jsonb from settings where key = p_key), false)
$$;

-- ---------------------------------------------------------------------------
-- Bar
-- ---------------------------------------------------------------------------
create table bar_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 40),
  sort int not null default 0,
  active boolean not null default true
);
create unique index bar_categories_name_uniq on bar_categories (lower(name));

create table bar_products (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references bar_categories on delete set null,
  name text not null check (char_length(trim(name)) between 2 and 80),
  description text check (description is null or char_length(description) <= 300),
  price int not null check (price >= 0),
  image_url text check (image_url is null or image_url ~ '^https://'),
  available boolean not null default true,
  track_stock boolean not null default false,
  stock_qty int not null default 0 check (stock_qty >= 0),
  low_stock_level int not null default 5 check (low_stock_level >= 0),
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index bar_products_name_uniq on bar_products (lower(name), coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid));
create trigger trg_bar_products_updated before update on bar_products for each row execute function set_updated_at();

create table bar_stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references bar_products on delete restrict,
  kind text not null check (kind in ('purchase','sale','adjustment','wastage')),
  qty int not null check (qty <> 0),                         -- signed: purchases +, sales and wastage -
  unit_cost int check (unit_cost is null or unit_cost >= 0),
  unit_price int check (unit_price is null or unit_price >= 0),
  booking_id uuid references bookings on delete set null,
  note text check (note is null or char_length(note) <= 200),
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  check ((kind = 'purchase' and qty > 0) or (kind in ('sale','wastage') and qty < 0) or kind = 'adjustment')
);
create index on bar_stock_movements (product_id, created_at desc);

alter table bar_categories enable row level security;
alter table bar_products enable row level security;
alter table bar_stock_movements enable row level security;
revoke insert, update, delete on bar_categories, bar_products from anon;
revoke all on bar_stock_movements from anon;
revoke insert, update, delete on bar_stock_movements from authenticated;       -- movements are written by the functions below only
-- Public menu: only while the module is on, and only available items.
create policy bar_cat_public on bar_categories for select to anon, authenticated using (active and module_on('module_bar_menu'));
create policy bar_prod_public on bar_products for select to anon, authenticated using (available and module_on('module_bar_menu'));
create policy bar_cat_staff on bar_categories for all to authenticated using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy bar_prod_staff on bar_products for all to authenticated using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy bar_moves_staff on bar_stock_movements for select to authenticated using (is_owner_or_manager((select auth.uid())));
create trigger trg_audit_bar_product after insert or update or delete on bar_products for each row execute function audit_generic('bar_product');

-- Stock can only change through the movement ledger (a direct edit of the number is refused).
create or replace function guard_stock_qty() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then new.stock_qty := 0;
  elsif new.stock_qty is distinct from old.stock_qty and pg_trigger_depth() < 2 then
    raise exception 'Record a purchase, wastage or adjustment to change stock.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_guard_stock before insert or update on bar_products for each row execute function guard_stock_qty();

-- stock follows the movements
create or replace function apply_stock_movement() returns trigger language plpgsql security definer set search_path = public as $$
declare p bar_products;
begin
  select * into p from bar_products where id = new.product_id for update;
  update bar_products set stock_qty = p.stock_qty + new.qty where id = p.id;       -- the CHECK (stock_qty >= 0) refuses overselling
  if p.track_stock and p.stock_qty > p.low_stock_level and p.stock_qty + new.qty <= p.low_stock_level then
    perform add_notification('low_stock', 'Low stock: ' || p.name, (p.stock_qty + new.qty) || ' left (alert level ' || p.low_stock_level || ')', '/admin/bar', null, gen_random_uuid());
  end if;
  return null;
end $$;
create trigger trg_apply_stock after insert on bar_stock_movements for each row execute function apply_stock_movement();

create or replace function record_stock_movement(p_product uuid, p_kind text, p_qty int, p_unit_cost int default null, p_note text default null) returns int
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); p bar_products; v_signed int;
begin
  perform require_permission('bar.manage');
  if not is_owner_or_manager(v_uid) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if not module_on('module_bar_stock') then raise exception 'Bar stock is switched off in Settings.' using errcode = 'check_violation'; end if;
  if p_kind not in ('purchase','wastage','adjustment') then raise exception 'Use the sale button to record sales.' using errcode = 'check_violation'; end if;
  select * into p from bar_products where id = p_product for update;
  if not found then raise exception 'Product not found' using errcode = 'no_data_found'; end if;
  if p_qty is null or p_qty = 0 then raise exception 'Enter a quantity.' using errcode = 'check_violation'; end if;
  v_signed := case p_kind when 'purchase' then abs(p_qty) when 'wastage' then -abs(p_qty) else p_qty end;
  if p.stock_qty + v_signed < 0 then raise exception 'Only % in stock.', p.stock_qty using errcode = 'check_violation'; end if;
  if p_kind = 'adjustment' and char_length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Say why the stock is being adjusted.' using errcode = 'check_violation'; end if;
  insert into bar_stock_movements(product_id, kind, qty, unit_cost, note, created_by) values (p_product, p_kind, v_signed, p_unit_cost, nullif(trim(coalesce(p_note, '')), ''), v_uid);
  return p.stock_qty + v_signed;
end $$;
grant execute on function record_stock_movement(uuid, text, int, int, text) to authenticated;

-- A sale: reduces stock (if tracked) and can be charged to a guest's booking.
create or replace function sell_bar_item(p_product uuid, p_qty int, p_booking uuid default null) returns int
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); p bar_products; b bookings;
begin
  perform require_permission('bar.manage');
  if not is_owner_or_manager(v_uid) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_qty is null or p_qty < 1 or p_qty > 500 then raise exception 'Enter a quantity from 1 to 500.' using errcode = 'check_violation'; end if;
  select * into p from bar_products where id = p_product for update;
  if not found or not p.available then raise exception 'That item is not available.' using errcode = 'check_violation'; end if;
  if p_booking is not null then
    select * into b from bookings where id = p_booking for update;
    if not found or not can_manage_property(v_uid, b.property_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
    if b.status not in ('confirmed','checked_in') then raise exception 'Charges can only go on a confirmed or checked-in stay.' using errcode = 'check_violation'; end if;
  end if;
  if p.track_stock then
    if not module_on('module_bar_stock') then raise exception 'Bar stock is switched off in Settings.' using errcode = 'check_violation'; end if;
    if p.stock_qty < p_qty then raise exception 'Only % in stock.', p.stock_qty using errcode = 'check_violation'; end if;
    insert into bar_stock_movements(product_id, kind, qty, unit_price, booking_id, created_by) values (p_product, 'sale', -p_qty, p.price, p_booking, v_uid);
  end if;
  if p_booking is not null and p.price * p_qty > 0 then
    insert into booking_charges(booking_id, label, amount, created_by) values (p_booking, left('Bar: ' || p.name || ' x' || p_qty, 80), p.price * p_qty, v_uid);
  end if;
  return p.price * p_qty;
end $$;
grant execute on function sell_bar_item(uuid, int, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Smart access
-- ---------------------------------------------------------------------------
create table smart_lock_devices (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties on delete cascade,
  unit_id uuid not null references units on delete cascade,
  label text not null check (char_length(trim(label)) between 2 and 60),
  provider text not null default 'manual' check (provider in ('manual','external')),   -- 'external' = needs an adapter + credentials (not shipped)
  external_id text check (external_id is null or char_length(external_id) <= 120),
  status text not null default 'unconfigured' check (status in ('unconfigured','online','offline','unknown')),
  last_seen_at timestamptz,
  battery_pct int check (battery_pct is null or battery_pct between 0 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index on smart_lock_devices (unit_id);

create table access_credentials (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings on delete cascade,
  device_id uuid not null references smart_lock_devices on delete restrict,
  kind text not null default 'pin' check (kind in ('pin')),
  pin_digest bytea not null,                         -- sha256(salt || pin); the PIN itself is never stored
  salt bytea not null,
  pin_hint text not null,                            -- last two digits, to tell codes apart
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  status text not null default 'pending' check (status in ('pending','provisioned','manual','failed','revoked','expired')),
  provider_ref text,
  revoked_reason text check (revoked_reason is null or char_length(revoked_reason) <= 200),
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  check (valid_until > valid_from)
);
create index on access_credentials (booking_id);
create index on access_credentials (device_id, valid_until);

create table access_logs (
  id bigint generated always as identity primary key,
  action text not null,
  device_id uuid references smart_lock_devices on delete set null,
  credential_id uuid references access_credentials on delete set null,
  booking_id uuid references bookings on delete set null,
  actor uuid references profiles on delete set null,
  detail text,
  created_at timestamptz not null default now()
);
create index on access_logs (created_at desc);

alter table smart_lock_devices enable row level security;
alter table access_credentials enable row level security;
alter table access_logs enable row level security;
revoke all on smart_lock_devices, access_credentials, access_logs from anon;
revoke insert, update, delete on access_credentials, access_logs from authenticated;
create policy lock_devices_read on smart_lock_devices for select to authenticated using (can_manage_property((select auth.uid()), property_id));
create policy lock_devices_write on smart_lock_devices for insert to authenticated with check (has_role((select auth.uid()), 'owner'));
create policy lock_devices_update on smart_lock_devices for update to authenticated using (has_role((select auth.uid()), 'owner')) with check (has_role((select auth.uid()), 'owner'));
-- the PIN digest and salt are never readable by logged-in users: expose a column-limited view of the safe fields
revoke select on access_credentials from authenticated;
grant select (id, booking_id, device_id, kind, pin_hint, valid_from, valid_until, status, provider_ref, revoked_reason, created_by, created_at) on access_credentials to authenticated;
create policy credentials_read on access_credentials for select to authenticated
  using (exists (select 1 from bookings b where b.id = booking_id and can_manage_property((select auth.uid()), b.property_id)));
create policy access_logs_read on access_logs for select to authenticated
  using (is_owner_or_manager((select auth.uid())) and (device_id is null or exists (select 1 from smart_lock_devices d where d.id = device_id and can_manage_property((select auth.uid()), d.property_id))));

-- Only a provider adapter (service role, no user session) may report device state.
create or replace function guard_device_state() returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and (new.status is distinct from old.status or new.last_seen_at is distinct from old.last_seen_at
      or new.battery_pct is distinct from old.battery_pct or new.external_id is distinct from old.external_id) then
    raise exception 'Device status comes from the lock provider and cannot be edited by hand' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger trg_guard_device_state before update on smart_lock_devices for each row execute function guard_device_state();

create or replace function log_access(p_action text, p_device uuid, p_cred uuid, p_booking uuid, p_actor uuid, p_detail text) returns void
language sql security definer set search_path = public as $$
  insert into access_logs(action, device_id, credential_id, booking_id, actor, detail) values (p_action, p_device, p_cred, p_booking, p_actor, p_detail)
$$;
revoke execute on function log_access(text, uuid, uuid, uuid, uuid, text) from public, anon, authenticated;

create or replace function trg_log_device() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform log_access(case tg_op when 'INSERT' then 'device_added' else 'device_changed' end, new.id, null, null, auth.uid(), new.label || ' (' || new.provider || ')');
  return null;
end $$;
create trigger trg_log_device after insert or update on smart_lock_devices for each row execute function trg_log_device();

-- Issue a temporary PIN for a stay. Returns the PIN ONCE; only a salted digest is kept.
create or replace function issue_access_credential(p_booking uuid, p_device uuid, p_valid_from timestamptz default null, p_valid_until timestamptz default null)
returns table(credential_id uuid, pin text, status text, message text)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := (select auth.uid()); b bookings; d smart_lock_devices; v_pin text; v_salt bytea; v_from timestamptz; v_until timestamptz; v_id uuid; v_status text;
begin
  perform require_permission('access.manage');
  select * into b from bookings where id = p_booking for update;
  if not found or not can_manage_property(v_uid, b.property_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into d from smart_lock_devices where id = p_device and active;
  if not found or d.property_id <> b.property_id then raise exception 'Choose a lock at this property.' using errcode = 'check_violation'; end if;
  if d.unit_id <> b.unit_id then raise exception 'That lock belongs to a different room than this booking.' using errcode = 'check_violation'; end if;
  if b.status not in ('confirmed','checked_in') then raise exception 'Access can only be issued for a confirmed or checked-in stay.' using errcode = 'check_violation'; end if;
  if b.amount_paid < b.deposit_required then raise exception 'The deposit has not been received, so access cannot be issued yet.' using errcode = 'check_violation'; end if;
  if exists (select 1 from access_credentials c where c.booking_id = b.id and c.device_id = d.id and c.status in ('pending','provisioned','manual') and c.valid_until > now()) then
    raise exception 'This stay already has active access for that lock. Revoke it first.' using errcode = 'check_violation';
  end if;
  v_from := coalesce(p_valid_from, (b.check_in::timestamp + time '12:00') at time zone 'Africa/Nairobi');
  v_until := coalesce(p_valid_until, (b.check_out::timestamp + time '12:00') at time zone 'Africa/Nairobi');
  if v_until <= v_from or v_until <= now() then raise exception 'The access window must end in the future and after it starts.' using errcode = 'check_violation'; end if;
  if v_until > (b.check_out::timestamp + interval '1 day') at time zone 'Africa/Nairobi' then raise exception 'Access cannot run more than a day past check-out.' using errcode = 'check_violation'; end if;

  v_pin := lpad((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint % 1000000)::text, 6, '0');
  v_salt := sha256(convert_to(gen_random_uuid()::text, 'utf8'));
  -- A manual device has no provider to confirm anything: the code is only recorded, and staff must set it on the lock themselves.
  v_status := case when d.provider = 'manual' then 'manual' else 'pending' end;
  insert into access_credentials(booking_id, device_id, pin_digest, salt, pin_hint, valid_from, valid_until, status, created_by)
    values (b.id, d.id, sha256(v_salt || convert_to(v_pin, 'utf8')), v_salt, right(v_pin, 2), v_from, v_until, v_status, v_uid) returning id into v_id;
  perform log_access('credential_issued', d.id, v_id, b.id, v_uid, 'valid ' || to_char(v_from at time zone 'Africa/Nairobi', 'DD Mon HH24:MI') || ' to ' || to_char(v_until at time zone 'Africa/Nairobi', 'DD Mon HH24:MI') || ', status ' || v_status);
  return query select v_id, v_pin, v_status,
    case v_status when 'manual' then 'Code generated. This lock is not connected, so set this code on the lock yourself; the system has not programmed it.'
                  else 'Code generated. It is waiting for the lock provider to confirm; it has not been programmed yet.' end;
end $$;
grant execute on function issue_access_credential(uuid, uuid, timestamptz, timestamptz) to authenticated;

create or replace function revoke_access_credential(p_credential uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); c access_credentials; b bookings;
begin
  perform require_permission('access.manage');
  select * into c from access_credentials where id = p_credential for update;
  if not found then raise exception 'Access code not found' using errcode = 'no_data_found'; end if;
  select * into b from bookings where id = c.booking_id;
  if not can_manage_property(v_uid, b.property_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if c.status in ('revoked','expired') then return; end if;
  if char_length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason.' using errcode = 'check_violation'; end if;
  update access_credentials set status = 'revoked', revoked_reason = trim(p_reason) where id = p_credential;
  perform log_access('credential_revoked', c.device_id, c.id, c.booking_id, v_uid, trim(p_reason) || case when c.status = 'provisioned' then ' (the lock must also be told to remove the code)' else '' end);
end $$;
grant execute on function revoke_access_credential(uuid, text) to authenticated;

-- Provider adapters (service role only) report what the lock actually did. Nothing else can mark a code as programmed.
create or replace function confirm_credential_provisioned(p_credential uuid, p_ok boolean, p_provider_ref text default null, p_detail text default null) returns void
language plpgsql security definer set search_path = public as $$
declare c access_credentials;
begin
  select * into c from access_credentials where id = p_credential for update;
  if not found then raise exception 'Access code not found' using errcode = 'no_data_found'; end if;
  update access_credentials set status = case when p_ok then 'provisioned' else 'failed' end, provider_ref = p_provider_ref where id = p_credential and status = 'pending';
  perform log_access(case when p_ok then 'provision_confirmed' else 'provision_failed' end, c.device_id, c.id, c.booking_id, null, p_detail);
end $$;
revoke execute on function confirm_credential_provisioned(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function confirm_credential_provisioned(uuid, boolean, text, text) to service_role;

create or replace function expire_access_credentials() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; r record;
begin
  for r in update access_credentials set status = 'expired' where status in ('pending','provisioned','manual') and valid_until <= now() returning id, device_id, booking_id loop
    perform log_access('credential_expired', r.device_id, r.id, r.booking_id, null, null);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function expire_access_credentials() from public, anon, authenticated;
grant execute on function expire_access_credentials() to service_role;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('expire-access-credentials', '*/15 * * * *', 'select public.expire_access_credentials()');
  end if;
exception when others then null;
end $$;

-- ---------------------------------------------------------------------------
-- More notification kinds
-- ---------------------------------------------------------------------------
alter table notifications drop constraint if exists notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in ('booking_request','request_update','inquiry','review','payment','payment_review','cancellation','checkin_soon','checkout_today','balance_due',
  'low_stock','maintenance','housekeeping','ticket','message_failed','payment_verify'));

create or replace function trg_notify_more() returns trigger language plpgsql security definer set search_path = public as $$
declare v_unit text;
begin
  if tg_table_name = 'maintenance_requests' and tg_op = 'INSERT' then
    perform add_notification('maintenance', 'Maintenance: ' || new.title, new.priority || ' priority', '/admin/maintenance', new.property_id, new.id);
  elsif tg_table_name = 'housekeeping_tasks' and tg_op = 'INSERT' then
    select name into v_unit from units where id = new.unit_id;
    perform add_notification('housekeeping', 'Room to clean: ' || coalesce(v_unit, ''), case when new.priority then 'Same-day turnover' else null end, '/admin/housekeeping', new.property_id, new.id);
  elsif tg_table_name = 'support_tickets' and tg_op = 'INSERT' then
    perform add_notification('ticket', 'Ticket #' || new.ticket_no || ': ' || new.subject, new.priority || ' priority', '/admin/support', new.property_id, new.id);
  elsif tg_table_name = 'message_log' and new.status = 'failed' and (tg_op = 'INSERT' or old.status is distinct from 'failed') then
    perform add_notification('message_failed', 'Message not delivered', left(coalesce(new.error, 'Delivery failed'), 140), '/admin/messages', new.property_id, new.id);
  elsif tg_table_name = 'payments' and new.status = 'succeeded' and not new.verified and tg_op = 'INSERT' then
    perform add_notification('payment_verify', 'Payment to verify: KES ' || to_char(new.amount, 'FM999,999,999'), new.method::text, '/admin/finance', (select property_id from bookings where id = new.booking_id), new.id);
  end if;
  return null;
end $$;
create trigger trg_notify_maint  after insert on maintenance_requests for each row execute function trg_notify_more();
create trigger trg_notify_hk     after insert on housekeeping_tasks   for each row execute function trg_notify_more();
create trigger trg_notify_ticket after insert on support_tickets      for each row execute function trg_notify_more();
create trigger trg_notify_msg    after insert or update on message_log for each row execute function trg_notify_more();
create trigger trg_notify_verify after insert on payments             for each row execute function trg_notify_more();

$m0019$;
    raise notice 'Applied 0019';
  else
    raise notice '0019 already applied, skipped';
  end if;
  if to_regclass('public.permissions_catalog') is null then
    execute $m0020$
-- 0020_roles_permissions_login_cms.sql
-- 1. Team roles with granular permissions, enforced in the database:
--      * has_permission / require_permission, used inside the sensitive functions and as RESTRICTIVE row-level policies;
--      * nine system roles (Super Administrator, Property Owner, Property Manager, Receptionist, Booking Manager, Accountant,
--        Housekeeping, Maintenance Staff, Marketing Manager) and custom roles built from the permission catalogue;
--      * every role maps to a base role (owner / manager / cleaner) so the existing property-scoped policies keep working;
--      * a user without a team role gets the default for their base role, so nothing changes for existing staff.
-- 2. Login events (including failed attempts), recorded without exposing passwords.
-- 3. Website content drafts and published versions.

create table permissions_catalog (
  key text primary key check (key ~ '^[a-z_]+\.[a-z_]+$'),
  module text not null,
  label text not null,
  sort int not null default 0
);
insert into permissions_catalog(key, module, label, sort) values
  ('dashboard.view','Dashboard','View the dashboard',1),
  ('bookings.view','Bookings','View reservations',10), ('bookings.create','Bookings','Create bookings',11), ('bookings.manage','Bookings','Modify, reschedule and cancel bookings',12),
  ('requests.manage','Bookings','Approve or reject booking requests',13), ('inquiries.manage','Bookings','Handle guest inquiries',14),
  ('checkin.manage','Front desk','Check guests in and out',20), ('blocked.manage','Front desk','Block and release dates',21), ('rooms.manage','Front desk','Update room status',22),
  ('guests.view','Guests','View guest profiles',30), ('guests.manage','Guests','Edit guest profiles',31), ('credit.manage','Guests','Manage guest credit',32),
  ('housekeeping.view','Housekeeping','View assigned rooms and cleaning tasks',40), ('housekeeping.update','Housekeeping','Update cleaning status',41), ('housekeeping.manage','Housekeeping','Create, assign and verify cleaning tasks',42),
  ('maintenance.report','Maintenance','Report maintenance issues',50), ('maintenance.update','Maintenance','Update assigned maintenance work',51), ('maintenance.manage','Maintenance','Assign and close maintenance requests',52),
  ('listings.manage','Listings','Create and edit properties, rooms and prices',60), ('media.manage','Website','Manage the media library, gallery and banners',61),
  ('cms.manage','Website','Edit and publish website content, reviews and announcements',62), ('marketing.manage','Website','Manage discount codes and campaigns',63),
  ('support.manage','Support','Handle support tickets',70),
  ('finance.view','Finance','View payments and financial figures',80), ('payments.record','Finance','Record payments and refunds',81), ('payments.verify','Finance','Verify payments',82),
  ('expenses.manage','Finance','Enter and edit expenses',83), ('expenses.approve','Finance','Approve expenses',84),
  ('reports.view','Reports','View and export reports',90), ('owner.overview','Reports','Open the owner overview',91),
  ('bar.manage','Services','Manage the bar menu and stock',100), ('access.manage','Services','Issue and revoke smart access codes',101), ('comms.manage','Services','Send and manage guest messages',102),
  ('users.manage','System','Manage staff accounts',110), ('roles.manage','System','Manage team roles and permissions',111), ('settings.manage','System','Change site settings',112), ('audit.view','System','View the activity log',113);

create table team_roles (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 3 and 40),
  description text check (description is null or char_length(description) <= 200),
  base_role app_role not null,
  is_system boolean not null default false,
  default_for app_role,                              -- the role given to staff who have no team role yet
  created_at timestamptz not null default now(),
  check (is_system or base_role <> 'owner')         -- only the built-in Super Administrator has owner-level database access
);
create unique index team_roles_name_uniq on team_roles (lower(name));
create unique index team_roles_default_uniq on team_roles (default_for) where default_for is not null;
create table team_role_permissions (
  role_id uuid not null references team_roles on delete cascade,
  permission_key text not null references permissions_catalog on delete cascade,
  primary key (role_id, permission_key)
);
alter table profiles add column team_role_id uuid references team_roles on delete restrict;
create index on profiles (team_role_id) where team_role_id is not null;

do $seed$
declare r record; v_id uuid;
begin
  for r in select * from (values
    ('Super Administrator','Full access to everything.','owner'::app_role,null::app_role, array['*']),
    ('Property Owner','Business overview, finance and performance for their properties, without day-to-day editing.','manager',null, array['dashboard.view','bookings.view','guests.view','finance.view','reports.view','owner.overview','housekeeping.view']),
    ('Property Manager','Runs day-to-day operations: bookings, guests, rooms, housekeeping, maintenance, listings and operational reports.','manager','manager',
       array['dashboard.view','bookings.view','bookings.create','bookings.manage','requests.manage','inquiries.manage','checkin.manage','blocked.manage','rooms.manage','guests.view','guests.manage','credit.manage','housekeeping.view','housekeeping.update','housekeeping.manage','maintenance.report','maintenance.update','maintenance.manage','listings.manage','media.manage','cms.manage','marketing.manage','support.manage','finance.view','payments.record','expenses.manage','reports.view','bar.manage','access.manage','comms.manage']),
    ('Receptionist','Reservations, check-in and check-out, guest inquiries and taking payments at the desk.','manager',null,
       array['dashboard.view','bookings.view','bookings.create','inquiries.manage','requests.manage','checkin.manage','guests.view','guests.manage','payments.record','housekeeping.view','maintenance.report','comms.manage']),
    ('Booking Manager','Owns reservations, requests, inquiries, blocked dates and guest records.','manager',null,
       array['dashboard.view','bookings.view','bookings.create','bookings.manage','requests.manage','inquiries.manage','checkin.manage','blocked.manage','rooms.manage','guests.view','guests.manage','credit.manage','payments.record','reports.view','comms.manage']),
    ('Accountant','Financial reports, recording and verifying payments, expenses and reconciliation.','manager',null,
       array['dashboard.view','bookings.view','guests.view','finance.view','payments.record','payments.verify','expenses.manage','expenses.approve','reports.view']),
    ('Housekeeping','Sees assigned rooms and cleaning tasks, updates cleaning status and reports issues.','cleaner','cleaner',
       array['housekeeping.view','housekeeping.update','maintenance.report','maintenance.update']),
    ('Maintenance Staff','Reports and works on maintenance requests assigned to them.','cleaner',null,
       array['housekeeping.view','maintenance.report','maintenance.update']),
    ('Marketing Manager','Website content, media, reviews, promotions and listing text.','manager',null,
       array['dashboard.view','bookings.view','media.manage','cms.manage','marketing.manage','reports.view','comms.manage'])
  ) as t(name, descr, base, def, perms) loop
    insert into team_roles(name, description, base_role, is_system, default_for) values (r.name, r.descr, r.base, true, r.def) returning id into v_id;
    if r.perms = array['*'] then
      insert into team_role_permissions(role_id, permission_key) select v_id, key from permissions_catalog;
    else
      insert into team_role_permissions(role_id, permission_key) select v_id, unnest(r.perms);
    end if;
  end loop;
end $seed$;

-- ---- checks used everywhere ---------------------------------------------------------------------------------------
create or replace function has_permission(_uid uuid, _perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when _uid is null then false
    when not exists (select 1 from profiles p where p.id = _uid and p.active) then false
    when has_role(_uid, 'owner') then true
    else exists (
      select 1 from team_role_permissions rp
      where rp.permission_key = _perm
        and rp.role_id = coalesce(
          (select p.team_role_id from profiles p where p.id = _uid),
          (select tr.id from team_roles tr where tr.default_for = case when has_role(_uid, 'manager') then 'manager'::app_role when has_role(_uid, 'cleaner') then 'cleaner'::app_role end)))
  end
$$;
grant execute on function has_permission(uuid, text) to authenticated;

create or replace function require_permission(_perm text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_permission((select auth.uid()), _perm) then
    raise exception 'You do not have permission to do this.' using errcode = '42501';
  end if;
end $$;
grant execute on function require_permission(text) to authenticated;

-- What can the signed-in person do? (drives the menu; the database still enforces every action)
create or replace function my_permissions() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(c.key order by c.key), '{}') from permissions_catalog c where has_permission((select auth.uid()), c.key)
$$;
grant execute on function my_permissions() to authenticated;

-- ---- tables: RLS --------------------------------------------------------------------------------------------------
alter table permissions_catalog enable row level security;
alter table team_roles enable row level security;
alter table team_role_permissions enable row level security;
revoke all on permissions_catalog, team_roles, team_role_permissions from anon;
create policy catalog_read on permissions_catalog for select to authenticated using (is_staff((select auth.uid())));
create policy roles_read on team_roles for select to authenticated using (is_staff((select auth.uid())));
create policy role_perms_read on team_role_permissions for select to authenticated using (is_staff((select auth.uid())));
create policy roles_write on team_roles for all to authenticated
  using (has_permission((select auth.uid()), 'roles.manage')) with check (has_permission((select auth.uid()), 'roles.manage'));
create policy role_perms_write on team_role_permissions for all to authenticated
  using (has_permission((select auth.uid()), 'roles.manage')) with check (has_permission((select auth.uid()), 'roles.manage'));
create trigger trg_audit_team_role  after insert or update or delete on team_roles for each row execute function audit_generic('team_role');
create trigger trg_audit_role_perm  after insert or delete on team_role_permissions for each row execute function audit_generic('team_role_permission');

-- Built-in roles cannot be edited or deleted (clone one to customise it). The audit trigger above records every change.
create or replace function guard_system_roles() returns trigger language plpgsql as $$
declare v_role uuid;
begin
  if tg_table_name = 'team_roles' then
    if tg_op = 'DELETE' then v_role := old.id; else v_role := new.id; end if;
  else
    if tg_op = 'DELETE' then v_role := old.role_id; else v_role := new.role_id; end if;
  end if;
  if auth.uid() is not null and exists (select 1 from team_roles r where r.id = v_role and r.is_system) then
    raise exception 'Built-in roles cannot be changed. Create a custom role instead.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger trg_guard_roles before update or delete on team_roles for each row execute function guard_system_roles();
create trigger trg_guard_role_perms before insert or delete on team_role_permissions for each row execute function guard_system_roles();

-- Assign a team role. Keeps the base role (which the existing policies read) in step, protects the last owner.
create or replace function assign_team_role(p_user uuid, p_role uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); r team_roles; v_owners int;
begin
  if not has_permission(v_uid, 'users.manage') then raise exception 'You do not have permission to do this.' using errcode = '42501'; end if;
  select * into r from team_roles where id = p_role;
  if not found then raise exception 'Role not found' using errcode = 'no_data_found'; end if;
  if p_user = v_uid then raise exception 'You cannot change your own role.' using errcode = 'check_violation'; end if;
  if r.base_role = 'owner' and not has_role(v_uid, 'owner') then raise exception 'Only an owner can make another owner.' using errcode = '42501'; end if;
  if has_role(p_user, 'owner') and r.base_role <> 'owner' then
    select count(*) into v_owners from user_roles ur join profiles p on p.id = ur.user_id where ur.role = 'owner' and p.active;
    if v_owners <= 1 then raise exception 'There must always be at least one owner.' using errcode = 'check_violation'; end if;
  end if;
  update profiles set team_role_id = p_role where id = p_user;
  if not found then raise exception 'User not found' using errcode = 'no_data_found'; end if;
  delete from user_roles where user_id = p_user;
  insert into user_roles(user_id, role) values (p_user, r.base_role);
  insert into audit_log(user_id, action, entity, entity_id, diff) values (v_uid, 'staff.role_assigned', 'staff', p_user::text, jsonb_build_object('role', r.name, 'base', r.base_role));
end $$;
grant execute on function assign_team_role(uuid, uuid) to authenticated;

-- ---- restrictive policies: a permission is required IN ADDITION to the existing property-scoped access ------------
do $pol$
declare r record; v_expr text; v_name text;
begin
  for r in select * from (values
    ('payments','insert', array['payments.record']), ('payments','select', array['finance.view','bookings.view','checkin.manage']),
    ('expenses','select', array['finance.view']), ('expenses','insert', array['expenses.manage']), ('expenses','update', array['expenses.manage','expenses.approve']),
    ('bookings','insert', array['bookings.create']), ('bookings','update', array['bookings.manage']),
    ('guests','update', array['guests.manage']),
    ('housekeeping_tasks','insert', array['housekeeping.manage']), ('housekeeping_tasks','delete', array['housekeeping.manage']), ('housekeeping_tasks','update', array['housekeeping.update','housekeeping.manage']),
    ('properties','insert', array['listings.manage']), ('properties','update', array['listings.manage']), ('properties','delete', array['listings.manage']),
    ('units','insert', array['listings.manage','rooms.manage']), ('units','update', array['listings.manage','rooms.manage']), ('units','delete', array['listings.manage']),
    ('rate_overrides','insert', array['listings.manage']), ('rate_overrides','update', array['listings.manage']), ('rate_overrides','delete', array['listings.manage']),
    ('inquiries','insert', array['inquiries.manage']), ('inquiries','update', array['inquiries.manage']), ('inquiries','delete', array['inquiries.manage']),
    ('inquiry_notes','insert', array['inquiries.manage']), ('inquiry_notes','update', array['inquiries.manage']), ('inquiry_notes','delete', array['inquiries.manage']),
    ('reviews','insert', array['cms.manage']), ('reviews','update', array['cms.manage']), ('reviews','delete', array['cms.manage']),
    ('announcements','insert', array['cms.manage']), ('announcements','update', array['cms.manage']), ('announcements','delete', array['cms.manage']),
    ('gallery_categories','insert', array['media.manage']), ('gallery_categories','update', array['media.manage']), ('gallery_categories','delete', array['media.manage']),
    ('gallery_items','insert', array['media.manage']), ('gallery_items','update', array['media.manage']), ('gallery_items','delete', array['media.manage']),
    ('homepage_banners','insert', array['media.manage']), ('homepage_banners','update', array['media.manage']), ('homepage_banners','delete', array['media.manage']),
    ('media_assets','insert', array['media.manage']), ('media_assets','update', array['media.manage']), ('media_assets','delete', array['media.manage']),
    ('discount_codes','insert', array['marketing.manage']), ('discount_codes','update', array['marketing.manage']), ('discount_codes','delete', array['marketing.manage']),
    ('support_tickets','insert', array['support.manage']), ('support_tickets','update', array['support.manage']), ('support_tickets','delete', array['support.manage']),
    ('support_ticket_messages','insert', array['support.manage']),
    ('maintenance_requests','insert', array['maintenance.report','maintenance.manage']), ('maintenance_requests','update', array['maintenance.manage','maintenance.update']), ('maintenance_requests','delete', array['maintenance.manage']),
    ('booking_requests','update', array['requests.manage']), ('booking_request_notes','insert', array['requests.manage']),
    ('bar_categories','insert', array['bar.manage']), ('bar_categories','update', array['bar.manage']), ('bar_categories','delete', array['bar.manage']),
    ('bar_products','insert', array['bar.manage']), ('bar_products','update', array['bar.manage']), ('bar_products','delete', array['bar.manage']),
    ('guest_credit_entries','select', array['credit.manage','finance.view','guests.view'])
  ) as t(tbl, cmd, perms) loop
    continue when to_regclass('public.' || r.tbl) is null;
    select string_agg(format('has_permission((select auth.uid()), %L)', p), ' or ') into v_expr from unnest(r.perms) p;
    v_name := 'perm_' || r.tbl || '_' || r.cmd;
    if r.cmd = 'insert' then
      execute format('create policy %I on %I as restrictive for insert to authenticated with check (%s)', v_name, r.tbl, v_expr);
    elsif r.cmd = 'update' then
      execute format('create policy %I on %I as restrictive for update to authenticated using (%s) with check (%s)', v_name, r.tbl, v_expr, v_expr);
    else
      execute format('create policy %I on %I as restrictive for %s to authenticated using (%s)', v_name, r.tbl, r.cmd, v_expr);
    end if;
  end loop;
end $pol$;

-- ---------------------------------------------------------------------------
-- Login events
-- ---------------------------------------------------------------------------
create table login_events (
  id bigint generated always as identity primary key,
  user_id uuid references profiles on delete set null,
  email text not null check (char_length(email) <= 160),
  success boolean not null,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index on login_events (created_at desc);
create index on login_events (email, created_at desc);
alter table login_events enable row level security;
revoke all on login_events from anon;
revoke insert, update, delete on login_events from authenticated;
create policy login_events_read on login_events for select to authenticated using (has_permission((select auth.uid()), 'audit.view'));

-- Called by the login page. A failed attempt comes from an anonymous browser, so it is throttled; a success is tied to the real session user.
create or replace function record_login_event(p_email text, p_success boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := (select auth.uid()); v_email text := lower(left(trim(coalesce(p_email, '')), 160)); n int; v_h json;
begin
  if v_email = '' then return; end if;
  if p_success and v_uid is null then return; end if;                      -- cannot claim a success without a session
  select count(*) into n from rate_limit_events where key = 'login:' || v_email and created_at > now() - interval '1 hour';
  if n >= 30 then return; end if;
  select count(*) into n from rate_limit_events where key = 'login:all' and created_at > now() - interval '1 hour';
  if n >= 600 then return; end if;
  insert into rate_limit_events(key) values ('login:' || v_email), ('login:all');
  begin v_h := current_setting('request.headers', true)::json; exception when others then v_h := null; end;
  insert into login_events(user_id, email, success, ip, user_agent)
    values (case when p_success then v_uid end, v_email, p_success, left(split_part(coalesce(v_h->>'x-forwarded-for', ''), ',', 1), 64), left(v_h->>'user-agent', 200));
end $$;
grant execute on function record_login_event(text, boolean) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Website content: drafts, published versions
-- ---------------------------------------------------------------------------
create table site_content_versions (
  id uuid primary key default gen_random_uuid(),
  content jsonb not null,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  note text check (note is null or char_length(note) <= 200),
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  check (jsonb_typeof(content) = 'object' and pg_column_size(content) < 200000)
);
create index on site_content_versions (created_at desc);
alter table site_content_versions enable row level security;
revoke all on site_content_versions from anon;
revoke update, delete on site_content_versions from authenticated;
create policy scv_read on site_content_versions for select to authenticated using (has_permission((select auth.uid()), 'cms.manage'));
create policy scv_insert on site_content_versions for insert to authenticated
  with check (has_permission((select auth.uid()), 'cms.manage') and status = 'draft' and created_by = (select auth.uid()));

-- Publishing copies a version into the live setting. Only this function can do that (the settings table stays owner-only).
create or replace function publish_site_content(p_version uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); v site_content_versions;
begin
  if not has_permission(v_uid, 'cms.manage') then raise exception 'You do not have permission to do this.' using errcode = '42501'; end if;
  select * into v from site_content_versions where id = p_version for update;
  if not found then raise exception 'Version not found' using errcode = 'no_data_found'; end if;
  update site_content_versions set status = 'archived' where status = 'published';
  update site_content_versions set status = 'published', published_at = now() where id = p_version;
  insert into settings(key, value, updated_at) values ('site_content', v.content, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  insert into audit_log(user_id, action, entity, entity_id) values (v_uid, 'site_content.published', 'site_content', p_version::text);
end $$;
grant execute on function publish_site_content(uuid) to authenticated;

-- The activity log can be shared with anyone given the "View the activity log" permission (the owner always has it).
create policy audit_perm_read on audit_log for select to authenticated using (has_permission((select auth.uid()), 'audit.view'));

$m0020$;
    raise notice 'Applied 0020';
  else
    raise notice '0020 already applied, skipped';
  end if;
end
$apply$;
