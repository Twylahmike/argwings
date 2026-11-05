-- apply_pending.sql: paste into the Supabase SQL Editor of project "bnb-system" (ref bxpgpzrtoxjmynyjnfkg) and press Run.
-- PART 8 of 10: migrations 0030 to 0030. Run the parts in order.
-- Stops without changes if this is the wrong project or migration 0008 is missing.
do $apply$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'STOP: this is not the RG Wings project (no bookings table). Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='units' and column_name='maintenance_status') then
    raise exception 'STOP: apply migration 0008 first. Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='promotional_offers' and column_name='min_nights') then
    execute $m0030$
-- 0030_optional_membership.sql
-- Registration is free and OPTIONAL. Adds: an owner switch for registration, more welcome-offer controls (minimum nights, room-only or
-- whole-total discount), exactly one welcome reward per customer, adding a booking to an account from its secret link, and the guest
-- versus member analytics. Guest checkout is untouched and stays on by default.

alter table promotional_offers
  add column min_nights int not null default 1 check (min_nights >= 1),
  add column applies_to text not null default 'room' check (applies_to in ('room','total'));   -- room = accommodation charge only

insert into settings(key, value) values ('registration_enabled', 'true') on conflict (key) do nothing;
drop policy if exists settings_public_read on settings;
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes',
                 'mpesa_manual_instructions','mpesa_paybill_display','brand_color','site_content','booking_mode',
                 'business_email','business_address','currency','maintenance_mode','guest_checkout_enabled','registration_enabled'));

