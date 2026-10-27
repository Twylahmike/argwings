-- 0003_rls.sql: Row Level Security on EVERY table. UI hiding is never the security layer.
-- Matrix (see build spec 5.3). Deactivated users have no roles (see has_role), so they match nothing here.

alter table profiles           enable row level security;
alter table user_roles         enable row level security;
alter table properties         enable row level security;
alter table staff_properties   enable row level security;
alter table units              enable row level security;
alter table rate_overrides     enable row level security;
alter table guests             enable row level security;
alter table bookings           enable row level security;
alter table payments           enable row level security;
alter table housekeeping_tasks enable row level security;
alter table expenses           enable row level security;
alter table message_log        enable row level security;
alter table settings           enable row level security;
alter table audit_log          enable row level security;
alter table rate_limit_events  enable row level security;

-- Defence in depth: anon can never touch sensitive tables even if a policy is added by mistake.
revoke all on profiles, user_roles, staff_properties, rate_overrides, guests, bookings, payments,
              housekeeping_tasks, expenses, message_log, audit_log, rate_limit_events from anon;
revoke all on rate_limit_events from authenticated;
revoke update, delete, insert on audit_log from authenticated;   -- audit rows are written by security-definer triggers only

-- ---- properties / units / rate_overrides ----------------------------------
create policy properties_public_read on properties for select to anon, authenticated using (active);
create policy properties_staff_read  on properties for select to authenticated using (can_access_property((select auth.uid()), id));
create policy properties_manager_update on properties for update to authenticated
  using (can_manage_property((select auth.uid()), id)) with check (can_manage_property((select auth.uid()), id));
create policy properties_owner_insert on properties for insert to authenticated with check (has_role((select auth.uid()),'owner'));
create policy properties_owner_delete on properties for delete to authenticated using (has_role((select auth.uid()),'owner'));

create policy units_public_read on units for select to anon, authenticated using (active);
create policy units_staff_read  on units for select to authenticated using (can_access_property((select auth.uid()), property_id));
create policy units_manager_write on units for insert to authenticated with check (can_manage_property((select auth.uid()), property_id));
create policy units_manager_update on units for update to authenticated
  using (can_manage_property((select auth.uid()), property_id)) with check (can_manage_property((select auth.uid()), property_id));
create policy units_owner_delete on units for delete to authenticated using (has_role((select auth.uid()),'owner'));

create policy overrides_staff_read on rate_overrides for select to authenticated
  using (exists (select 1 from units u where u.id = unit_id and can_access_property((select auth.uid()), u.property_id)));
create policy overrides_manager_write on rate_overrides for all to authenticated
  using (exists (select 1 from units u where u.id = unit_id and can_manage_property((select auth.uid()), u.property_id)))
  with check (exists (select 1 from units u where u.id = unit_id and can_manage_property((select auth.uid()), u.property_id)));

-- ---- bookings (staff only; guests use RPCs / edge functions) --------------
create policy bookings_manager_all on bookings for all to authenticated
  using (can_manage_property((select auth.uid()), property_id))
  with check (can_manage_property((select auth.uid()), property_id));

-- ---- guests ----------------------------------------------------------------
create policy guests_owner_all on guests for all to authenticated
  using (has_role((select auth.uid()),'owner')) with check (has_role((select auth.uid()),'owner'));
create policy guests_manager_read on guests for select to authenticated
  using (has_role((select auth.uid()),'manager')
         and exists (select 1 from bookings b where b.guest_id = guests.id and can_manage_property((select auth.uid()), b.property_id)));
create policy guests_manager_update on guests for update to authenticated
  using (has_role((select auth.uid()),'manager')
         and exists (select 1 from bookings b where b.guest_id = guests.id and can_manage_property((select auth.uid()), b.property_id)))
  with check (has_role((select auth.uid()),'manager'));

-- ---- payments ---------------------------------------------------------------
create policy payments_manager_read on payments for select to authenticated
  using (exists (select 1 from bookings b where b.id = booking_id and can_manage_property((select auth.uid()), b.property_id)));
-- Managers record MANUAL payments only (cash / bank / manual M-Pesa). STK rows are written by edge functions.
create policy payments_manager_insert on payments for insert to authenticated
  with check (method <> 'mpesa_stk' and status = 'succeeded' and recorded_by = (select auth.uid())
              and exists (select 1 from bookings b where b.id = booking_id and can_manage_property((select auth.uid()), b.property_id)));
create policy payments_owner_all on payments for all to authenticated
  using (has_role((select auth.uid()),'owner')) with check (has_role((select auth.uid()),'owner'));

-- ---- housekeeping -----------------------------------------------------------
create policy hk_manager_all on housekeeping_tasks for all to authenticated
  using (can_manage_property((select auth.uid()), property_id))
  with check (can_manage_property((select auth.uid()), property_id));
-- Cleaners: tasks at their properties that are theirs or unclaimed. Column limits are enforced by guard_hk_update().
create policy hk_cleaner_read on housekeeping_tasks for select to authenticated
  using (has_role((select auth.uid()),'cleaner') and can_access_property((select auth.uid()), property_id)
         and (assigned_to = (select auth.uid()) or assigned_to is null));
create policy hk_cleaner_update on housekeeping_tasks for update to authenticated
  using (has_role((select auth.uid()),'cleaner') and can_access_property((select auth.uid()), property_id)
         and (assigned_to = (select auth.uid()) or assigned_to is null))
  with check (has_role((select auth.uid()),'cleaner') and can_access_property((select auth.uid()), property_id));

