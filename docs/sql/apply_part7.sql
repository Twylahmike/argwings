-- apply_pending.sql: paste into the Supabase SQL Editor of project "bnb-system" (ref bxpgpzrtoxjmynyjnfkg) and press Run.
-- PART 7 of 11: migrations 0029 to 0029. Run the parts in order.
-- Stops without changes if this is the wrong project or migration 0008 is missing.
do $apply$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'STOP: this is not the RG Wings project (no bookings table). Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='units' and column_name='maintenance_status') then
    raise exception 'STOP: apply migration 0008 first. Nothing was changed.';
  end if;
  if to_regclass('public.membership_tiers') is null then
    execute $m0029$
-- 0029_customer_membership.sql
-- Customer accounts, membership tiers, member offers, rewards and loyalty, joined to the existing booking engine.
--
-- Design:
--  * Customers are ordinary Supabase Auth users. They have NO row in `profiles` / `user_roles`, so they can never act as staff.
--    Staff checks (has_role, has_permission, can_manage_property) all start from `profiles`, which customers never have.
--  * A customer profile only exists after the email is verified (ensure_customer_profile reads auth.users.email_confirmed_at).
--  * Customers never touch these tables directly for writes. Every change goes through a security-definer function that
--    works from auth.uid(), so a customer can only ever read or change their own records.
--  * Offers are validated in the database when the booking is created. The browser's idea of the discount is never trusted.
--  * A redeemed reward is tied to one booking. If that booking is cancelled, expires or is a no-show, the reward is released.
--  * Tiers are earned from the owner's configured criteria (completed stays, spend), or set by hand by staff.

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
insert into permissions_catalog(key, module, label, sort) values
  ('customers.view','Customers','View customer accounts, membership and activity',120),
  ('customers.manage','Customers','Suspend accounts, set tiers and adjust loyalty points',121),
  ('offers.manage','Customers','Create and manage member offers and the welcome offer',122);
do $perm$
declare v_id uuid;
begin
  for v_id in select id from team_roles where name = 'Super Administrator' loop
    insert into team_role_permissions(role_id, permission_key) values (v_id,'customers.view'),(v_id,'customers.manage'),(v_id,'offers.manage') on conflict do nothing;
  end loop;
  insert into team_role_permissions(role_id, permission_key) select id, k from team_roles, unnest(array['customers.view','customers.manage','offers.manage']) k where name = 'Property Manager' on conflict do nothing;
  insert into team_role_permissions(role_id, permission_key) select id, k from team_roles, unnest(array['customers.view','offers.manage']) k where name = 'Marketing Manager' on conflict do nothing;
  insert into team_role_permissions(role_id, permission_key) select id, 'customers.view' from team_roles where name in ('Receptionist','Booking Manager') on conflict do nothing;
end $perm$;

-- ---------------------------------------------------------------------------
-- Settings made public: whether guests may still book without an account
-- ---------------------------------------------------------------------------
insert into settings(key, value) values ('guest_checkout_enabled', 'true'), ('loyalty_kes_per_point', '100') on conflict (key) do nothing;
drop policy if exists settings_public_read on settings;
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes',
                 'mpesa_manual_instructions','mpesa_paybill_display','brand_color','site_content','booking_mode',
                 'business_email','business_address','currency','maintenance_mode','guest_checkout_enabled'));

-- ---------------------------------------------------------------------------
-- Membership tiers (owner-configurable)
-- ---------------------------------------------------------------------------
create table membership_tiers (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,20}$'),
  name text not null check (char_length(trim(name)) between 2 and 40),
  rank int not null unique check (rank >= 0),
  min_completed_stays int not null default 0 check (min_completed_stays >= 0),
  min_spend int not null default 0 check (min_spend >= 0),         -- KES paid across completed stays
  expiry_months int check (expiry_months is null or expiry_months between 1 and 120),   -- null = never expires
  benefits text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_tiers_updated before update on membership_tiers for each row execute function set_updated_at();
insert into membership_tiers(key, name, rank, min_completed_stays, min_spend, expiry_months, benefits) values
  ('standard','Standard Member',0,0,0,null,array['Welcome discount','Member-exclusive offers','Booking history']),
  ('silver','Silver Member',1,3,60000,24,array['Additional discounts','Priority access to promotions']),
  ('gold','Gold Member',2,6,150000,24,array['Enhanced discounts','Selected complimentary benefits']),
  ('vip','VIP Member',3,12,350000,24,array['Premium offers','Priority booking assistance','Special guest privileges']);

-- ---------------------------------------------------------------------------
-- Customer profiles
-- ---------------------------------------------------------------------------
create table customer_profiles (
  user_id uuid primary key references auth.users on delete cascade,
  full_name text not null check (char_length(trim(full_name)) between 2 and 80),
  email text not null check (email = lower(email)),
  phone text check (phone is null or phone ~ '^254[17][0-9]{8}$'),
  country text check (country is null or char_length(country) <= 60),
  birthday date check (birthday is null or birthday between date '1900-01-01' and current_date),
  guest_id uuid unique references guests on delete set null,        -- the booking-side guest record, linked on first booking
  status text not null default 'active' check (status in ('active','suspended')),
  suspended_reason text,
  tier_key text not null default 'standard' references membership_tiers,
  tier_override boolean not null default false,                      -- set by hand: criteria no longer change it
  tier_expires_at timestamptz,
  marketing_opt_in boolean not null default true,
  verified_at timestamptz not null default now(),
  welcome_emailed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index customer_profiles_email_uniq on customer_profiles (email);
create index on customer_profiles (tier_key);
create trigger trg_customer_profiles_updated before update on customer_profiles for each row execute function set_updated_at();

alter table bookings add column customer_id uuid references customer_profiles(user_id) on delete set null;
create index on bookings (customer_id) where customer_id is not null;

create table customer_activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references customer_profiles(user_id) on delete cascade,
  kind text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index on customer_activity (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Offers, rewards, redemptions, loyalty
-- ---------------------------------------------------------------------------
create table promotional_offers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 3 and 80),
  description text check (description is null or char_length(description) <= 300),
  terms text check (terms is null or char_length(terms) <= 1000),
  -- how it reaches a customer: welcome (issued on verification), birthday (issued on the day), member (offered to every eligible member)
  audience text not null check (audience in ('welcome','birthday','member')),
  kind text not null check (kind in ('percent','fixed')),
  value int not null check (value > 0),
  max_discount int check (max_discount is null or max_discount > 0),
  min_total int not null default 0 check (min_total >= 0),         -- minimum room total (KES)
  property_ids uuid[] not null default '{}',                        -- empty = every accommodation
  min_tier_key text references membership_tiers,
  first_booking_only boolean not null default false,
  returning_only boolean not null default false,
  valid_from date,
  valid_to date,
  valid_days int check (valid_days is null or valid_days between 1 and 730),   -- how long an issued reward lasts
  max_redemptions int check (max_redemptions is null or max_redemptions >= 1),
  per_customer_limit int not null default 1 check (per_customer_limit >= 1),
  stackable boolean not null default false,                         -- may be combined with a discount code
  active boolean not null default true,
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'percent' or value <= 100),
  check (valid_to is null or valid_from is null or valid_to >= valid_from),
  check (not (first_booking_only and returning_only))
);
create trigger trg_offers_updated before update on promotional_offers for each row execute function set_updated_at();

