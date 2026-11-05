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
