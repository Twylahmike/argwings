-- apply_pending.sql: paste into the Supabase SQL Editor of project "bnb-system" (ref bxpgpzrtoxjmynyjnfkg) and press Run.
-- PART 6 of 6: migrations 0028 to 0028. Run the parts in order.
-- Stops without changes if this is the wrong project or migration 0008 is missing.
do $apply$
begin
  if to_regclass('public.bookings') is null then
    raise exception 'STOP: this is not the RG Wings project (no bookings table). Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='units' and column_name='maintenance_status') then
    raise exception 'STOP: apply migration 0008 first. Nothing was changed.';
  end if;
  if to_regclass('public.user_permission_overrides') is null then
    execute $m0028$
-- 0028_permission_overrides.sql
-- Per-person exceptions on top of their team role: allow one extra permission or block one, without inventing a whole new role.
-- An override always wins over the role, except that an owner can never be blocked, and nobody can grant a permission they do not
-- hold themselves.

create table user_permission_overrides (
  user_id uuid not null references profiles on delete cascade,
  permission_key text not null references permissions_catalog on delete cascade,
  granted boolean not null,
  set_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, permission_key)
);
alter table user_permission_overrides enable row level security;
revoke all on user_permission_overrides from anon;
revoke insert, update, delete on user_permission_overrides from authenticated;      -- changes go through set_user_permission only
create policy overrides_read on user_permission_overrides for select to authenticated
  using (user_id = (select auth.uid()) or has_permission((select auth.uid()), 'users.manage'));

create or replace function has_permission(_uid uuid, _perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when _uid is null then false
    when not exists (select 1 from profiles p where p.id = _uid and p.active) then false
    when has_role(_uid, 'owner') then true
    when exists (select 1 from user_permission_overrides o where o.user_id = _uid and o.permission_key = _perm) then
      (select o.granted from user_permission_overrides o where o.user_id = _uid and o.permission_key = _perm)
    else exists (
      select 1 from team_role_permissions rp
      where rp.permission_key = _perm
        and rp.role_id = coalesce(
          (select p.team_role_id from profiles p where p.id = _uid),
          (select tr.id from team_roles tr where tr.default_for = case when has_role(_uid, 'manager') then 'manager'::app_role when has_role(_uid, 'cleaner') then 'cleaner'::app_role end)))
  end
$$;

-- p_state: 'grant' | 'deny' | 'inherit' (remove the exception)
create or replace function set_user_permission(p_user uuid, p_perm text, p_state text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid());
begin
  perform require_permission('users.manage');
  if p_user = v_uid then raise exception 'You cannot change your own permissions.' using errcode = 'check_violation'; end if;
  if has_role(p_user, 'owner') then raise exception 'Owners always have every permission.' using errcode = 'check_violation'; end if;
  if not exists (select 1 from permissions_catalog where key = p_perm) then raise exception 'Unknown permission.' using errcode = 'check_violation'; end if;
  if p_state not in ('grant','deny','inherit') then raise exception 'Choose allow, block or role default.' using errcode = 'check_violation'; end if;
  if p_state = 'grant' and not has_permission(v_uid, p_perm) then raise exception 'You cannot grant a permission you do not have yourself.' using errcode = '42501'; end if;
  if p_state = 'inherit' then
    delete from user_permission_overrides where user_id = p_user and permission_key = p_perm;
  else
    insert into user_permission_overrides(user_id, permission_key, granted, set_by) values (p_user, p_perm, p_state = 'grant', v_uid)
      on conflict (user_id, permission_key) do update set granted = excluded.granted, set_by = excluded.set_by, created_at = now();
  end if;
  insert into audit_log(user_id, action, entity, entity_id, diff) values (v_uid, 'staff.permission_override', 'staff', p_user::text, jsonb_build_object('permission', p_perm, 'state', p_state));
end $$;
grant execute on function set_user_permission(uuid, text, text) to authenticated;

$m0028$;
    raise notice 'Applied 0028';
  else
    raise notice '0028 already applied, skipped';
  end if;
end
$apply$;