create table customer_rewards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references customer_profiles(user_id) on delete cascade,
  offer_id uuid not null references promotional_offers on delete restrict,
  code text not null unique,
  status text not null default 'available' check (status in ('available','redeemed','expired','void')),
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  booking_id uuid references bookings on delete set null,
  note text,
  emailed_at timestamptz                                 -- when the "your offer is ready" email was accepted by the email provider
);
create index on customer_rewards (user_id, status);
create index on customer_rewards (offer_id);

create table reward_redemptions (
  id uuid primary key default gen_random_uuid(),
  reward_id uuid not null references customer_rewards on delete restrict,
  user_id uuid not null references customer_profiles(user_id) on delete cascade,
  offer_id uuid not null references promotional_offers on delete restrict,
  booking_id uuid not null references bookings on delete cascade,
  amount int not null check (amount > 0),
  created_at timestamptz not null default now(),
  released_at timestamptz                       -- set when the booking was cancelled or expired and the reward went back
);
-- One live redemption per booking and per reward: the discount can never be applied twice to the same booking.
create unique index reward_redemptions_booking_uniq on reward_redemptions (booking_id) where released_at is null;
create unique index reward_redemptions_reward_uniq on reward_redemptions (reward_id) where released_at is null;
create index on reward_redemptions (user_id);
create index on reward_redemptions (offer_id);

create table loyalty_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references customer_profiles(user_id) on delete cascade,
  kind text not null check (kind in ('earn','adjust','reverse')),
  points int not null check (points <> 0),
  booking_id uuid references bookings on delete set null,
  note text,
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now()
);
create index on loyalty_transactions (user_id, created_at desc);
-- A stay earns points once.
create unique index loyalty_earn_once on loyalty_transactions (booking_id) where kind = 'earn';

-- Customer requests to change or cancel a booking. Staff decide; nothing is changed automatically.
create table customer_booking_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references customer_profiles(user_id) on delete cascade,
  booking_id uuid not null references bookings on delete cascade,
  kind text not null check (kind in ('cancellation','modification')),
  message text not null check (char_length(trim(message)) between 3 and 1000),
  new_check_in date,
  new_check_out date,
  status text not null default 'open' check (status in ('open','done','declined')),
  staff_note text,
  resolved_by uuid references profiles on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  check ((new_check_in is null) = (new_check_out is null)),
  check (new_check_out is null or new_check_out > new_check_in)
);
create unique index customer_requests_one_open on customer_booking_requests (booking_id, kind) where status = 'open';

alter table notifications drop constraint if exists notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in ('booking_request','request_update','inquiry','review','payment','payment_review','cancellation','checkin_soon','checkout_today','balance_due',
  'low_stock','maintenance','housekeeping','ticket','message_failed','payment_verify','customer_request'));

-- ---------------------------------------------------------------------------
-- Row level security: customers read only their own rows; staff read by permission; nobody writes directly
-- ---------------------------------------------------------------------------
alter table membership_tiers enable row level security;
alter table customer_profiles enable row level security;
alter table customer_activity enable row level security;
alter table promotional_offers enable row level security;
alter table customer_rewards enable row level security;
alter table reward_redemptions enable row level security;
alter table loyalty_transactions enable row level security;
alter table customer_booking_requests enable row level security;
revoke all on customer_profiles, customer_activity, promotional_offers, customer_rewards, reward_redemptions, loyalty_transactions, customer_booking_requests from anon;
revoke insert, update, delete on customer_profiles, customer_activity, customer_rewards, reward_redemptions, loyalty_transactions, customer_booking_requests from authenticated;
revoke all on membership_tiers from anon;
grant select on membership_tiers to anon;

create policy tiers_read on membership_tiers for select to anon, authenticated using (active);
create policy tiers_staff_all on membership_tiers for all to authenticated
  using (has_permission((select auth.uid()), 'customers.manage')) with check (has_permission((select auth.uid()), 'customers.manage'));
create policy tiers_staff_read_all on membership_tiers for select to authenticated using (has_permission((select auth.uid()), 'customers.view'));

create policy cp_own_read on customer_profiles for select to authenticated using (user_id = (select auth.uid()));
create policy cp_staff_read on customer_profiles for select to authenticated using (has_permission((select auth.uid()), 'customers.view'));
create policy ca_staff_read on customer_activity for select to authenticated using (has_permission((select auth.uid()), 'customers.view'));
create policy ca_own_read on customer_activity for select to authenticated using (user_id = (select auth.uid()));
create policy offers_staff_all on promotional_offers for all to authenticated
  using (has_permission((select auth.uid()), 'offers.manage')) with check (has_permission((select auth.uid()), 'offers.manage'));
create policy offers_staff_read on promotional_offers for select to authenticated using (has_permission((select auth.uid()), 'customers.view'));
create policy rewards_own_read on customer_rewards for select to authenticated using (user_id = (select auth.uid()));
create policy rewards_staff_read on customer_rewards for select to authenticated using (has_permission((select auth.uid()), 'customers.view'));
create policy redemptions_own_read on reward_redemptions for select to authenticated using (user_id = (select auth.uid()));
create policy redemptions_staff_read on reward_redemptions for select to authenticated using (has_permission((select auth.uid()), 'customers.view'));
create policy loyalty_own_read on loyalty_transactions for select to authenticated using (user_id = (select auth.uid()));
create policy loyalty_staff_read on loyalty_transactions for select to authenticated using (has_permission((select auth.uid()), 'customers.view'));
create policy creq_own_read on customer_booking_requests for select to authenticated using (user_id = (select auth.uid()));
create policy creq_staff_read on customer_booking_requests for select to authenticated using (has_permission((select auth.uid()), 'bookings.view'));

create trigger trg_audit_offer after insert or update or delete on promotional_offers for each row execute function audit_generic('promotional_offer');
create trigger trg_audit_tier after insert or update or delete on membership_tiers for each row execute function audit_generic('membership_tier');
create trigger trg_audit_customer after update on customer_profiles for each row execute function audit_generic('customer');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function log_customer_activity(p_user uuid, p_kind text, p_detail text default null) returns void
language sql security definer set search_path = public as $$
  insert into customer_activity(user_id, kind, detail) values (p_user, p_kind, p_detail)
$$;
revoke execute on function log_customer_activity(uuid, text, text) from public, anon, authenticated;

create or replace function new_reward_code() returns text
language plpgsql volatile set search_path = public as $$
declare v text;
begin
  loop
    v := 'RGW-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    exit when not exists (select 1 from customer_rewards where code = v);
  end loop;
  return v;
end $$;
revoke execute on function new_reward_code() from public, anon, authenticated;

