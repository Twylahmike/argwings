-- RG Wings Stays SQL: 2 of 3, secrets for the scheduled jobs
-- Run in Supabase dashboard > SQL Editor of the project named bnb-system. CHECK THE PROJECT NAME (top-left) BEFORE PRESSING RUN.
-- Replace BOTH values below, then run. service_role key: Project Settings > API Keys. Never share it.

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

select vault.create_secret('https://bxpgpzrtoxjmynyjnfkg.supabase.co', 'functions_base_url');
select vault.create_secret('PASTE-SERVICE-ROLE-KEY-HERE', 'service_role_key');
