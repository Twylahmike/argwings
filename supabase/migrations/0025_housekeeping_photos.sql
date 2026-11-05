-- 0025_housekeeping_photos.sql
-- Photos on cleaning tasks (damage, a finished room), added by the person doing the task or a manager. Append-only.
-- Floor staff may upload into the "housekeeping/" folder of the public image bucket (nowhere else).

create table housekeeping_task_photos (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references housekeeping_tasks on delete cascade,
  url text not null check (url ~ '^https://'),
  caption text check (caption is null or char_length(caption) <= 200),
  created_by uuid not null references profiles on delete restrict,
  created_at timestamptz not null default now()
);
create index on housekeeping_task_photos (task_id, created_at);
alter table housekeeping_task_photos enable row level security;
revoke all on housekeeping_task_photos from anon;
revoke update, delete on housekeeping_task_photos from authenticated;

-- Seen by anyone who can see the task; added by its assignee (or a manager of the property).
create policy hk_photos_read on housekeeping_task_photos for select to authenticated
  using (exists (select 1 from housekeeping_tasks t where t.id = task_id and can_access_property((select auth.uid()), t.property_id)
                 and (can_manage_property((select auth.uid()), t.property_id) or t.assigned_to = (select auth.uid()) or t.assigned_to is null)));
create policy hk_photos_insert on housekeeping_task_photos for insert to authenticated
  with check (created_by = (select auth.uid()) and has_permission((select auth.uid()), 'housekeeping.update')
              and exists (select 1 from housekeeping_tasks t where t.id = task_id and can_access_property((select auth.uid()), t.property_id)
                          and (can_manage_property((select auth.uid()), t.property_id) or t.assigned_to = (select auth.uid()))));

do $$ begin
  if to_regclass('storage.buckets') is not null then
    drop policy if exists "housekeeping photos staff write" on storage.objects;
    create policy "housekeeping photos staff write" on storage.objects for insert to authenticated
      with check (bucket_id = 'property-images' and name like 'housekeeping/%' and public.is_staff(auth.uid()));
  end if;
end $$;