-- Issue one reward from an offer to a customer, unless they already hold as many as the per-customer limit allows.
create or replace function issue_reward(p_user uuid, p_offer uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare o promotional_offers; v_id uuid; v_exp timestamptz;
begin
  select * into o from promotional_offers where id = p_offer and active;
  if o.id is null then return null; end if;
  if o.valid_to is not null and nairobi_today() > o.valid_to then return null; end if;
  if (select count(*) from customer_rewards where user_id = p_user and offer_id = o.id and status <> 'void') >= o.per_customer_limit then return null; end if;
  v_exp := case when o.valid_days is not null then now() + make_interval(days => o.valid_days) else null end;
  if o.valid_to is not null and (v_exp is null or v_exp > (o.valid_to + 1)::timestamptz) then v_exp := (o.valid_to + 1)::timestamptz; end if;
  insert into customer_rewards(user_id, offer_id, code, expires_at, note) values (p_user, o.id, new_reward_code(), v_exp, p_note) returning id into v_id;
  perform log_customer_activity(p_user, 'reward_issued', o.name);
  return v_id;
end $$;
revoke execute on function issue_reward(uuid, uuid, text) from public, anon, authenticated;

-- Work out the tier a customer has earned. Hand-set tiers are left alone.
create or replace function refresh_customer_tier(p_user uuid) returns text
language plpgsql security definer set search_path = public as $$
declare cp customer_profiles; t membership_tiers;
begin
  select * into cp from customer_profiles where user_id = p_user for update;
  if cp.user_id is null or cp.tier_override then return cp.tier_key; end if;
  -- A tier counts the stays completed inside its own window (its expiry period), or all stays when it never expires.
  select mt.* into t from membership_tiers mt
    where mt.active
      and (select count(*) from bookings b where b.customer_id = p_user and b.status = 'checked_out'
             and (mt.expiry_months is null or b.check_out >= nairobi_today() - make_interval(months => mt.expiry_months))) >= mt.min_completed_stays
      and (select coalesce(sum(b.amount_paid), 0) from bookings b where b.customer_id = p_user and b.status = 'checked_out'
             and (mt.expiry_months is null or b.check_out >= nairobi_today() - make_interval(months => mt.expiry_months))) >= mt.min_spend
    order by mt.rank desc limit 1;
  if t.key is null then select * into t from membership_tiers where key = 'standard'; end if;
  if t.key is distinct from cp.tier_key or cp.tier_expires_at is null or cp.tier_expires_at < now() then
    update customer_profiles set tier_key = t.key,
      tier_expires_at = case when t.expiry_months is null then null else now() + make_interval(months => t.expiry_months) end
      where user_id = p_user;
    if t.key is distinct from cp.tier_key then
      perform log_customer_activity(p_user, 'tier_changed', cp.tier_key || ' -> ' || t.key);
    end if;
  end if;
  return t.key;
end $$;
revoke execute on function refresh_customer_tier(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Activation: called by the signed-in customer after verifying their email
-- ---------------------------------------------------------------------------
create or replace function ensure_customer_profile() returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare v_uid uuid := (select auth.uid()); u record; cp customer_profiles; v_name text; v_new boolean := false; o record; v_issued int := 0;
begin
  if v_uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if exists (select 1 from profiles where id = v_uid) then return jsonb_build_object('status', 'staff'); end if;
  select id, lower(email) as email, email_confirmed_at, raw_user_meta_data into u from auth.users where id = v_uid;
  if u.id is null then raise exception 'Account not found.' using errcode = '42501'; end if;
  if u.email_confirmed_at is null then return jsonb_build_object('status', 'unverified'); end if;
  select * into cp from customer_profiles where user_id = v_uid;
  if cp.user_id is null then
    v_name := left(trim(coalesce(u.raw_user_meta_data ->> 'full_name', split_part(u.email, '@', 1))), 80);
    if char_length(v_name) < 2 then v_name := 'Member'; end if;
    insert into customer_profiles(user_id, full_name, email, verified_at) values (v_uid, v_name, u.email, u.email_confirmed_at) returning * into cp;
    v_new := true;
    perform log_customer_activity(v_uid, 'registered', 'Email verified');
    for o in select id from promotional_offers where audience = 'welcome' and active loop
      if issue_reward(v_uid, o.id, 'Welcome offer') is not null then v_issued := v_issued + 1; end if;
    end loop;
  elsif cp.email <> u.email then
    -- The email was changed through Supabase's verified change flow: follow it.
    update customer_profiles set email = u.email where user_id = v_uid returning * into cp;
    perform log_customer_activity(v_uid, 'email_changed', null);
  end if;
  return jsonb_build_object('status', 'active', 'new', v_new, 'welcome_rewards', v_issued, 'welcome_emailed', cp.welcome_emailed_at is not null,
    'account_status', cp.status, 'full_name', cp.full_name, 'email', cp.email);
end $$;
grant execute on function ensure_customer_profile() to authenticated;

-- The email function records that the welcome email went out (service role only).
create or replace function mark_welcome_emailed(p_user uuid) returns void
language sql security definer set search_path = public as $$
  update customer_profiles set welcome_emailed_at = now() where user_id = p_user and welcome_emailed_at is null
$$;
revoke execute on function mark_welcome_emailed(uuid) from public, anon, authenticated;
grant execute on function mark_welcome_emailed(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Offer rules: one place decides whether an offer applies to a stay, and for how much
-- ---------------------------------------------------------------------------
create or replace function evaluate_offer(p_user uuid, p_offer uuid, p_reward uuid, p_unit uuid, p_in date, p_out date, p_code_discount int, p_has_code boolean)
returns table(ok boolean, message text, amount int)
language plpgsql stable security definer set search_path = public as $$
declare o promotional_offers; cp customer_profiles; u units; q record; r customer_rewards; v_base int; v_amount int; v_tier_rank int; v_min_rank int; v_uses int;
begin
  select * into cp from customer_profiles where user_id = p_user;
  if cp.user_id is null or cp.status <> 'active' then return query select false, 'Your membership is not active.', 0; return; end if;
  select * into o from promotional_offers where id = p_offer;
  select * into u from units where id = p_unit and active;
  if o.id is null or not o.active or u.id is null then return query select false, 'That offer is not available.', 0; return; end if;
  if p_reward is not null then
    select * into r from customer_rewards where id = p_reward;
    if r.id is null or r.user_id <> p_user or r.offer_id <> o.id then return query select false, 'That reward is not yours.', 0; return; end if;
    if r.status <> 'available' then return query select false, case r.status when 'redeemed' then 'That reward has already been used.' else 'That reward is no longer available.' end, 0; return; end if;
    if r.expires_at is not null and r.expires_at < now() then return query select false, 'That reward has expired.', 0; return; end if;
  elsif o.audience <> 'member' then
    return query select false, 'That offer needs to be issued to you first.', 0; return;
  end if;
  if o.valid_from is not null and nairobi_today() < o.valid_from then return query select false, 'That offer has not started yet.', 0; return; end if;
  if o.valid_to is not null and nairobi_today() > o.valid_to then return query select false, 'That offer has expired.', 0; return; end if;
  if cardinality(o.property_ids) > 0 and not (u.property_id = any (o.property_ids)) then return query select false, 'That offer does not apply to this accommodation.', 0; return; end if;
  if o.min_tier_key is not null then
    select rank into v_min_rank from membership_tiers where key = o.min_tier_key;
    select rank into v_tier_rank from membership_tiers where key = cp.tier_key;
    if coalesce(v_tier_rank, 0) < coalesce(v_min_rank, 0) then return query select false, 'That offer is for higher membership tiers.', 0; return; end if;
  end if;
  if o.first_booking_only and exists (select 1 from bookings where customer_id = p_user and status in ('pending','confirmed','checked_in','checked_out')) then
    return query select false, 'That offer is for your first booking only.', 0; return;
  end if;
  if o.returning_only and not exists (select 1 from bookings where customer_id = p_user and status = 'checked_out') then
    return query select false, 'That offer is for returning guests.', 0; return;
  end if;
  if p_has_code and not o.stackable then return query select false, 'That offer cannot be combined with a discount code.', 0; return; end if;
  if o.max_redemptions is not null and (select count(*) from reward_redemptions where offer_id = o.id and released_at is null) >= o.max_redemptions then
    return query select false, 'That offer has been fully redeemed.', 0; return;
  end if;
  select count(*) into v_uses from reward_redemptions where offer_id = o.id and user_id = p_user and released_at is null;
  if p_reward is null and v_uses >= o.per_customer_limit then return query select false, 'You have already used that offer.', 0; return; end if;
  select * into q from quote_stay(p_unit, p_in, p_out);
  if q.nightly_total < o.min_total then return query select false, format('This offer needs a room total of at least KES %s.', o.min_total), 0; return; end if;
  v_base := greatest(0, q.nightly_total - coalesce(p_code_discount, 0));
  v_amount := case o.kind when 'percent' then (v_base * o.value) / 100 else least(o.value, v_base) end;
  if o.max_discount is not null then v_amount := least(v_amount, o.max_discount); end if;
  if v_amount < 1 then return query select false, 'That offer gives no discount on this stay.', 0; return; end if;
  return query select true, 'Offer applied.', v_amount;
end $$;
revoke execute on function evaluate_offer(uuid, uuid, uuid, uuid, date, date, int, boolean) from public, anon, authenticated;

-- What can the signed-in customer use on this stay? (available rewards + open member offers)
create or replace function my_offers_for_stay(p_unit uuid, p_in date, p_out date)
returns table(reward_id uuid, offer_id uuid, name text, audience text, ok boolean, message text, amount int, code text, expires_at timestamptz, terms text)
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then return; end if;
  return query
    select r.id, o.id, o.name, o.audience, e.ok, e.message, e.amount, r.code, r.expires_at, o.terms
    from customer_rewards r join promotional_offers o on o.id = r.offer_id
    cross join lateral evaluate_offer(v_uid, o.id, r.id, p_unit, p_in, p_out, 0, false) e
    where r.user_id = v_uid and r.status = 'available' and (r.expires_at is null or r.expires_at > now())
    union all
    select null::uuid, o.id, o.name, o.audience, e.ok, e.message, e.amount, null::text, null::timestamptz, o.terms
    from promotional_offers o
    cross join lateral evaluate_offer(v_uid, o.id, null, p_unit, p_in, p_out, 0, false) e
    where o.audience = 'member' and o.active
    order by 5 desc, 7 desc;
end $$;
grant execute on function my_offers_for_stay(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Booking as a member: validates the discount code and the offer, creates the booking, records everything atomically.
-- Called by the create-booking edge function with the customer's verified user id (service role only).
-- ---------------------------------------------------------------------------
create or replace function create_booking_member(
  p_user uuid, p_code text, p_reward uuid, p_offer uuid,
  p_unit uuid, p_in date, p_out date, p_guests int,
  p_guest_name text, p_guest_phone text, p_guest_email text default null,
  p_source booking_source default 'website'
) returns bookings
language plpgsql security definer set search_path = public as $$
declare cp customer_profiles; c discount_codes; ce record; oe record; o promotional_offers; r customer_rewards;
        v_code_amt int := 0; v_offer_amt int := 0; b bookings; v_reward uuid := p_reward; v_offer uuid := p_offer;
begin
  select * into cp from customer_profiles where user_id = p_user for update;
  if cp.user_id is null or cp.status <> 'active' then raise exception 'Your membership is not active.' using errcode = 'check_violation'; end if;

  if p_code is not null and trim(p_code) <> '' then
    select * into c from discount_codes where code = upper(trim(p_code)) for update;
    if c.id is null then raise exception 'That code is not valid.' using errcode = 'check_violation'; end if;
    select * into ce from evaluate_discount(c.id, p_unit, p_in, p_out);
    if not ce.ok then raise exception '%', ce.message using errcode = 'check_violation'; end if;
    v_code_amt := ce.amount;
  end if;

  if v_reward is not null then
    select * into r from customer_rewards where id = v_reward for update;      -- serialises two bookings racing for one reward
    if r.id is null then raise exception 'That reward is not valid.' using errcode = 'check_violation'; end if;
    v_offer := r.offer_id;
  end if;
  if v_offer is not null then
    select * into o from promotional_offers where id = v_offer for update;     -- serialises the redemption limit
    select * into oe from evaluate_offer(p_user, v_offer, v_reward, p_unit, p_in, p_out, v_code_amt, v_code_amt > 0);
    if not oe.ok then raise exception '%', oe.message using errcode = 'check_violation'; end if;
    v_offer_amt := oe.amount;
  end if;

  b := create_booking(p_unit, p_in, p_out, p_guests, p_guest_name, p_guest_phone, p_guest_email, p_source, 'hold', v_code_amt + v_offer_amt, null, null, null);

  update bookings set customer_id = p_user where id = b.id returning * into b;
  update customer_profiles set guest_id = coalesce(guest_id, b.guest_id), phone = coalesce(phone, p_guest_phone)
    where user_id = p_user and not exists (select 1 from customer_profiles x where x.guest_id = b.guest_id and x.user_id <> p_user);

  if v_code_amt > 0 then insert into discount_redemptions(code_id, booking_id, amount) values (c.id, b.id, v_code_amt); end if;
  if v_offer_amt > 0 then
    if v_reward is null then
      -- An open member offer is claimed at the moment it is used, so there is always a record behind the discount.
      insert into customer_rewards(user_id, offer_id, code, expires_at, note) values (p_user, v_offer, new_reward_code(), null, 'Claimed at checkout') returning id into v_reward;
    end if;
    insert into reward_redemptions(reward_id, user_id, offer_id, booking_id, amount) values (v_reward, p_user, v_offer, b.id, v_offer_amt);
    update customer_rewards set status = 'redeemed', booking_id = b.id where id = v_reward;
    perform log_customer_activity(p_user, 'reward_redeemed', o.name || ' (' || b.reference || ')');
  end if;
  perform log_customer_activity(p_user, 'booking_made', b.reference);
  return b;
end $$;
revoke execute on function create_booking_member(uuid,text,uuid,uuid,uuid,date,date,int,text,text,text,booking_source) from public, anon, authenticated;
grant execute on function create_booking_member(uuid,text,uuid,uuid,uuid,date,date,int,text,text,text,booking_source) to service_role;

-- A cancelled, expired or no-show booking gives its reward back (if it has not expired meanwhile).
create or replace function trg_release_reward() returns trigger language plpgsql security definer set search_path = public as $$
declare rr record;
begin
  if new.status in ('cancelled','expired','no_show') and old.status is distinct from new.status then
    for rr in update reward_redemptions set released_at = now() where booking_id = new.id and released_at is null returning reward_id, user_id loop
      update customer_rewards set booking_id = null,
        status = case when expires_at is not null and expires_at < now() then 'expired' else 'available' end
        where id = rr.reward_id;
      perform log_customer_activity(rr.user_id, 'reward_released', new.reference);
    end loop;
  end if;
  return new;
end $$;
create trigger trg_bookings_release_reward after update of status on bookings for each row execute function trg_release_reward();

-- A completed stay earns points and may lift the tier.
create or replace function trg_member_checkout() returns trigger language plpgsql security definer set search_path = public as $$
declare v_per numeric; v_pts int;
begin
  if new.customer_id is not null and new.status = 'checked_out' and old.status is distinct from new.status then
    v_per := greatest(1, setting_num('loyalty_kes_per_point', 100));
    v_pts := floor(new.amount_paid / v_per)::int;
    if v_pts > 0 then
      insert into loyalty_transactions(user_id, kind, points, booking_id, note) values (new.customer_id, 'earn', v_pts, new.id, 'Stay ' || new.reference) on conflict do nothing;
    end if;
    perform log_customer_activity(new.customer_id, 'stay_completed', new.reference);
    perform refresh_customer_tier(new.customer_id);
  end if;
  return new;
end $$;
create trigger trg_bookings_member_checkout after update of status on bookings for each row execute function trg_member_checkout();

-- Birthday rewards: run daily. Issues each active birthday offer to members whose birthday is today (once per offer per year).
create or replace function issue_birthday_rewards() returns int
language plpgsql security definer set search_path = public as $$
declare o record; c record; n int := 0; v_today date := nairobi_today();
begin
  for o in select id from promotional_offers where audience = 'birthday' and active loop
    for c in select user_id from customer_profiles where status = 'active' and birthday is not null
             and extract(month from birthday) = extract(month from v_today) and extract(day from birthday) = extract(day from v_today) loop
      if not exists (select 1 from customer_rewards where user_id = c.user_id and offer_id = o.id and issued_at >= date_trunc('year', now())) then
        if issue_reward(c.user_id, o.id, 'Birthday reward') is not null then n := n + 1; end if;
      end if;
    end loop;
  end loop;
  -- Tiers whose term has run out are re-checked against the criteria.
  perform refresh_customer_tier(user_id) from customer_profiles where not tier_override and tier_expires_at is not null and tier_expires_at < now();
  -- Tidy up rewards that ran out.
  update customer_rewards set status = 'expired' where status = 'available' and expires_at is not null and expires_at < now();
  return n;
end $$;
revoke execute on function issue_birthday_rewards() from public, anon, authenticated;
grant execute on function issue_birthday_rewards() to service_role;

-- ---------------------------------------------------------------------------
-- The customer's own data
-- ---------------------------------------------------------------------------
create or replace function my_customer() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); cp customer_profiles; t membership_tiers; v_pts bigint; v_next record; v_stays int; v_spend bigint;
begin
  select * into cp from customer_profiles where user_id = v_uid;
  if cp.user_id is null then return null; end if;
  select * into t from membership_tiers where key = cp.tier_key;
  select coalesce(sum(points), 0) into v_pts from loyalty_transactions where user_id = v_uid;
  select count(*), coalesce(sum(amount_paid), 0) into v_stays, v_spend from bookings where customer_id = v_uid and status = 'checked_out';
  select key, name, min_completed_stays, min_spend into v_next from membership_tiers where active and rank > t.rank order by rank limit 1;
  return jsonb_build_object(
    'user_id', cp.user_id, 'full_name', cp.full_name, 'email', cp.email, 'phone', cp.phone, 'country', cp.country, 'birthday', cp.birthday,
    'status', cp.status, 'marketing_opt_in', cp.marketing_opt_in, 'member_since', cp.created_at,
    'tier', jsonb_build_object('key', t.key, 'name', t.name, 'benefits', to_jsonb(t.benefits), 'expires_at', cp.tier_expires_at),
    'points', v_pts, 'completed_stays', v_stays, 'total_spend', v_spend,
    'next_tier', case when v_next.key is null then null else jsonb_build_object('key', v_next.key, 'name', v_next.name, 'stays_needed', greatest(0, v_next.min_completed_stays - v_stays), 'spend_needed', greatest(0, v_next.min_spend - v_spend)) end);
end $$;
grant execute on function my_customer() to authenticated;

create or replace function update_my_profile(p_name text, p_phone text, p_country text, p_birthday date, p_marketing boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); cp customer_profiles; v_phone text := nullif(trim(coalesce(p_phone, '')), '');
begin
  select * into cp from customer_profiles where user_id = v_uid for update;
  if cp.user_id is null then raise exception 'Verify your email first.' using errcode = '42501'; end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Please enter your name.' using errcode = 'check_violation'; end if;
  if v_phone is not null and v_phone !~ '^254[17][0-9]{8}$' then raise exception 'Enter a valid Kenyan phone number.' using errcode = 'check_violation'; end if;
  if p_birthday is not null and (p_birthday > current_date or p_birthday < date '1900-01-01') then raise exception 'Check the birthday date.' using errcode = 'check_violation'; end if;
  update customer_profiles set full_name = left(trim(p_name), 80), phone = v_phone, country = nullif(left(trim(coalesce(p_country, '')), 60), ''),
    birthday = p_birthday, marketing_opt_in = coalesce(p_marketing, marketing_opt_in) where user_id = v_uid;
  perform log_customer_activity(v_uid, 'profile_updated', null);
end $$;
grant execute on function update_my_profile(text, text, text, date, boolean) to authenticated;

create or replace function my_bookings() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by (x ->> 'check_in') desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', b.id, 'reference', b.reference, 'public_token', b.public_token, 'status', b.status,
      'check_in', b.check_in, 'check_out', b.check_out, 'nights', b.nights, 'guests', b.num_guests,
      'property', p.name, 'property_slug', p.slug, 'unit', u.name, 'total', b.total_amount, 'discount', b.discount, 'paid', b.amount_paid,
      'balance', greatest(0, b.total_amount - b.amount_paid), 'cancelled_at', b.cancelled_at,
      'offer', (select o.name from reward_redemptions rr join promotional_offers o on o.id = rr.offer_id where rr.booking_id = b.id and rr.released_at is null),
      'open_request', (select r.kind from customer_booking_requests r where r.booking_id = b.id and r.status = 'open' limit 1)) as x
    from bookings b join properties p on p.id = b.property_id join units u on u.id = b.unit_id
    where b.customer_id = (select auth.uid()) and b.status <> 'blocked'
  ) s
$$;
grant execute on function my_bookings() to authenticated;

create or replace function my_rewards() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by (x ->> 'issued_at') desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', r.id, 'code', r.code, 'name', o.name, 'description', o.description, 'terms', o.terms, 'audience', o.audience,
      'kind', o.kind, 'value', o.value, 'max_discount', o.max_discount, 'min_total', o.min_total,
      'status', case when r.status = 'available' and r.expires_at is not null and r.expires_at < now() then 'expired' else r.status end,
      'issued_at', r.issued_at, 'expires_at', r.expires_at, 'booking_id', r.booking_id,
      'redeemed_for', (select b.reference from bookings b where b.id = r.booking_id)) as x
    from customer_rewards r join promotional_offers o on o.id = r.offer_id
    where r.user_id = (select auth.uid())
  ) s
