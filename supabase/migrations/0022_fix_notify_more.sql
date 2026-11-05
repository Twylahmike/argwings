-- 0022_fix_notify_more.sql
-- Fixes trg_notify_more (0019). It was one if/elsif chain whose last branch read NEW.verified; PL/pgSQL resolves that field
-- when the branch is reached, so any message_log row that was not already 'failed' (e.g. the 'queued' row written before every
-- WhatsApp send) raised "record new has no field verified" and the insert was rejected. Each table now gets its own block.

create or replace function trg_notify_more() returns trigger language plpgsql security definer set search_path = public as $$
declare v_unit text;
begin
  if tg_table_name = 'maintenance_requests' then
    if tg_op = 'INSERT' then
      perform add_notification('maintenance', 'Maintenance: ' || new.title, new.priority || ' priority', '/admin/maintenance', new.property_id, new.id);
    end if;
  elsif tg_table_name = 'housekeeping_tasks' then
    if tg_op = 'INSERT' then
      select name into v_unit from units where id = new.unit_id;
      perform add_notification('housekeeping', 'Room to clean: ' || coalesce(v_unit, ''), case when new.priority then 'Same-day turnover' else null end, '/admin/housekeeping', new.property_id, new.id);
    end if;
  elsif tg_table_name = 'support_tickets' then
    if tg_op = 'INSERT' then
      perform add_notification('ticket', 'Ticket #' || new.ticket_no || ': ' || new.subject, new.priority || ' priority', '/admin/support', new.property_id, new.id);
    end if;
  elsif tg_table_name = 'message_log' then
    if new.status = 'failed' and (tg_op = 'INSERT' or old.status is distinct from 'failed') then
      perform add_notification('message_failed', 'Message not delivered', left(coalesce(new.error, 'Delivery failed'), 140), '/admin/messages', new.property_id, new.id);
    end if;
  elsif tg_table_name = 'payments' then
    if tg_op = 'INSERT' and new.status = 'succeeded' and not new.verified then
      perform add_notification('payment_verify', 'Payment to verify: KES ' || to_char(new.amount, 'FM999,999,999'), new.method::text, '/admin/finance', (select property_id from bookings where id = new.booking_id), new.id);
    end if;
  end if;
  return null;
end $$;
