-- apply_pending.sql: paste into the Supabase SQL Editor of project "bnb-system" (ref bxpgpzrtoxjmynyjnfkg) and press Run.
-- PART 1 of 10: migrations 0009 to 0011. Run the parts in order.
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
end
$apply$;