$$;
grant execute on function my_rewards() to authenticated;

-- Open member offers the customer may use (shown under "My offers" even before they pick a stay).
create or replace function my_open_offers() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'description', o.description, 'terms', o.terms, 'kind', o.kind, 'value', o.value,
    'max_discount', o.max_discount, 'min_total', o.min_total, 'valid_to', o.valid_to, 'min_tier', o.min_tier_key,
    'used', (select count(*) from reward_redemptions rr where rr.offer_id = o.id and rr.user_id = (select auth.uid()) and rr.released_at is null)) order by o.created_at desc), '[]'::jsonb)
  from promotional_offers o
  where o.audience = 'member' and o.active and (o.valid_to is null or o.valid_to >= nairobi_today())
    and exists (select 1 from customer_profiles cp where cp.user_id = (select auth.uid()) and cp.status = 'active')
$$;
grant execute on function my_open_offers() to authenticated;

-- Ask staff to change or cancel a booking. Only the booking's own customer can ask.
create or replace function request_booking_change(p_booking uuid, p_kind text, p_message text, p_new_in date default null, p_new_out date default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); b bookings; v_id uuid;
begin
  select * into b from bookings where id = p_booking and customer_id = v_uid;
  if b.id is null then raise exception 'Booking not found.' using errcode = 'no_data_found'; end if;
  if b.status not in ('pending','confirmed') then raise exception 'This booking can no longer be changed online. Please contact us.' using errcode = 'check_violation'; end if;
  if p_kind not in ('cancellation','modification') then raise exception 'Choose cancellation or modification.' using errcode = 'check_violation'; end if;
  if p_kind = 'modification' and (p_new_in is null or p_new_out is null) then raise exception 'Choose the new dates.' using errcode = 'check_violation'; end if;
  if (select count(*) from customer_booking_requests where user_id = v_uid and created_at > now() - interval '1 day') >= 10 then
    raise exception 'Too many requests today. Please contact us.' using errcode = 'check_violation';
  end if;
  insert into customer_booking_requests(user_id, booking_id, kind, message, new_check_in, new_check_out)
    values (v_uid, b.id, p_kind, p_message, case when p_kind = 'modification' then p_new_in end, case when p_kind = 'modification' then p_new_out end)
    returning id into v_id;
  insert into notifications(kind, title, body, link, property_id, entity_id)
    values ('customer_request', initcap(p_kind) || ' request: ' || b.reference, left(p_message, 200), '/admin/bookings/' || b.id, b.property_id, v_id) on conflict do nothing;
  perform log_customer_activity(v_uid, 'booking_request', p_kind || ' ' || b.reference);
  return v_id;
