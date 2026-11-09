-- 0033_app_install.sql
-- App installation invitation: owner-editable text (settings key app_install) and honest, anonymous analytics.
-- What is counted: how often the invitation was shown, how often the install button was pressed, what the browser's own prompt answered,
-- and when the browser reported the app installed (the appinstalled event; iPhone and iPad never report it). Nothing identifies a person:
-- the visitor id is a random value kept only in memory for one page view.

drop policy if exists settings_public_read on settings;
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes',
                 'mpesa_manual_instructions','mpesa_paybill_display','brand_color','site_content','booking_mode',
                 'business_email','business_address','currency','maintenance_mode','guest_checkout_enabled','registration_enabled','app_install'));

create table app_install_events (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('impression','click','accepted','declined','installed','app_open','ios_instructions')),
  platform text not null check (platform ~ '^[a-z0-9_-]{1,30}$'),
  visit text not null check (char_length(visit) between 8 and 40),
  created_at timestamptz not null default now()
);
create index on app_install_events (created_at desc);
create index on app_install_events (kind, created_at desc);
alter table app_install_events enable row level security;
revoke all on app_install_events from anon, authenticated;     -- written only by record_install_event, read only by app_install_stats

-- Public, throttled. One row per (visit, kind) at most, so a script cannot inflate a number by repeating a call.
create or replace function record_install_event(p_kind text, p_platform text, p_visit text) returns void
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_kind not in ('impression','click','accepted','declined','installed','app_open','ios_instructions') then return; end if;
  if p_platform !~ '^[a-z0-9_-]{1,30}$' or char_length(coalesce(p_visit, '')) not between 8 and 40 then return; end if;
  if exists (select 1 from app_install_events where visit = p_visit and kind = p_kind) and p_kind <> 'click' then return; end if;
  select count(*) into n from rate_limit_events where key = 'app-install:all' and created_at > now() - interval '1 hour';
  if n >= 5000 then return; end if;
  insert into rate_limit_events(key) values ('app-install:all');
  insert into app_install_events(kind, platform, visit) values (p_kind, p_platform, p_visit);
end $$;
grant execute on function record_install_event(text, text, text) to anon, authenticated;

create or replace function app_install_stats(p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_since timestamptz := now() - make_interval(days => least(greatest(p_days, 1), 365));
begin
  if not (has_role((select auth.uid()), 'owner') or has_permission((select auth.uid()), 'settings.manage')) then
    raise exception 'You do not have permission to do this.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'since', v_since,
    'impressions', (select count(*) from app_install_events where kind = 'impression' and created_at >= v_since),
    'clicks', (select count(*) from app_install_events where kind = 'click' and created_at >= v_since),
    'accepted', (select count(*) from app_install_events where kind = 'accepted' and created_at >= v_since),
    'declined', (select count(*) from app_install_events where kind = 'declined' and created_at >= v_since),
    'installed', (select count(*) from app_install_events where kind = 'installed' and created_at >= v_since),
    'ios_instructions', (select count(*) from app_install_events where kind = 'ios_instructions' and created_at >= v_since),
    'app_opens', (select count(*) from app_install_events where kind = 'app_open' and created_at >= v_since),
    'by_platform', coalesce((select jsonb_agg(jsonb_build_object('platform', platform, 'impressions', i, 'clicks', c, 'installed', n) order by i desc)
        from (select platform, count(*) filter (where kind = 'impression') i, count(*) filter (where kind = 'click') c, count(*) filter (where kind = 'installed') n
              from app_install_events where created_at >= v_since group by platform) s), '[]'::jsonb));
end $$;
grant execute on function app_install_stats(int) to authenticated;
