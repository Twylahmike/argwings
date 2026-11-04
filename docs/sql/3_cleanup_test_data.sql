-- RG Wings Stays SQL: 3 of 3, delete the E2E test property, its bookings and the test guest
-- Run in Supabase dashboard > SQL Editor of the project named bnb-system. CHECK THE PROJECT NAME (top-left) BEFORE PRESSING RUN.
-- Optional. Only touches rows for the property with slug e2e-test-property and the guest named E2E Test Guest.

-- SAFETY GUARD: stops this file unless this is the RG Wings booking project (has the booking tables, and is not a store).
do $guard$
begin
  if to_regclass('public.bookings') is null or to_regclass('public.units') is null or to_regclass('public.properties') is null then
    raise exception 'STOP: this project does not have the RG Wings booking tables. You are probably in the wrong project (check the name at the top-left: it should be bnb-system). Nothing was changed.';
  end if;
  if to_regclass('public.orders') is not null or to_regclass('public.products') is not null then
    raise exception 'STOP: this looks like a different app (a store with orders/products). Open the bnb-system project instead. Nothing was changed.';
  end if;
end
$guard$;

begin;
  delete from payments where booking_id in (select b.id from bookings b join properties p on p.id = b.property_id where p.slug = 'e2e-test-property');
  delete from message_log where property_id in (select id from properties where slug = 'e2e-test-property');
  delete from housekeeping_tasks where property_id in (select id from properties where slug = 'e2e-test-property');
  delete from bookings where property_id in (select id from properties where slug = 'e2e-test-property');
  delete from guests where full_name = 'E2E Test Guest';
  delete from units where property_id in (select id from properties where slug = 'e2e-test-property');
  delete from properties where slug = 'e2e-test-property';
commit;