exception when unique_violation then
  raise exception 'You already have an open request for this booking.' using errcode = 'check_violation';
end $$;
grant execute on function request_booking_change(uuid, text, text, date, date) to authenticated;

-- Attach an earlier guest booking to the signed-in account. The customer must prove they hold the booking: its reference AND the
-- phone number it was made with, and the booking must not already belong to someone else. Email alone is never enough.
create or replace function claim_booking(p_reference text, p_phone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); cp customer_profiles; b bookings; g guests; n int;
begin
  select * into cp from customer_profiles where user_id = v_uid and status = 'active';
  if cp.user_id is null then raise exception 'Verify your email first.' using errcode = '42501'; end if;
  select count(*) into n from rate_limit_events where key = 'claim:' || v_uid::text and created_at > now() - interval '1 hour';
  if n >= 10 then raise exception 'Too many attempts. Please try again later.' using errcode = 'check_violation'; end if;
  insert into rate_limit_events(key) values ('claim:' || v_uid::text);
  select b2.* into b from bookings b2 join guests g2 on g2.id = b2.guest_id
    where b2.reference = upper(trim(coalesce(p_reference, ''))) and g2.phone = trim(coalesce(p_phone, '')) and b2.status <> 'blocked';
  -- Same answer for "no such booking" and "wrong phone" so references cannot be probed.
  if b.id is null then raise exception 'We could not match that booking. Check the reference and phone number.' using errcode = 'check_violation'; end if;
  if b.customer_id is not null and b.customer_id <> v_uid then raise exception 'We could not match that booking. Check the reference and phone number.' using errcode = 'check_violation'; end if;
  select * into g from guests where id = b.guest_id;
  update bookings set customer_id = v_uid where id = b.id;
  update customer_profiles set guest_id = coalesce(guest_id, b.guest_id), phone = coalesce(phone, g.phone)
    where user_id = v_uid and not exists (select 1 from customer_profiles x where x.guest_id = b.guest_id and x.user_id <> v_uid);
  -- Past stays count towards the tier and points.
  if b.status = 'checked_out' then
    insert into loyalty_transactions(user_id, kind, points, booking_id, note)
      select v_uid, 'earn', floor(b.amount_paid / greatest(1, setting_num('loyalty_kes_per_point', 100)))::int, b.id, 'Stay ' || b.reference
      where floor(b.amount_paid / greatest(1, setting_num('loyalty_kes_per_point', 100))) > 0 on conflict do nothing;
    perform refresh_customer_tier(v_uid);
  end if;
  perform log_customer_activity(v_uid, 'booking_claimed', b.reference);
  return jsonb_build_object('reference', b.reference, 'status', b.status);
