-- seed.sql: demo data. Re-runnable (it replaces its own rows). Everything here is a PLACEHOLDER:
-- rename properties, replace images and phone numbers from Admin > Properties.
-- Dates are relative to "today in Nairobi" so the demo always looks current.

do $seed$
declare
  today date := nairobi_today();
  v_props text[][] := array[
    ['kilimani-nest','Kilimani Nest','Quiet studios near Yaya Centre','Kilimani','kilimani'],
    ['westlands-loft','Westlands Loft','City-view lofts, minutes from Sarit','Westlands','westlands'],
    ['karen-garden-cottage','Karen Garden Cottage','A green escape with a private garden','Karen','karen'],
    ['lavington-suites','Lavington Suites','Self-contained suites in leafy Lavington','Lavington','lavington'],
    ['runda-retreat','Runda Retreat','Spacious family stays in Runda','Runda','runda']];
  v_units text[][] := array[
    -- property slug, code, name, type, max_guests, bedrooms, base, weekend, cleaning, min_nights
    ['kilimani-nest','K1','Studio A','studio','2','1','4500','5500','500','1'],
    ['kilimani-nest','K2','Studio B','studio','2','1','4500','5500','500','1'],
    ['kilimani-nest','K3','Deluxe 1 Bedroom','1BR','3','1','6500','7500','800','1'],
    ['westlands-loft','W1','Loft 1 Bedroom','1BR','3','1','6000','7500','1000','1'],
    ['westlands-loft','W2','Loft 2 Bedroom','2BR','4','2','8000','9000','1200','1'],
    ['westlands-loft','W3','City Studio','studio','2','1','3500','4200','500','1'],
    ['karen-garden-cottage','C1','Garden Cottage','house','4','2','7500','9000','1200','2'],
    ['karen-garden-cottage','C2','Garden Room','room','2','1','3000','3500','400','1'],
    ['lavington-suites','L1','Suite 1','1BR','2','1','5500','6500','700','1'],
    ['lavington-suites','L2','Suite 2','1BR','2','1','5500','6500','700','1'],
    ['lavington-suites','L3','Suite 3','1BR','3','1','6000','7000','700','1'],
    ['lavington-suites','L4','Single Room','room','1','1','2500','2800','300','1'],
    ['runda-retreat','R1','Villa Room','room','2','1','4000','5000','500','1'],
    ['runda-retreat','R2','Family House','house','6','3','9000','9000','1500','2']];
  guest_names text[] := array['Wanjiru Kamau','Brian Otieno','Amina Hassan','Peter Mwangi','Grace Achieng','Daniel Kiptoo',
    'Faith Njeri','Samuel Ochieng','Mercy Wambui','John Kariuki','Lilian Chebet','Kevin Mutua','Esther Akinyi','David Maina','Joyce Naliaka'];
  cats text[] := array['utilities','cleaning','repairs','staff','internet','supplies','marketing','other'];
  p int; u int; k int; g int; i int; idx int := 0;
  v_prop uuid; v_unit uuid; v_guest uuid; v_in date; v_out date; v_len int; v_status booking_status;
  q record; b_id uuid; v_h int; v_total int; v_dep int; v_paid_full boolean; v_ref text; v_amount int;
  v_first_unit uuid; v_year int;
