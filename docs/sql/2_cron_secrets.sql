-- RG Wings Stays SQL: 2 of 3, secrets for the scheduled jobs (safe to run more than once)
-- Run in Supabase dashboard > SQL Editor of the project named bnb-system, in a NEW empty query tab.
-- CHECK THE PROJECT NAME (top-left) BEFORE PRESSING RUN.
-- Replace ONLY the text PASTE-YOUR-REAL-SERVICE-ROLE-KEY-HERE with your service_role key
-- (Project Settings > API Keys > service_role, the long secret one). Never share it or commit it.

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

do $secrets$
declare
  v_url  constant text := 'https://bxpgpzrtoxjmynyjnfkg.supabase.co';
  v_key  constant text := 'PASTE-YOUR-REAL-SERVICE-ROLE-KEY-HERE';
  v_id   uuid;
begin
  if v_key like 'PASTE-%' or length(v_key) < 40 then
    raise exception 'STOP: you have not pasted your real service_role key yet. Nothing was changed.';
  end if;

  select id into v_id from vault.secrets where name = 'functions_base_url';
  if v_id is null then perform vault.create_secret(v_url, 'functions_base_url');
  else perform vault.update_secret(v_id, v_url); end if;

  select id into v_id from vault.secrets where name = 'service_role_key';
  if v_id is null then perform vault.create_secret(v_key, 'service_role_key');
  else perform vault.update_secret(v_id, v_key); end if;
end
$secrets$;

-- Check (does not show the key): both should say true.
select name,
  case when name = 'functions_base_url' then decrypted_secret = 'https://bxpgpzrtoxjmynyjnfkg.supabase.co'
       else length(decrypted_secret) > 40 and decrypted_secret not like 'PASTE-%' end as looks_right
from vault.decrypted_secrets where name in ('functions_base_url', 'service_role_key');