end $$;
grant execute on function claim_booking(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Staff: customers, analytics, tiers, loyalty
-- ---------------------------------------------------------------------------
create or replace function admin_customer_list(p_search text default null, p_limit int default 200) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission('customers.view');
  return coalesce((
    select jsonb_agg(x order by (x ->> 'created_at') desc) from (
      select jsonb_build_object(
        'user_id', cp.user_id, 'full_name', cp.full_name, 'email', cp.email, 'phone', cp.phone, 'status', cp.status, 'tier', t.name, 'tier_key', cp.tier_key,
        'created_at', cp.created_at, 'verified_at', cp.verified_at,
        'bookings', (select count(*) from bookings b where b.customer_id = cp.user_id and b.status not in ('cancelled','expired')),
        'spend', (select coalesce(sum(b.amount_paid), 0) from bookings b where b.customer_id = cp.user_id),
        'points', (select coalesce(sum(points), 0) from loyalty_transactions l where l.user_id = cp.user_id),
        'rewards_available', (select count(*) from customer_rewards r where r.user_id = cp.user_id and r.status = 'available' and (r.expires_at is null or r.expires_at > now()))) as x
      from customer_profiles cp join membership_tiers t on t.key = cp.tier_key
      where p_search is null or trim(p_search) = '' or cp.full_name ilike '%' || trim(p_search) || '%' or cp.email ilike '%' || trim(p_search) || '%' or cp.phone ilike '%' || trim(p_search) || '%'
      order by cp.created_at desc limit least(greatest(p_limit, 1), 500)
    ) s), '[]'::jsonb);
end $$;
grant execute on function admin_customer_list(text, int) to authenticated;

create or replace function admin_customer_detail(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cp customer_profiles;
begin
  perform require_permission('customers.view');
  select * into cp from customer_profiles where user_id = p_user;
  if cp.user_id is null then raise exception 'Customer not found.' using errcode = 'no_data_found'; end if;
  return jsonb_build_object(
    'profile', to_jsonb(cp),
    'tier', (select to_jsonb(t) from membership_tiers t where t.key = cp.tier_key),
    'points', (select coalesce(sum(points), 0) from loyalty_transactions where user_id = p_user),
    'bookings', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'reference', b.reference, 'status', b.status, 'check_in', b.check_in, 'check_out', b.check_out, 'total', b.total_amount, 'paid', b.amount_paid, 'discount', b.discount) order by b.check_in desc) from bookings b where b.customer_id = p_user), '[]'::jsonb),
    'rewards', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'name', o.name, 'status', r.status, 'issued_at', r.issued_at, 'expires_at', r.expires_at) order by r.issued_at desc) from customer_rewards r join promotional_offers o on o.id = r.offer_id where r.user_id = p_user), '[]'::jsonb),
    'activity', coalesce((select jsonb_agg(jsonb_build_object('kind', a.kind, 'detail', a.detail, 'created_at', a.created_at) order by a.created_at desc) from (select * from customer_activity where user_id = p_user order by created_at desc limit 50) a), '[]'::jsonb));
