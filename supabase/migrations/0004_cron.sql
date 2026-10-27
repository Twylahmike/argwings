-- 0004_cron.sql: scheduled jobs. Requires the pg_cron and pg_net extensions (enabled by default on Supabase;
-- enable them under Database > Extensions on a fresh project). Skipped silently where they are unavailable
-- (plain Postgres in the SQL test runner).
--
-- The edge-function jobs read two Vault secrets that DEPLOY.md tells you to create once:
--   select vault.create_secret('https://<project-ref>.supabase.co', 'functions_base_url');
--   select vault.create_secret('<service role key>',               'service_role_key');

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then

    create extension if not exists pg_cron;
    create extension if not exists pg_net;

    create or replace function public.invoke_edge_function(p_name text) returns void
    language plpgsql security definer set search_path = public as $fn$
    declare v_base text; v_key text;
    begin
      select decrypted_secret into v_base from vault.decrypted_secrets where name = 'functions_base_url' limit 1;
      select decrypted_secret into v_key  from vault.decrypted_secrets where name = 'service_role_key'  limit 1;
      if v_base is null or v_key is null then
        raise warning 'invoke_edge_function(%): vault secrets functions_base_url / service_role_key are not set', p_name;
        return;
      end if;
      perform net.http_post(
        url := v_base || '/functions/v1/' || p_name,
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
        body := '{}'::jsonb);
    end $fn$;
    revoke execute on function public.invoke_edge_function(text) from public, anon, authenticated;

    -- Idempotent re-scheduling
    perform cron.unschedule(jobid) from cron.job where jobname in ('bnb-expire-holds','bnb-send-reminders','bnb-mpesa-reconcile');

    -- Every minute: free unpaid holds. Calls the SQL function directly (the expire-holds edge function
    -- does the same thing and exists for manual / external triggering).
    perform cron.schedule('bnb-expire-holds', '* * * * *', 'select public.expire_stale_holds()');
    -- Daily 08:00 Africa/Nairobi (UTC+3, no DST) = 05:00 UTC
    perform cron.schedule('bnb-send-reminders', '0 5 * * *', $c$select public.invoke_edge_function('send-reminders')$c$);
    -- Every 2 minutes: settle STK pushes whose callback never arrived
    perform cron.schedule('bnb-mpesa-reconcile', '*/2 * * * *', $c$select public.invoke_edge_function('mpesa-reconcile')$c$);
  else
    raise notice 'pg_cron / pg_net not available: skipping cron jobs (see DEPLOY.md)';
  end if;
end $$;
