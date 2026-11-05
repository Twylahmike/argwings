-- 0032_redeem_points.sql
-- Members can spend loyalty points as money off the accommodation charge at checkout. Off until the owner switches it on.
--  * The owner sets what a point is worth, the most of a stay that points may cover, and how many KES of spend earns a point.
--  * Points are checked and taken inside the booking transaction (the member row is locked), so a balance can never be spent twice.
--  * A cancelled, expired or no-show booking gives its points back, exactly once.
--  * The discount is part of the booking's discount, and the redemption is a ledger row tied to the booking.

alter table loyalty_transactions drop constraint if exists loyalty_transactions_kind_check;
alter table loyalty_transactions add constraint loyalty_transactions_kind_check check (kind in ('earn','adjust','reverse','redeem'));
create unique index loyalty_redeem_once on loyalty_transactions (booking_id) where kind = 'redeem';
create unique index loyalty_reverse_once on loyalty_transactions (booking_id) where kind = 'reverse';

insert into settings(key, value) values ('loyalty_redeem_enabled', 'false'), ('loyalty_redeem_kes_per_point', '1'), ('loyalty_redeem_max_percent', '50')
  on conflict (key) do nothing;

-- Owner: the four loyalty numbers in one call.
create or replace function set_loyalty_settings(p_redeem_enabled boolean, p_kes_per_point int, p_max_percent int, p_earn_kes_per_point int) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_permission('customers.manage');
  if p_kes_per_point is null or p_kes_per_point < 1 or p_kes_per_point > 1000 then raise exception 'A point can be worth 1 to 1000 shillings.' using errcode = 'check_violation'; end if;
  if p_max_percent is null or p_max_percent < 1 or p_max_percent > 100 then raise exception 'Points can cover 1 to 100 percent of a stay.' using errcode = 'check_violation'; end if;
  if p_earn_kes_per_point is null or p_earn_kes_per_point < 10 or p_earn_kes_per_point > 100000 then raise exception 'A point is earned per 10 to 100000 shillings spent.' using errcode = 'check_violation'; end if;
  insert into settings(key, value, updated_at) values
    ('loyalty_redeem_enabled', to_jsonb(p_redeem_enabled), now()), ('loyalty_redeem_kes_per_point', to_jsonb(p_kes_per_point), now()),
    ('loyalty_redeem_max_percent', to_jsonb(p_max_percent), now()), ('loyalty_kes_per_point', to_jsonb(p_earn_kes_per_point), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;
grant execute on function set_loyalty_settings(boolean, int, int, int) to authenticated;

create or replace function loyalty_settings() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission('customers.view');
  return jsonb_build_object(
    'redeem_enabled', coalesce((select value from settings where key = 'loyalty_redeem_enabled') = 'true'::jsonb, false),
    'kes_per_point', setting_num('loyalty_redeem_kes_per_point', 1)::int, 'max_percent', setting_num('loyalty_redeem_max_percent', 50)::int,
    'earn_kes_per_point', setting_num('loyalty_kes_per_point', 100)::int,
    'points_outstanding', (select coalesce(sum(points), 0) from loyalty_transactions),
    'points_redeemed', (select coalesce(-sum(points), 0) from loyalty_transactions where kind = 'redeem') - (select coalesce(sum(points), 0) from loyalty_transactions where kind = 'reverse'),
    'value_redeemed', ((select coalesce(-sum(points), 0) from loyalty_transactions where kind = 'redeem') - (select coalesce(sum(points), 0) from loyalty_transactions where kind = 'reverse')) * setting_num('loyalty_redeem_kes_per_point', 1));
end $$;
grant execute on function loyalty_settings() to authenticated;

-- What can this member spend on this stay? (preview for the booking page; create_booking_member re-checks everything)
create or replace function points_for_stay(p_unit uuid, p_in date, p_out date, p_other_discount int default 0) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); v_enabled boolean; v_value int; v_pct int; v_bal bigint; q record; v_cap int; v_max int;
begin
  if v_uid is null or not exists (select 1 from customer_profiles where user_id = v_uid and status = 'active') then return jsonb_build_object('enabled', false); end if;
  v_enabled := coalesce((select value from settings where key = 'loyalty_redeem_enabled') = 'true'::jsonb, false);
  if not v_enabled then return jsonb_build_object('enabled', false); end if;
  v_value := setting_num('loyalty_redeem_kes_per_point', 1)::int; v_pct := setting_num('loyalty_redeem_max_percent', 50)::int;
  select coalesce(sum(points), 0) into v_bal from loyalty_transactions where user_id = v_uid;
  select * into q from quote_stay(p_unit, p_in, p_out);
  v_cap := floor(greatest(0, q.nightly_total - greatest(0, coalesce(p_other_discount, 0))) * v_pct / 100.0)::int;
  v_max := least(v_bal, v_cap / v_value)::int;
  return jsonb_build_object('enabled', true, 'balance', v_bal, 'kes_per_point', v_value, 'max_percent', v_pct, 'max_points', greatest(0, v_max), 'max_discount', greatest(0, v_max) * v_value);