end $$;
grant execute on function admin_customer_detail(uuid) to authenticated;

-- Every figure here is counted from the records. Nothing is estimated.
create or replace function membership_overview(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare v_since timestamptz := now() - make_interval(days => least(greatest(p_days, 1), 3650));
begin
  perform require_permission('customers.view');
  return jsonb_build_object(
    'registered', (select count(*) from auth.users u where not exists (select 1 from profiles p where p.id = u.id)),
    'verified', (select count(*) from customer_profiles),
    'new_registrations', (select count(*) from customer_profiles where created_at >= v_since),
    'active_members', (select count(*) from customer_profiles where status = 'active'),
    'suspended', (select count(*) from customer_profiles where status = 'suspended'),
    'welcome_issued', (select count(*) from customer_rewards r join promotional_offers o on o.id = r.offer_id where o.audience = 'welcome'),
    'offers_issued', (select count(*) from customer_rewards),
    'offers_redeemed', (select count(*) from reward_redemptions where released_at is null),
    'discount_value', (select coalesce(sum(amount), 0) from reward_redemptions where released_at is null),
    'member_bookings', (select count(*) from bookings where customer_id is not null and status not in ('cancelled','expired','no_show')),
    'member_revenue', (select coalesce(sum(amount_paid), 0) from bookings where customer_id is not null and status not in ('cancelled','expired','no_show')),
    'by_tier', coalesce((select jsonb_agg(jsonb_build_object('key', t.key, 'name', t.name, 'members', (select count(*) from customer_profiles cp where cp.tier_key = t.key)) order by t.rank) from membership_tiers t), '[]'::jsonb));
end $$;
grant execute on function membership_overview(int) to authenticated;

create or replace function admin_redemptions() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission('customers.view');
  return coalesce((select jsonb_agg(x order by (x ->> 'created_at') desc) from (
    select jsonb_build_object('id', rr.id, 'created_at', rr.created_at, 'released_at', rr.released_at, 'amount', rr.amount, 'offer', o.name, 'code', r.code,
      'customer', cp.full_name, 'user_id', cp.user_id, 'booking_id', b.id, 'reference', b.reference) as x
    from reward_redemptions rr join promotional_offers o on o.id = rr.offer_id join customer_rewards r on r.id = rr.reward_id
    join customer_profiles cp on cp.user_id = rr.user_id join bookings b on b.id = rr.booking_id
    order by rr.created_at desc limit 500) s), '[]'::jsonb);
end $$;
grant execute on function admin_redemptions() to authenticated;

create or replace function admin_loyalty_ledger() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission('customers.view');
  return coalesce((select jsonb_agg(x order by (x ->> 'created_at') desc) from (
    select jsonb_build_object('id', l.id, 'created_at', l.created_at, 'kind', l.kind, 'points', l.points, 'note', l.note, 'customer', cp.full_name, 'user_id', cp.user_id, 'reference', b.reference) as x
    from loyalty_transactions l join customer_profiles cp on cp.user_id = l.user_id left join bookings b on b.id = l.booking_id
    order by l.created_at desc limit 500) s), '[]'::jsonb);
end $$;
grant execute on function admin_loyalty_ledger() to authenticated;

create or replace function admin_customer_activity() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission('customers.view');
  return coalesce((select jsonb_agg(x order by (x ->> 'created_at') desc) from (
    select jsonb_build_object('id', a.id, 'created_at', a.created_at, 'kind', a.kind, 'detail', a.detail, 'customer', cp.full_name, 'user_id', cp.user_id) as x
    from customer_activity a join customer_profiles cp on cp.user_id = a.user_id order by a.created_at desc limit 300) s), '[]'::jsonb);
end $$;
grant execute on function admin_customer_activity() to authenticated;

create or replace function set_customer_status(p_user uuid, p_status text, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_permission('customers.manage');
  if p_status not in ('active','suspended') then raise exception 'Unknown status.' using errcode = 'check_violation'; end if;
  if p_status = 'suspended' and char_length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Say why the account is being suspended.' using errcode = 'check_violation'; end if;
  update customer_profiles set status = p_status, suspended_reason = case when p_status = 'suspended' then trim(p_reason) end where user_id = p_user;
  if not found then raise exception 'Customer not found.' using errcode = 'no_data_found'; end if;
  perform log_customer_activity(p_user, 'status_' || p_status, p_reason);
end $$;
grant execute on function set_customer_status(uuid, text, text) to authenticated;

-- p_tier null = go back to the tier the criteria give.
create or replace function set_customer_tier(p_user uuid, p_tier text) returns text
language plpgsql security definer set search_path = public as $$
declare t membership_tiers; cp customer_profiles;
begin
  perform require_permission('customers.manage');
  select * into cp from customer_profiles where user_id = p_user for update;
  if cp.user_id is null then raise exception 'Customer not found.' using errcode = 'no_data_found'; end if;
  if p_tier is null then
    update customer_profiles set tier_override = false where user_id = p_user;
    return refresh_customer_tier(p_user);
  end if;
  select * into t from membership_tiers where key = p_tier and active;
  if t.key is null then raise exception 'Unknown tier.' using errcode = 'check_violation'; end if;
  update customer_profiles set tier_key = t.key, tier_override = true,
    tier_expires_at = case when t.expiry_months is null then null else now() + make_interval(months => t.expiry_months) end where user_id = p_user;
  perform log_customer_activity(p_user, 'tier_set', cp.tier_key || ' -> ' || t.key || ' (by staff)');
  return t.key;
end $$;
grant execute on function set_customer_tier(uuid, text) to authenticated;

create or replace function adjust_loyalty_points(p_user uuid, p_points int, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_permission('customers.manage');
  if p_points = 0 then raise exception 'Enter a number of points.' using errcode = 'check_violation'; end if;
  if char_length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Say why the points are being adjusted.' using errcode = 'check_violation'; end if;
  if not exists (select 1 from customer_profiles where user_id = p_user) then raise exception 'Customer not found.' using errcode = 'no_data_found'; end if;
  if p_points < 0 and (select coalesce(sum(points), 0) from loyalty_transactions where user_id = p_user) + p_points < 0 then
    raise exception 'That would take the balance below zero.' using errcode = 'check_violation';
  end if;
  insert into loyalty_transactions(user_id, kind, points, note, created_by) values (p_user, 'adjust', p_points, trim(p_note), (select auth.uid()));
  perform log_customer_activity(p_user, 'points_adjusted', p_points::text || ' (' || trim(p_note) || ')');
end $$;
grant execute on function adjust_loyalty_points(uuid, int, text) to authenticated;

create or replace function resolve_customer_request(p_request uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_permission('bookings.manage');
  if p_status not in ('done','declined') then raise exception 'Unknown status.' using errcode = 'check_violation'; end if;
  update customer_booking_requests set status = p_status, staff_note = nullif(trim(coalesce(p_note, '')), ''), resolved_by = (select auth.uid()), resolved_at = now()
    where id = p_request and status = 'open';
  if not found then raise exception 'Request not found or already handled.' using errcode = 'no_data_found'; end if;
end $$;
grant execute on function resolve_customer_request(uuid, text, text) to authenticated;

-- Staff can issue a one-off reward to a customer (for example a goodwill gesture).
create or replace function admin_issue_reward(p_user uuid, p_offer uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  perform require_permission('offers.manage');
  v := issue_reward(p_user, p_offer, nullif(trim(coalesce(p_note, '')), ''));
  if v is null then raise exception 'That offer could not be issued (inactive, expired, or already held).' using errcode = 'check_violation'; end if;
  return v;
end $$;
grant execute on function admin_issue_reward(uuid, uuid, text) to authenticated;

-- Emails: the edge function asks which rewards still need their email, and which members to tell about an offer. Service role only.
create or replace function pending_reward_emails(p_user uuid default null)
returns table(reward_id uuid, user_id uuid, email text, full_name text, marketing_opt_in boolean, audience text, name text, description text, terms text,
              kind text, value int, max_discount int, min_total int, code text, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.id, cp.user_id, cp.email, cp.full_name, cp.marketing_opt_in, o.audience, o.name, o.description, o.terms, o.kind, o.value, o.max_discount, o.min_total, r.code, r.expires_at
  from customer_rewards r join promotional_offers o on o.id = r.offer_id join customer_profiles cp on cp.user_id = r.user_id
  where r.emailed_at is null and r.status = 'available' and o.audience in ('welcome','birthday') and cp.status = 'active'
    and r.issued_at > now() - interval '3 days' and (r.expires_at is null or r.expires_at > now())
    and (p_user is null or cp.user_id = p_user)
    and (o.audience = 'welcome' or cp.marketing_opt_in)
$$;
revoke execute on function pending_reward_emails(uuid) from public, anon, authenticated;
grant execute on function pending_reward_emails(uuid) to service_role;

create or replace function mark_reward_emailed(p_reward uuid) returns void
language sql security definer set search_path = public as $$
  update customer_rewards set emailed_at = now() where id = p_reward and emailed_at is null
$$;
revoke execute on function mark_reward_emailed(uuid) from public, anon, authenticated;
grant execute on function mark_reward_emailed(uuid) to service_role;

create or replace function promo_recipients(p_offer uuid)
returns table(user_id uuid, email text, full_name text)
language sql stable security definer set search_path = public as $$
  select cp.user_id, cp.email, cp.full_name from customer_profiles cp
  where cp.status = 'active' and cp.marketing_opt_in
    and exists (select 1 from promotional_offers o where o.id = p_offer and o.active and o.audience = 'member'
                and (o.valid_to is null or o.valid_to >= nairobi_today())
                and (o.min_tier_key is null or (select rank from membership_tiers where key = cp.tier_key) >= (select rank from membership_tiers where key = o.min_tier_key)))
  order by cp.created_at limit 1000
$$;
revoke execute on function promo_recipients(uuid) from public, anon, authenticated;
grant execute on function promo_recipients(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Seed: the welcome offer (5% off the first booking) and an optional birthday offer, switched off until the owner wants it
-- ---------------------------------------------------------------------------
insert into promotional_offers(name, description, terms, audience, kind, value, valid_days, first_booking_only, per_customer_limit, active) values
  ('Welcome offer: 5% off your first stay', '5% off your first eligible booking as a new member.',
   'Valid for one booking, on the room charge only (not the cleaning fee). Cannot be combined with a discount code. Expires 60 days after you join.',
   'welcome', 'percent', 5, 60, true, 1, true),
  ('Birthday treat', 'A little thank-you in your birthday month.',
   'Valid for one booking, on the room charge only. Expires 30 days after it is issued.',
   'birthday', 'percent', 10, 30, false, 1, false);

-- ---------------------------------------------------------------------------
-- Daily birthday job (only where pg_cron exists)
-- ---------------------------------------------------------------------------
do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('bnb-birthday-rewards', '10 3 * * *', 'select public.issue_birthday_rewards()');
    -- Then email whatever rewards are waiting (birthday rewards, and any welcome email that did not go out at sign-up).
    perform cron.schedule('bnb-member-emails', '20 3 * * *', $c$select public.invoke_edge_function('member-emails')$c$);
  end if;
exception when others then null;
end $cron$;

$m0029$;
    raise notice 'Applied 0029';
  else
    raise notice '0029 already applied, skipped';
  end if;
end
$apply$;
