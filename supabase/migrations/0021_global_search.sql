-- 0021_global_search.sql
-- One search box for the admin header. SECURITY INVOKER, so every result is limited by the caller's own row-level access
-- (a manager only finds records from their properties; housekeeping finds nothing about guests or money).

create or replace function global_search(p_q text) returns jsonb
language plpgsql stable security invoker as $$
declare
  q text := trim(coalesce(p_q, '')); pat text; digits text; v_book jsonb; v_guest jsonb; v_room jsonb; v_inq jsonb; v_tick jsonb;
begin
  if char_length(q) < 2 then return jsonb_build_object('bookings', '[]'::jsonb, 'guests', '[]'::jsonb, 'rooms', '[]'::jsonb, 'inquiries', '[]'::jsonb, 'tickets', '[]'::jsonb); end if;
  if char_length(q) > 60 then q := left(q, 60); end if;
  pat := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  digits := regexp_replace(q, '\D', '', 'g');
  if digits like '0%' then digits := '254' || substr(digits, 2); end if;

  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_book from (
    select jsonb_build_object('id', b.id, 'reference', b.reference, 'guest', g.full_name, 'status', b.status, 'check_in', b.check_in) x
    from bookings b left join guests g on g.id = b.guest_id
    where b.status <> 'blocked' and (b.reference ilike pat or g.full_name ilike pat or (char_length(digits) >= 4 and g.phone like '%' || digits || '%'))
    order by b.created_at desc limit 6) t;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_guest from (
    select jsonb_build_object('id', g.id, 'name', g.full_name, 'phone', g.phone) x from guests g
    where g.anonymised_at is null and (g.full_name ilike pat or g.email ilike pat or (char_length(digits) >= 4 and g.phone like '%' || digits || '%'))
    order by g.full_name limit 6) t;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_room from (
    select jsonb_build_object('id', u.id, 'name', u.name, 'property', p.name, 'property_id', p.id) x
    from units u join properties p on p.id = u.property_id
    where (u.name ilike pat or p.name ilike pat) and can_manage_property((select auth.uid()), p.id)
    order by p.name, u.name limit 6) t;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_inq from (
    select jsonb_build_object('id', i.id, 'name', i.name, 'status', i.status) x from inquiries i
    where i.name ilike pat or i.message ilike pat or (char_length(digits) >= 4 and i.phone like '%' || digits || '%')
    order by i.created_at desc limit 5) t;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_tick from (
    select jsonb_build_object('id', s.id, 'ticket_no', s.ticket_no, 'subject', s.subject, 'status', s.status) x from support_tickets s
    where s.subject ilike pat or (q ~ '^#?\d+$' and s.ticket_no = regexp_replace(q, '\D', '', 'g')::int)
    order by s.created_at desc limit 5) t;
  return jsonb_build_object('bookings', v_book, 'guests', v_guest, 'rooms', v_room, 'inquiries', v_inq, 'tickets', v_tick);
end $$;
grant execute on function global_search(text) to authenticated;
