-- 0013_guest_credit_statements.sql
-- Guest credit (an append-only ledger: nothing is ever edited or deleted), applying credit to a booking balance,
-- VIP / do-not-rebook flags, and a guest statement. Credit can never go below zero.

alter table guests
  add column vip boolean not null default false,
  add column flagged boolean not null default false,
  add column flag_reason text check (flag_reason is null or char_length(flag_reason) <= 300),
  add constraint guests_flag_reason_needed check (not flagged or char_length(trim(coalesce(flag_reason, ''))) >= 3);

-- Who may see a guest: owner, or a manager with a booking from that guest at one of their properties.
create or replace function can_see_guest(_uid uuid, _guest uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_role(_uid, 'owner')
      or (has_role(_uid, 'manager') and exists (select 1 from bookings b where b.guest_id = _guest and can_manage_property(_uid, b.property_id)))
$$;

create table guest_credit_entries (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid not null references guests on delete restrict,
  amount int not null check (amount <> 0),
  kind text not null check (kind in ('credit_added','credit_used','adjustment')),
  reason text not null check (char_length(trim(reason)) between 3 and 300),
  booking_id uuid references bookings on delete set null,
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  check ((kind = 'credit_added' and amount > 0) or (kind = 'credit_used' and amount < 0 and booking_id is not null) or kind = 'adjustment')
);
create index on guest_credit_entries (guest_id, created_at);

alter table guest_credit_entries enable row level security;
revoke all on guest_credit_entries from anon;
revoke insert, update, delete on guest_credit_entries from authenticated;   -- writes only through the functions below
create policy credit_staff_read on guest_credit_entries for select to authenticated
  using (can_see_guest((select auth.uid()), guest_id));
create trigger trg_audit_credit after insert on guest_credit_entries for each row execute function audit_generic('guest_credit');

create or replace function guest_credit_balance(p_guest uuid) returns int
language sql stable security definer set search_path = public as $$
  select case when can_see_guest((select auth.uid()), p_guest)
              then coalesce((select sum(amount) from guest_credit_entries where guest_id = p_guest), 0)::int end
$$;
grant execute on function guest_credit_balance(uuid) to authenticated;

-- Add credit (refund held as credit, goodwill, prepayment). Owner or manager who can see the guest.
create or replace function add_guest_credit(p_guest uuid, p_amount int, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); v_bal int;
begin
  if not can_see_guest(v_uid, p_guest) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_amount is null or p_amount < 1 then raise exception 'Enter an amount greater than zero.' using errcode = 'check_violation'; end if;
  perform 1 from guests where id = p_guest for update;
  insert into guest_credit_entries(guest_id, amount, kind, reason, created_by) values (p_guest, p_amount, 'credit_added', trim(p_reason), v_uid);
  select coalesce(sum(amount), 0) into v_bal from guest_credit_entries where guest_id = p_guest;
  return v_bal;
end $$;
grant execute on function add_guest_credit(uuid, int, text) to authenticated;

-- Owner-only correction (positive or negative). The balance may not go below zero.
create or replace function adjust_guest_credit(p_guest uuid, p_amount int, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); v_bal int;
begin
  if not has_role(v_uid, 'owner') then raise exception 'Only the owner can adjust credit' using errcode = '42501'; end if;
  if p_amount is null or p_amount = 0 then raise exception 'Enter a non-zero amount.' using errcode = 'check_violation'; end if;
  perform 1 from guests where id = p_guest for update;
  insert into guest_credit_entries(guest_id, amount, kind, reason, created_by) values (p_guest, p_amount, 'adjustment', trim(p_reason), v_uid);
  select coalesce(sum(amount), 0) into v_bal from guest_credit_entries where guest_id = p_guest;
  if v_bal < 0 then raise exception 'Credit cannot go below zero.' using errcode = 'check_violation'; end if;
  return v_bal;
end $$;
grant execute on function adjust_guest_credit(uuid, int, text) to authenticated;

-- Use credit towards a booking: records a payment (so the booking totals stay correct) and the ledger entry together.
create or replace function apply_guest_credit(p_booking uuid, p_amount int) returns int
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := (select auth.uid()); b bookings; v_bal int; v_due int;
begin
  select * into b from bookings where id = p_booking for update;
  if not found or b.guest_id is null or not can_manage_property(v_uid, b.property_id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if b.status not in ('pending','confirmed','checked_in','checked_out') then raise exception 'This booking cannot take a payment.' using errcode = 'check_violation'; end if;
  if p_amount is null or p_amount < 1 then raise exception 'Enter an amount greater than zero.' using errcode = 'check_violation'; end if;
  v_due := b.total_amount - b.amount_paid;
  if p_amount > v_due then raise exception 'That is more than the balance of KES %.', v_due using errcode = 'check_violation'; end if;
  perform 1 from guests where id = b.guest_id for update;
  select coalesce(sum(amount), 0) into v_bal from guest_credit_entries where guest_id = b.guest_id;
  if p_amount > v_bal then raise exception 'The guest only has KES % credit.', v_bal using errcode = 'check_violation'; end if;
  insert into payments(booking_id, kind, method, status, amount, confirmed_at, recorded_by)
    values (b.id, case when p_amount >= v_due and b.amount_paid = 0 then 'full'::payment_kind when b.amount_paid = 0 then 'deposit'::payment_kind else 'balance'::payment_kind end,
            'other', 'succeeded', p_amount, now(), v_uid);
  insert into guest_credit_entries(guest_id, amount, kind, reason, booking_id, created_by)
    values (b.guest_id, -p_amount, 'credit_used', 'Applied to booking ' || b.reference, b.id, v_uid);
  return v_bal - p_amount;
end $$;
grant execute on function apply_guest_credit(uuid, int) to authenticated;

-- Statement: every booking, payment and credit movement for a guest, under the caller's own access rules.
create or replace function guest_statement(p_guest uuid) returns jsonb
language plpgsql stable security invoker as $$
declare g guests; v_bookings jsonb; v_payments jsonb; v_credit jsonb; v_bal int;
begin
  select * into g from guests where id = p_guest;
  if not found then raise exception 'Guest not found' using errcode = 'no_data_found'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('reference', b.reference, 'property', p.name, 'check_in', b.check_in, 'check_out', b.check_out,
      'status', b.status, 'total', b.total_amount, 'discount', b.discount, 'paid', b.amount_paid,
      'balance', case when b.status in ('cancelled','expired','no_show','blocked') then 0 else greatest(b.total_amount - b.amount_paid, 0) end) order by b.check_in desc), '[]'::jsonb)
    into v_bookings from bookings b join properties p on p.id = b.property_id where b.guest_id = p_guest;
  select coalesce(jsonb_agg(jsonb_build_object('reference', b.reference, 'kind', pay.kind, 'method', pay.method, 'amount', pay.amount,
      'receipt', pay.mpesa_receipt, 'at', pay.confirmed_at) order by pay.confirmed_at desc), '[]'::jsonb)
    into v_payments from payments pay join bookings b on b.id = pay.booking_id where b.guest_id = p_guest and pay.status = 'succeeded';
  select coalesce(jsonb_agg(jsonb_build_object('amount', amount, 'kind', kind, 'reason', reason, 'at', created_at) order by created_at desc), '[]'::jsonb),
         coalesce(sum(amount), 0)::int
    into v_credit, v_bal from guest_credit_entries where guest_id = p_guest;
  return jsonb_build_object('guest', jsonb_build_object('name', g.full_name, 'phone', g.phone, 'email', g.email),
    'bookings', v_bookings, 'payments', v_payments, 'credit', v_credit, 'credit_balance', v_bal);
end $$;
grant execute on function guest_statement(uuid) to authenticated;
