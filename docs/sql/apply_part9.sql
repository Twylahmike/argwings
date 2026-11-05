-- apply_pending.sql: paste into the Supabase SQL Editor of project "bnb-system" (ref bxpgpzrtoxjmynyjnfkg) and press Run.
-- PART 9 of 11: migrations 0031 to 0031. Run the parts in order.
-- Stops without changes if this is the wrong project or migration 0008 is missing.
do $apply$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'STOP: this is not the RG Wings project (no bookings table). Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='units' and column_name='maintenance_status') then
    raise exception 'STOP: apply migration 0008 first. Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='customer_profiles' and column_name='anonymised_at') then
    execute $m0031$
-- 0031_customer_privacy.sql
-- Privacy tools for members (Kenya Data Protection Act): download my data, ask for my account to be deleted.
-- Staff with customers.manage can then anonymise the profile. Anonymising removes the personal details but keeps the numbers:
-- bookings, payments and redemptions stay in the books (financial records are never deleted).

alter table customer_profiles add column anonymised_at timestamptz;

-- Everything we hold about the signed-in member, as one JSON document. Read-only; works from auth.uid().
create or replace function my_data_export() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); cp customer_profiles;
begin
  select * into cp from customer_profiles where user_id = v_uid;
  if cp.user_id is null then raise exception 'No membership found.' using errcode = 'no_data_found'; end if;
  return jsonb_build_object(
    'exported_at', now(),
    'profile', jsonb_build_object('full_name', cp.full_name, 'email', cp.email, 'phone', cp.phone, 'country', cp.country, 'birthday', cp.birthday,
      'membership_tier', cp.tier_key, 'status', cp.status, 'marketing_emails', cp.marketing_opt_in, 'member_since', cp.created_at),
    'bookings', my_bookings(),
    'rewards', my_rewards(),
    'loyalty', coalesce((select jsonb_agg(jsonb_build_object('when', created_at, 'type', kind, 'points', points, 'note', note) order by created_at) from loyalty_transactions where user_id = v_uid), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('when', created_at, 'type', kind, 'message', message, 'status', status) order by created_at) from customer_booking_requests where user_id = v_uid), '[]'::jsonb),
    'activity', coalesce((select jsonb_agg(jsonb_build_object('when', created_at, 'event', kind, 'detail', detail) order by created_at) from customer_activity where user_id = v_uid), '[]'::jsonb));
end $$;
grant execute on function my_data_export() to authenticated;

-- The member asks for their account to be deleted. Staff are notified; nothing is removed until staff act.
create or replace function request_account_deletion(p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); cp customer_profiles;
begin
  select * into cp from customer_profiles where user_id = v_uid and anonymised_at is null;
  if cp.user_id is null then raise exception 'No membership found.' using errcode = 'no_data_found'; end if;
  insert into notifications(kind, title, body, link, entity_id)
    values ('customer_request', 'Account deletion request: ' || cp.full_name, left(coalesce(nullif(trim(p_reason), ''), 'No reason given.'), 200), '/admin/customers', v_uid)
    on conflict do nothing;
  perform log_customer_activity(v_uid, 'deletion_requested', nullif(left(trim(coalesce(p_reason, '')), 200), ''));
end $$;
grant execute on function request_account_deletion(text) to authenticated;

-- Staff: remove the personal details of a member. Keeps bookings, payments, redemptions and points (as numbers) for the records.
-- The sign-in (Supabase Auth user) is not touched here: remove it in Authentication > Users if the person should not be able to sign in.
create or replace function anonymise_customer(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare cp customer_profiles;
begin
  perform require_permission('customers.manage');
  select * into cp from customer_profiles where user_id = p_user for update;
  if cp.user_id is null then raise exception 'Customer not found.' using errcode = 'no_data_found'; end if;
  if cp.anonymised_at is not null then return; end if;
  update customer_profiles set full_name = 'Former member', email = 'removed-' || replace(p_user::text, '-', '') || '@removed.invalid', phone = null, country = null,
    birthday = null, guest_id = null, status = 'suspended', suspended_reason = 'Account removed at the member''s request', marketing_opt_in = false,
    tier_override = true, anonymised_at = now() where user_id = p_user;
  perform log_customer_activity(p_user, 'anonymised', 'Personal details removed by staff');
end $$;
grant execute on function anonymise_customer(uuid) to authenticated;

$m0031$;
    raise notice 'Applied 0031';
  else
    raise notice '0031 already applied, skipped';
  end if;
end
$apply$;
