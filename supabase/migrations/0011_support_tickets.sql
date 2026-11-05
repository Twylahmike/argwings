-- 0011_support_tickets.sql
-- Internal support tickets: guest complaints, maintenance issues, billing questions. Staff only (owner and managers,
-- managers limited to their properties). Replies are kept as a thread. Everything is audited.

create sequence ticket_no_seq;

create table support_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_no int not null unique default nextval('ticket_no_seq'),
  subject text not null check (char_length(trim(subject)) between 3 and 140),
  description text not null default '' check (char_length(description) <= 4000),
  category text not null default 'general' check (category in ('general','complaint','maintenance','billing','booking','other')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'open' check (status in ('open','in_progress','waiting','resolved','closed')),
  property_id uuid references properties on delete set null,
  booking_id uuid references bookings on delete set null,
  guest_id uuid references guests on delete set null,
  assigned_to uuid references profiles on delete set null,
  created_by uuid references profiles on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on support_tickets (status, priority, created_at desc);
create index on support_tickets (property_id);
create index on support_tickets (assigned_to);
create trigger trg_tickets_updated before update on support_tickets for each row execute function set_updated_at();

-- resolved_at follows the status: set when resolved/closed, cleared when reopened.
create or replace function ticket_status_stamp() returns trigger language plpgsql as $$
begin
  if new.status in ('resolved','closed') then
    new.resolved_at := coalesce(case when tg_op = 'UPDATE' and old.status in ('resolved','closed') then old.resolved_at end, now());
  else
    new.resolved_at := null;
  end if;
  return new;
end $$;
create trigger trg_ticket_stamp before insert or update on support_tickets for each row execute function ticket_status_stamp();

create table support_ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_tickets on delete cascade,
  user_id uuid not null references profiles on delete restrict,
  body text not null check (char_length(trim(body)) between 1 and 4000),
  internal boolean not null default false,
  created_at timestamptz not null default now()
);
create index on support_ticket_messages (ticket_id, created_at);

alter table support_tickets enable row level security;
alter table support_ticket_messages enable row level security;
revoke all on support_tickets, support_ticket_messages from anon;

create policy tickets_staff_all on support_tickets for all to authenticated
  using (is_owner_or_manager((select auth.uid())) and (property_id is null or can_manage_property((select auth.uid()), property_id)))
  with check (is_owner_or_manager((select auth.uid())) and (property_id is null or can_manage_property((select auth.uid()), property_id)));

create policy ticket_messages_staff_all on support_ticket_messages for all to authenticated
  using (exists (select 1 from support_tickets t where t.id = ticket_id and is_owner_or_manager((select auth.uid()))
                 and (t.property_id is null or can_manage_property((select auth.uid()), t.property_id))))
  with check (user_id = (select auth.uid()) and exists (select 1 from support_tickets t where t.id = ticket_id and is_owner_or_manager((select auth.uid()))
                 and (t.property_id is null or can_manage_property((select auth.uid()), t.property_id))));

create trigger trg_audit_ticket after insert or update or delete on support_tickets for each row execute function audit_generic('support_ticket');