-- The owner's two switches. Only these keys, only with the customers.manage permission.
create or replace function set_membership_setting(p_key text, p_value boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_permission('customers.manage');
  if p_key not in ('registration_enabled', 'guest_checkout_enabled') then raise exception 'Unknown setting.' using errcode = 'check_violation'; end if;
  insert into settings(key, value, updated_at) values (p_key, to_jsonb(p_value), now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;
grant execute on function set_membership_setting(text, boolean) to authenticated;

-- A customer gets at most one welcome reward, ever (even if the owner later adds a second welcome offer).
create or replace function issue_reward(p_user uuid, p_offer uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare o promotional_offers; v_id uuid; v_exp timestamptz;
begin
  select * into o from promotional_offers where id = p_offer and active;
  if o.id is null then return null; end if;
  if o.valid_from is not null and nairobi_today() < o.valid_from then return null; end if;
  if o.valid_to is not null and nairobi_today() > o.valid_to then return null; end if;
  if (select count(*) from customer_rewards where user_id = p_user and offer_id = o.id and status <> 'void') >= o.per_customer_limit then return null; end if;
  if o.audience = 'welcome' and exists (select 1 from customer_rewards r join promotional_offers x on x.id = r.offer_id
                                         where r.user_id = p_user and x.audience = 'welcome' and r.status <> 'void') then return null; end if;
  v_exp := case when o.valid_days is not null then now() + make_interval(days => o.valid_days) else null end;
  if o.valid_to is not null and (v_exp is null or v_exp > (o.valid_to + 1)::timestamptz) then v_exp := (o.valid_to + 1)::timestamptz; end if;
  insert into customer_rewards(user_id, offer_id, code, expires_at, note) values (p_user, o.id, new_reward_code(), v_exp, p_note) returning id into v_id;
  perform log_customer_activity(p_user, 'reward_issued', o.name);
  return v_id;
end $$;
revoke execute on function issue_reward(uuid, uuid, text) from public, anon, authenticated;

-- When registration is switched off no NEW membership is created (existing members keep theirs).
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
    if (select value from settings where key = 'registration_enabled') = 'false'::jsonb then return jsonb_build_object('status', 'closed'); end if;
    v_name := left(trim(coalesce(u.raw_user_meta_data ->> 'full_name', split_part(u.email, '@', 1))), 80);
    if char_length(v_name) < 2 then v_name := 'Member'; end if;
    insert into customer_profiles(user_id, full_name, email, verified_at) values (v_uid, v_name, u.email, u.email_confirmed_at) returning * into cp;
    v_new := true;
    perform log_customer_activity(v_uid, 'registered', 'Email verified');
    for o in select id from promotional_offers where audience = 'welcome' and active order by created_at loop
      if issue_reward(v_uid, o.id, 'Welcome offer') is not null then v_issued := v_issued + 1; end if;
    end loop;
  elsif cp.email <> u.email then
    update customer_profiles set email = u.email where user_id = v_uid returning * into cp;
    perform log_customer_activity(v_uid, 'email_changed', null);
  end if;
  return jsonb_build_object('status', 'active', 'new', v_new, 'welcome_rewards', v_issued, 'welcome_emailed', cp.welcome_emailed_at is not null,
    'account_status', cp.status, 'full_name', cp.full_name, 'email', cp.email);
end $$;
grant execute on function ensure_customer_profile() to authenticated;

-- Offer rules, now with minimum nights, "room only or whole total", and one welcome redemption per customer.
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
  if o.audience = 'welcome' and exists (select 1 from reward_redemptions rr join promotional_offers x on x.id = rr.offer_id
                                         where rr.user_id = p_user and x.audience = 'welcome' and rr.released_at is null) then
    return query select false, 'Your welcome offer has already been used.', 0; return;
  end if;
  if o.valid_from is not null and nairobi_today() < o.valid_from then return query select false, 'That offer has not started yet.', 0; return; end if;
  if o.valid_to is not null and nairobi_today() > o.valid_to then return query select false, 'That offer has expired.', 0; return; end if;
  if cardinality(o.property_ids) > 0 and not (u.property_id = any (o.property_ids)) then return query select false, 'That offer does not apply to this accommodation.', 0; return; end if;
  if (p_out - p_in) < o.min_nights then return query select false, format('This offer needs a stay of at least %s night(s).', o.min_nights), 0; return; end if;
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
  v_base := case o.applies_to when 'total' then q.total else q.nightly_total end;
  if v_base < o.min_total then return query select false, format('This offer needs a booking of at least KES %s.', o.min_total), 0; return; end if;
  v_base := greatest(0, v_base - coalesce(p_code_discount, 0));
  v_amount := case o.kind when 'percent' then (v_base * o.value) / 100 else least(o.value, v_base) end;
  if o.max_discount is not null then v_amount := least(v_amount, o.max_discount); end if;
  if v_amount < 1 then return query select false, 'That offer gives no discount on this stay.', 0; return; end if;
  return query select true, 'Offer applied.', v_amount;
end $$;
revoke execute on function evaluate_offer(uuid, uuid, uuid, uuid, date, date, int, boolean) from public, anon, authenticated;

-- Add the booking behind a secret booking link to the signed-in account. The link token is the proof; it is only ever held by the
-- guest (it is in their confirmation message). A booking already linked to someone else cannot be taken.
create or replace function claim_booking_by_token(p_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); cp customer_profiles; b bookings; g guests; n int;
begin
  select * into cp from customer_profiles where user_id = v_uid and status = 'active';
  if cp.user_id is null then raise exception 'Verify your email first.' using errcode = '42501'; end if;
  select count(*) into n from rate_limit_events where key = 'claim:' || v_uid::text and created_at > now() - interval '1 hour';
  if n >= 20 then raise exception 'Too many attempts. Please try again later.' using errcode = 'check_violation'; end if;
  insert into rate_limit_events(key) values ('claim:' || v_uid::text);
  select * into b from bookings where public_token = p_token and status <> 'blocked';
  if b.id is null or (b.customer_id is not null and b.customer_id <> v_uid) then
    raise exception 'We could not add that booking to your account.' using errcode = 'check_violation';
  end if;
  if b.customer_id is null then
    select * into g from guests where id = b.guest_id;
    update bookings set customer_id = v_uid where id = b.id;
    update customer_profiles set guest_id = coalesce(guest_id, b.guest_id), phone = coalesce(phone, g.phone)
      where user_id = v_uid and not exists (select 1 from customer_profiles x where x.guest_id = b.guest_id and x.user_id <> v_uid);
    if b.status = 'checked_out' then
      insert into loyalty_transactions(user_id, kind, points, booking_id, note)
        select v_uid, 'earn', floor(b.amount_paid / greatest(1, setting_num('loyalty_kes_per_point', 100)))::int, b.id, 'Stay ' || b.reference
        where floor(b.amount_paid / greatest(1, setting_num('loyalty_kes_per_point', 100))) > 0 on conflict do nothing;
      perform refresh_customer_tier(v_uid);
    end if;
    perform log_customer_activity(v_uid, 'booking_claimed', b.reference || ' (booking link)');
  end if;
  return jsonb_build_object('reference', b.reference, 'status', b.status);
end $$;
grant execute on function claim_booking_by_token(uuid) to authenticated;

-- How many earlier guest bookings carry my verified email and are not on any account? A count only: never the bookings themselves.
create or replace function unclaimed_bookings_count() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from bookings b join guests g on g.id = b.guest_id join customer_profiles cp on cp.email = lower(g.email)
  where cp.user_id = (select auth.uid()) and b.customer_id is null and b.status not in ('blocked','expired')
$$;
grant execute on function unclaimed_bookings_count() to authenticated;

-- Guest versus member numbers and the returning-customer rate, all counted from bookings.
create or replace function membership_overview(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare v_since timestamptz := now() - make_interval(days => least(greatest(p_days, 1), 3650)); v_guests int; v_returning int;
begin
  perform require_permission('customers.view');
  select count(*), count(*) filter (where n >= 2) into v_guests, v_returning from (
    select guest_id, count(*) n from bookings where guest_id is not null and status in ('confirmed','checked_in','checked_out') group by guest_id) s;
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
    'member_bookings', (select count(*) from bookings where customer_id is not null and status not in ('cancelled','expired','no_show','blocked')),
    'guest_bookings', (select count(*) from bookings where customer_id is null and guest_id is not null and status not in ('cancelled','expired','no_show','blocked')),
    'member_revenue', (select coalesce(sum(amount_paid), 0) from bookings where customer_id is not null and status not in ('cancelled','expired','no_show')),
    'returning_customers', v_returning, 'booked_customers', v_guests,
    'returning_rate', case when v_guests = 0 then 0 else round(100.0 * v_returning / v_guests) end,
    'registration_enabled', coalesce((select value from settings where key = 'registration_enabled') <> 'false'::jsonb, true),
    'guest_checkout_enabled', coalesce((select value from settings where key = 'guest_checkout_enabled') <> 'false'::jsonb, true),
    'by_tier', coalesce((select jsonb_agg(jsonb_build_object('key', t.key, 'name', t.name, 'members', (select count(*) from customer_profiles cp where cp.tier_key = t.key)) order by t.rank) from membership_tiers t), '[]'::jsonb));
end $$;
grant execute on function membership_overview(int) to authenticated;

-- The welcome offer text the owner wrote earlier mentions the cleaning fee and a fixed expiry; keep it accurate without hardcoding the number.
update promotional_offers set terms = 'Valid for one booking, on the accommodation charge only. Cannot be combined with a discount code unless stated. Your reward expires after the period shown in your account.'
 where audience = 'welcome' and terms like 'Valid for one booking, on the room charge only (not the cleaning fee)%';

$m0030$;
    raise notice 'Applied 0030';
  else
    raise notice '0030 already applied, skipped';
  end if;
end
$apply$;