end $$;
grant execute on function points_for_stay(uuid, date, date, int) to authenticated;

-- Replace the member-booking function with a version that also takes points. The old signature is dropped so calls stay unambiguous;
-- the new one defaults p_points to 0, so a caller that does not send points keeps working.
drop function create_booking_member(uuid, text, uuid, uuid, uuid, date, date, int, text, text, text, booking_source);
create or replace function create_booking_member(
  p_user uuid, p_code text, p_reward uuid, p_offer uuid,
  p_unit uuid, p_in date, p_out date, p_guests int,
  p_guest_name text, p_guest_phone text, p_guest_email text default null,
  p_source booking_source default 'website',
  p_points int default 0
) returns bookings
language plpgsql security definer set search_path = public as $$
declare cp customer_profiles; c discount_codes; ce record; oe record; o promotional_offers; r customer_rewards; q record;
        v_code_amt int := 0; v_offer_amt int := 0; v_pts_amt int := 0; v_bal bigint; v_value int; v_cap int;
        b bookings; v_reward uuid := p_reward; v_offer uuid := p_offer;
begin
  select * into cp from customer_profiles where user_id = p_user for update;             -- also serialises this member's points
  if cp.user_id is null or cp.status <> 'active' then raise exception 'Your membership is not active.' using errcode = 'check_violation'; end if;

  if p_code is not null and trim(p_code) <> '' then
    select * into c from discount_codes where code = upper(trim(p_code)) for update;
    if c.id is null then raise exception 'That code is not valid.' using errcode = 'check_violation'; end if;
    select * into ce from evaluate_discount(c.id, p_unit, p_in, p_out);
    if not ce.ok then raise exception '%', ce.message using errcode = 'check_violation'; end if;
    v_code_amt := ce.amount;
  end if;

  if v_reward is not null then
    select * into r from customer_rewards where id = v_reward for update;
    if r.id is null then raise exception 'That reward is not valid.' using errcode = 'check_violation'; end if;
    v_offer := r.offer_id;
  end if;
  if v_offer is not null then
    select * into o from promotional_offers where id = v_offer for update;
    select * into oe from evaluate_offer(p_user, v_offer, v_reward, p_unit, p_in, p_out, v_code_amt, v_code_amt > 0);
    if not oe.ok then raise exception '%', oe.message using errcode = 'check_violation'; end if;
    v_offer_amt := oe.amount;
  end if;

  if coalesce(p_points, 0) < 0 then raise exception 'Enter a number of points.' using errcode = 'check_violation'; end if;
  if coalesce(p_points, 0) > 0 then
    if not coalesce((select value from settings where key = 'loyalty_redeem_enabled') = 'true'::jsonb, false) then
      raise exception 'Points cannot be spent right now.' using errcode = 'check_violation';
    end if;
    select coalesce(sum(points), 0) into v_bal from loyalty_transactions where user_id = p_user;
    if p_points > v_bal then raise exception 'You only have % points.', v_bal using errcode = 'check_violation'; end if;
    v_value := setting_num('loyalty_redeem_kes_per_point', 1)::int;
    select * into q from quote_stay(p_unit, p_in, p_out);
    v_cap := floor(greatest(0, q.nightly_total - v_code_amt - v_offer_amt) * setting_num('loyalty_redeem_max_percent', 50) / 100.0)::int;
    v_pts_amt := p_points * v_value;
    if v_pts_amt > v_cap then raise exception 'Points can cover at most KES % of this stay (% points).', v_cap, v_cap / v_value using errcode = 'check_violation'; end if;
  end if;

  b := create_booking(p_unit, p_in, p_out, p_guests, p_guest_name, p_guest_phone, p_guest_email, p_source, 'hold', v_code_amt + v_offer_amt + v_pts_amt, null, null, null);

  update bookings set customer_id = p_user where id = b.id returning * into b;
  update customer_profiles set guest_id = coalesce(guest_id, b.guest_id), phone = coalesce(phone, p_guest_phone)
    where user_id = p_user and not exists (select 1 from customer_profiles x where x.guest_id = b.guest_id and x.user_id <> p_user);

  if v_code_amt > 0 then insert into discount_redemptions(code_id, booking_id, amount) values (c.id, b.id, v_code_amt); end if;
  if v_offer_amt > 0 then
    if v_reward is null then
      insert into customer_rewards(user_id, offer_id, code, expires_at, note) values (p_user, v_offer, new_reward_code(), null, 'Claimed at checkout') returning id into v_reward;
    end if;
    insert into reward_redemptions(reward_id, user_id, offer_id, booking_id, amount) values (v_reward, p_user, v_offer, b.id, v_offer_amt);
    update customer_rewards set status = 'redeemed', booking_id = b.id where id = v_reward;
    perform log_customer_activity(p_user, 'reward_redeemed', o.name || ' (' || b.reference || ')');
  end if;
  if v_pts_amt > 0 then
    insert into loyalty_transactions(user_id, kind, points, booking_id, note) values (p_user, 'redeem', -p_points, b.id, 'Used on ' || b.reference);
    perform log_customer_activity(p_user, 'points_used', p_points::text || ' points (' || b.reference || ')');
  end if;
  perform log_customer_activity(p_user, 'booking_made', b.reference);
  return b;