begin
  -- clean previous seed rows (payments cascade; tasks and overrides are tagged)
  delete from bookings where reference like 'SEED-%';
  delete from housekeeping_tasks where notes like 'seed:%';
  delete from rate_overrides where label like '%(seed)';
  delete from expenses where id in (select md5('seed-exp-' || n)::uuid from generate_series(1, 25) n);

  for p in 1..array_length(v_props, 1) loop
    insert into properties(slug, name, tagline, description, address, area, city, contact_phone, whatsapp_number,
                           house_rules, amenities, cover_image, gallery, sort)
    values (v_props[p][1], v_props[p][2], v_props[p][3],
            'PLACEHOLDER description for ' || v_props[p][2] || '. Replace this with the real description from Admin > Properties.',
            'PLACEHOLDER street address, ' || v_props[p][4], v_props[p][4], 'Nairobi',
            '254700000000', '254700000000',
            E'Check-in from 14:00, check-out by 10:00.\nNo parties or events.\nQuiet hours 22:00 to 07:00.\nNo smoking indoors.',
            array['Fast WiFi','Hot shower','Secure parking','24h security','Kitchenette','Smart TV'],
            '/placeholders/' || v_props[p][5] || '.svg', array['/placeholders/' || v_props[p][5] || '.svg'], p)
    on conflict (slug) do update set name = excluded.name, tagline = excluded.tagline, area = excluded.area,
      cover_image = excluded.cover_image, gallery = excluded.gallery, sort = excluded.sort;
  end loop;

  for u in 1..array_length(v_units, 1) loop
    select id into v_prop from properties where slug = v_units[u][1];
    insert into units(id, property_id, name, code, unit_type, max_guests, bedrooms, beds, base_rate, weekend_rate,
                      cleaning_fee, min_nights, amenities, images, sort)
    values (md5('seed-unit-' || v_units[u][2])::uuid, v_prop, v_units[u][3], v_units[u][2], v_units[u][4], v_units[u][5]::int,
            v_units[u][6]::int, greatest(v_units[u][6]::int, 1), v_units[u][7]::int, v_units[u][8]::int, v_units[u][9]::int,
            v_units[u][10]::int, array['Fast WiFi','Hot shower','Smart TV'],
            array['/placeholders/' || (select v_props[pp][5] from generate_subscripts(v_props, 1) pp where v_props[pp][1] = v_units[u][1]) || '.svg'], u)
    on conflict (id) do update set name = excluded.name, base_rate = excluded.base_rate, weekend_rate = excluded.weekend_rate,
      cleaning_fee = excluded.cleaning_fee, min_nights = excluded.min_nights, max_guests = excluded.max_guests;
  end loop;

  for g in 1..15 loop
    insert into guests(full_name, phone, email)
    values (guest_names[g], '2547110000' || lpad(g::text, 2, '0'), lower(replace(guest_names[g], ' ', '.')) || '@example.com')
    on conflict (phone) do update set full_name = excluded.full_name;
  end loop;

  -- One seasonal override (December peak) on the first unit
  select id into v_first_unit from units where code = 'K1';
  v_year := extract(year from today)::int;
  if today > make_date(v_year, 12, 20) then v_year := v_year + 1; end if;
  insert into rate_overrides(unit_id, label, start_date, end_date, nightly_rate)
  values (v_first_unit, 'December peak (seed)', make_date(v_year, 12, 20), make_date(v_year, 12, 20) + 14, 7500);

  -- Bookings: 3 per unit (+1 for every third unit) laid out so they can never overlap.
  --   k=0 past, k=1 around today, k=2 near future, k=3 later
  for u in 1..array_length(v_units, 1) loop
    select id, property_id into v_unit, v_prop from units where code = v_units[u][2];
    for k in 0..(case when u % 3 = 0 then 3 else 2 end) loop
      idx := idx + 1;
      v_h := abs(hashtext(u::text || '-' || k::text));
      v_len := 2 + (v_h % 4);
      v_in := case k when 0 then today - 28 + (u % 10)
                     when 1 then today - 4 + (u % 7)
                     when 2 then today + 14 + (v_h % 6) + (u % 4)
                     else today + 34 + (v_h % 9) end;
      v_out := v_in + v_len;
      if (select min_nights from units where id = v_unit) > v_len then v_out := v_in + (select min_nights from units where id = v_unit); end if;
      g := 1 + (idx % 15);
      select id into v_guest from guests where phone = '2547110000' || lpad(g::text, 2, '0');
      select * into q from quote_stay(v_unit, v_in, v_out);
      v_total := q.total;
      v_dep := calc_deposit(v_total, 50);
      v_ref := 'SEED-' || lpad(idx::text, 4, '0');

      v_status := case
        when v_out <= today then 'checked_out'
        when v_in <= today then 'checked_in'
        else 'confirmed' end;
      -- sprinkle a few other outcomes (they free their dates, so layout stays valid)
      if k = 0 and idx % 9 = 0 then v_status := 'cancelled'; end if;
      if k = 0 and idx % 11 = 0 then v_status := 'no_show'; end if;
      if k = 2 and idx % 5 = 0 then v_status := 'pending'; end if;
      if k = 2 and idx % 7 = 0 then v_status := 'expired'; end if;
      if v_status = 'checked_in' and v_in = today and idx % 2 = 0 then v_status := 'confirmed'; end if;  -- arriving today

      insert into bookings(reference, property_id, unit_id, guest_id, check_in, check_out, num_guests, status, source,
                           nightly_total, cleaning_fee, total_amount, deposit_required, hold_expires_at,
                           cancelled_at, cancel_reason, created_at)
      values (v_ref, v_prop, v_unit, v_guest, v_in, v_out, least(2, (select max_guests from units where id = v_unit)), v_status,
              (array['website','whatsapp','walk_in','phone','website','whatsapp'])[1 + idx % 6]::booking_source,
              q.nightly_total, q.cleaning_fee, v_total, v_dep, null,
              case when v_status = 'cancelled' then v_in::timestamptz - interval '3 days' end,
              case when v_status = 'cancelled' then 'Guest changed plans (seed)' end,
              (v_in::timestamptz - interval '9 days'))
      returning id into b_id;

      if v_status in ('checked_out','checked_in','confirmed') then
        v_paid_full := v_status = 'checked_out' or (idx % 3 = 0);
        insert into payments(booking_id, kind, method, status, amount, phone, mpesa_receipt, recorded_by, confirmed_at)
        values (b_id, 'deposit', 'mpesa_stk', 'succeeded', v_dep, '2547110000' || lpad(g::text, 2, '0'),
                'SEEDD' || lpad(idx::text, 5, '0'), null,
                least(now(), (v_in::timestamptz - interval '6 days') + interval '9 hours'));
        if v_paid_full and v_total > v_dep then
          insert into payments(booking_id, kind, method, status, amount, mpesa_receipt, confirmed_at)
          values (b_id, 'balance', case when idx % 2 = 0 then 'cash' else 'mpesa_manual' end::payment_method, 'succeeded',
                  v_total - v_dep, case when idx % 2 = 0 then null else 'SEEDB' || lpad(idx::text, 5, '0') end,
                  least(now(), v_in::timestamptz + interval '12 hours'));
        end if;
      end if;
    end loop;
  end loop;

  -- 2 blocked ranges (in the gap between k=1 and k=2 stays)
  insert into bookings(reference, property_id, unit_id, check_in, check_out, status, source, num_guests, notes)
  select 'SEED-B' || n, u.property_id, u.id, today + 9, today + 12, 'blocked', 'manual', 1, 'Maintenance (seed)'
  from (select id, property_id, row_number() over (order by code) n from units where code in ('K2','L1')) u;

  -- Housekeeping: a few open tasks plus finished ones
  insert into housekeeping_tasks(property_id, unit_id, status, due_date, notes, priority)
  select u.property_id, u.id, st::task_status, today, 'seed: ' || st, pr
  from (values ('K1','dirty',false), ('W2','dirty',true), ('C1','in_progress',false), ('L3','clean',false), ('R1','inspected',false)) t(code, st, pr)
  join units u on u.code = t.code;

  -- 25 expenses over the last ~55 days (deterministic ids, so re-runs replace them)
  for i in 1..25 loop
    insert into expenses(id, property_id, category, amount, expense_date, description, paid_via)
    values (md5('seed-exp-' || i)::uuid,
            (select id from properties order by sort offset ((i - 1) % 5) limit 1),
            cats[1 + (i % 8)], 500 + ((i * 937) % 9000) / 50 * 50, today - ((i * 2) % 55),
            'Seed expense #' || i, (array['cash','mpesa_manual','bank'])[1 + i % 3]::payment_method);
  end loop;
end
$seed$;
