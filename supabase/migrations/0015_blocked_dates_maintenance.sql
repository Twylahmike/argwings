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