end $$;
revoke execute on function create_booking_member(uuid,text,uuid,uuid,uuid,date,date,int,text,text,text,booking_source,int) from public, anon, authenticated;
grant execute on function create_booking_member(uuid,text,uuid,uuid,uuid,date,date,int,text,text,text,booking_source,int) to service_role;

-- A booking that falls through gives back its reward (as before) AND its points (once).
create or replace function trg_release_reward() returns trigger language plpgsql security definer set search_path = public as $$
declare rr record; v_pts int;
begin
  if new.status in ('cancelled','expired','no_show') and old.status is distinct from new.status then
    for rr in update reward_redemptions set released_at = now() where booking_id = new.id and released_at is null returning reward_id, user_id loop
      update customer_rewards set booking_id = null,
        status = case when expires_at is not null and expires_at < now() then 'expired' else 'available' end
        where id = rr.reward_id;
      perform log_customer_activity(rr.user_id, 'reward_released', new.reference);
    end loop;
    select -points into v_pts from loyalty_transactions where booking_id = new.id and kind = 'redeem';
    if v_pts is not null and v_pts > 0 and new.customer_id is not null then
      insert into loyalty_transactions(user_id, kind, points, booking_id, note) values (new.customer_id, 'reverse', v_pts, new.id, 'Points returned: ' || new.reference) on conflict do nothing;
      perform log_customer_activity(new.customer_id, 'points_returned', v_pts::text || ' points (' || new.reference || ')');
    end if;
  end if;
  return new;
end $$;

-- my_customer now says what a point is worth, so the account can show it.
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
    'points_redeem', jsonb_build_object('enabled', coalesce((select value from settings where key = 'loyalty_redeem_enabled') = 'true'::jsonb, false),
      'kes_per_point', setting_num('loyalty_redeem_kes_per_point', 1)::int, 'max_percent', setting_num('loyalty_redeem_max_percent', 50)::int),
    'next_tier', case when v_next.key is null then null else jsonb_build_object('key', v_next.key, 'name', v_next.name, 'stays_needed', greatest(0, v_next.min_completed_stays - v_stays), 'spend_needed', greatest(0, v_next.min_spend - v_spend)) end);
end $$;
grant execute on function my_customer() to authenticated;