-- ---- expenses (managers cannot delete; they void) ---------------------------
create policy expenses_manager_read on expenses for select to authenticated using (can_manage_property((select auth.uid()), property_id));
create policy expenses_manager_insert on expenses for insert to authenticated with check (can_manage_property((select auth.uid()), property_id));
create policy expenses_manager_update on expenses for update to authenticated
  using (can_manage_property((select auth.uid()), property_id)) with check (can_manage_property((select auth.uid()), property_id));
create policy expenses_owner_delete on expenses for delete to authenticated using (has_role((select auth.uid()),'owner'));

-- ---- message_log -------------------------------------------------------------
create policy messages_manager_read on message_log for select to authenticated
  using (property_id is not null and can_manage_property((select auth.uid()), property_id));
create policy messages_owner_all on message_log for all to authenticated
  using (has_role((select auth.uid()),'owner')) with check (has_role((select auth.uid()),'owner'));
-- Managers may queue a custom message for their own properties (sent by the send-whatsapp function).
create policy messages_manager_insert on message_log for insert to authenticated
  with check (property_id is not null and can_manage_property((select auth.uid()), property_id));

-- ---- settings ----------------------------------------------------------------
create policy settings_public_read on settings for select to anon, authenticated
  using (key in ('business_name','cancellation_policy','logo_url','support_whatsapp','deposit_percent','hold_minutes','mpesa_manual_instructions','mpesa_paybill_display'));
create policy settings_manager_read on settings for select to authenticated
  using (has_role((select auth.uid()),'owner') or has_role((select auth.uid()),'manager'));
create policy settings_owner_write on settings for all to authenticated
  using (has_role((select auth.uid()),'owner')) with check (has_role((select auth.uid()),'owner'));

-- ---- profiles / roles / staff_properties --------------------------------------
create policy profiles_self_read on profiles for select to authenticated using (id = (select auth.uid()));
create policy profiles_manager_read on profiles for select to authenticated
  using (has_role((select auth.uid()),'owner') or has_role((select auth.uid()),'manager'));
create policy profiles_owner_all on profiles for all to authenticated
  using (has_role((select auth.uid()),'owner')) with check (has_role((select auth.uid()),'owner'));

create policy roles_self_read on user_roles for select to authenticated using (user_id = (select auth.uid()));
create policy roles_manager_read on user_roles for select to authenticated
  using (has_role((select auth.uid()),'owner') or has_role((select auth.uid()),'manager'));
create policy roles_owner_all on user_roles for all to authenticated
  using (has_role((select auth.uid()),'owner')) with check (has_role((select auth.uid()),'owner'));

create policy staffprops_self_read on staff_properties for select to authenticated using (user_id = (select auth.uid()));
create policy staffprops_manager_read on staff_properties for select to authenticated
  using (has_role((select auth.uid()),'owner') or has_role((select auth.uid()),'manager'));
create policy staffprops_owner_all on staff_properties for all to authenticated
  using (has_role((select auth.uid()),'owner')) with check (has_role((select auth.uid()),'owner'));

-- ---- audit_log: owner read only -------------------------------------------------
create policy audit_owner_read on audit_log for select to authenticated using (has_role((select auth.uid()),'owner'));

-- rate_limit_events: RLS on, no policies => only the service role can touch it.

-- ---------------------------------------------------------------------------
-- Realtime (dashboard / calendar refresh). RLS still applies to realtime events.
-- ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table bookings, payments, housekeeping_tasks;
  end if;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Storage buckets + policies (skipped automatically when the storage schema does not exist)
-- ---------------------------------------------------------------------------
do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values
      ('property-images', 'property-images', true),
      ('expense-receipts', 'expense-receipts', false)
    on conflict (id) do nothing;

    drop policy if exists "property images public read" on storage.objects;
    create policy "property images public read" on storage.objects for select
      using (bucket_id = 'property-images');

    drop policy if exists "property images staff write" on storage.objects;
    create policy "property images staff write" on storage.objects for insert to authenticated
      with check (bucket_id = 'property-images' and (public.has_role(auth.uid(),'owner') or public.has_role(auth.uid(),'manager')));
    drop policy if exists "property images staff update" on storage.objects;
    create policy "property images staff update" on storage.objects for update to authenticated
      using (bucket_id = 'property-images' and (public.has_role(auth.uid(),'owner') or public.has_role(auth.uid(),'manager')));
    drop policy if exists "property images staff delete" on storage.objects;
    create policy "property images staff delete" on storage.objects for delete to authenticated
      using (bucket_id = 'property-images' and (public.has_role(auth.uid(),'owner') or public.has_role(auth.uid(),'manager')));

    drop policy if exists "receipts staff read" on storage.objects;
    create policy "receipts staff read" on storage.objects for select to authenticated
      using (bucket_id = 'expense-receipts' and (public.has_role(auth.uid(),'owner') or public.has_role(auth.uid(),'manager')));
    drop policy if exists "receipts staff write" on storage.objects;
    create policy "receipts staff write" on storage.objects for insert to authenticated
      with check (bucket_id = 'expense-receipts' and (public.has_role(auth.uid(),'owner') or public.has_role(auth.uid(),'manager')));
    drop policy if exists "receipts staff update" on storage.objects;
    create policy "receipts staff update" on storage.objects for update to authenticated
      using (bucket_id = 'expense-receipts' and (public.has_role(auth.uid(),'owner') or public.has_role(auth.uid(),'manager')));
    drop policy if exists "receipts owner delete" on storage.objects;
    create policy "receipts owner delete" on storage.objects for delete to authenticated
      using (bucket_id = 'expense-receipts' and public.has_role(auth.uid(),'owner'));
  end if;
end $$;
