-- 0007_inquiries_reviews_announcements.sql
-- Guest inquiries (with internal notes and a linked booking), guest reviews (moderated) and announcements
-- (scheduled, never hard-deleted). Public visitors write ONLY through the two RPCs below (throttled);
-- staff read/write through RLS. Everything is audited by the existing audit_generic trigger function.

-- ---------------------------------------------------------------------------
-- Phone normalisation (mirror of src/lib/phone.ts): returns 2547XXXXXXXX / 2541XXXXXXXX or null.
-- ---------------------------------------------------------------------------
create or replace function normalize_ke_phone(p_in text) returns text
language plpgsql immutable as $$
declare d text;
begin
  if p_in is null or p_in ~ '[^0-9 +().\-]' then return null; end if;
  d := regexp_replace(p_in, '[ ().\-]', '', 'g');
  if left(d, 1) = '+' then
    if left(d, 4) <> '+254' then return null; end if;
    d := substr(d, 2);
  end if;
  if position('+' in d) > 0 then return null; end if;
  if left(d, 1) = '0' then d := '254' || substr(d, 2); end if;
  if d !~ '^254[71][0-9]{8}$' then return null; end if;
  return d;
end $$;

create or replace function is_owner_or_manager(_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select has_role(_uid, 'owner') or has_role(_uid, 'manager')
$$;

-- ---------------------------------------------------------------------------
-- Inquiries
-- ---------------------------------------------------------------------------
create table inquiries (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 80),
  phone text not null,
  email text check (email is null or char_length(email) <= 120),
  message text not null check (char_length(message) between 2 and 2000),
  property_id uuid references properties on delete set null,
  check_in date,
  check_out date,
  guests int check (guests is null or guests between 1 and 30),
  source text not null default 'website',
  status text not null default 'new' check (status in ('new','contacted','awaiting_response','converted','closed')),
  assigned_to uuid references profiles on delete set null,
  follow_up_on date,
  booking_id uuid references bookings on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (check_out is null or check_in is null or check_out > check_in)
);
create index on inquiries (status, created_at desc);
create index on inquiries (assigned_to);
create index on inquiries (property_id);
create trigger trg_inquiries_updated before update on inquiries for each row execute function set_updated_at();

-- An inquiry can only be "converted" when a real booking is linked.
create or replace function guard_inquiry_converted() returns trigger language plpgsql as $$
begin
  if new.status = 'converted' and new.booking_id is null then
    raise exception 'Link a booking before marking an inquiry as converted' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger trg_inquiries_converted before insert or update on inquiries for each row execute function guard_inquiry_converted();

create table inquiry_notes (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references inquiries on delete cascade,
  user_id uuid references profiles on delete set null,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index on inquiry_notes (inquiry_id, created_at);

-- ---------------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------------
create table reviews (
  id uuid primary key default gen_random_uuid(),
  guest_name text not null check (char_length(guest_name) between 2 and 60),
  stay_label text check (stay_label is null or char_length(stay_label) <= 80),
  property_id uuid references properties on delete set null,
  rating int not null check (rating between 1 and 5),
  body text not null check (char_length(body) between 5 and 1000),
  status text not null default 'pending' check (status in ('pending','approved','hidden')),
  flagged boolean not null default false,
  response text check (response is null or char_length(response) <= 1000),
  responded_at timestamptz,
  responded_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on reviews (status, created_at desc);
create trigger trg_reviews_updated before update on reviews for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Announcements (archived with active=false, never deleted by managers: history is kept)
-- ---------------------------------------------------------------------------
create table announcements (
  id uuid primary key default gen_random_uuid(),
  text text not null check (char_length(text) between 2 and 160),
  link text check (link is null or char_length(link) <= 300),
  variant text not null default 'info' check (variant in ('info','promo')),
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create index on announcements (active, starts_at, ends_at);
create trigger trg_announcements_updated before update on announcements for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table inquiries      enable row level security;
alter table inquiry_notes  enable row level security;
alter table reviews        enable row level security;
alter table announcements  enable row level security;

revoke all on inquiries, inquiry_notes from anon;
revoke insert, update, delete on reviews, announcements from anon;

create policy inquiries_staff_all on inquiries for all to authenticated
  using (is_owner_or_manager((select auth.uid())) and (property_id is null or can_manage_property((select auth.uid()), property_id)))
  with check (is_owner_or_manager((select auth.uid())) and (property_id is null or can_manage_property((select auth.uid()), property_id)));

create policy inquiry_notes_staff_all on inquiry_notes for all to authenticated
  using (exists (select 1 from inquiries i where i.id = inquiry_id and is_owner_or_manager((select auth.uid()))
                 and (i.property_id is null or can_manage_property((select auth.uid()), i.property_id))))
  with check (user_id = (select auth.uid()) and exists (select 1 from inquiries i where i.id = inquiry_id and is_owner_or_manager((select auth.uid()))
                 and (i.property_id is null or can_manage_property((select auth.uid()), i.property_id))));

create policy reviews_public_read on reviews for select to anon, authenticated using (status = 'approved');
create policy reviews_staff_all on reviews for all to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));

create policy announcements_public_read on announcements for select to anon, authenticated
  using (active and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at >= now()));
create policy announcements_staff_read on announcements for select to authenticated using (is_owner_or_manager((select auth.uid())));
create policy announcements_staff_write on announcements for insert to authenticated with check (is_owner_or_manager((select auth.uid())));
create policy announcements_staff_update on announcements for update to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy announcements_owner_delete on announcements for delete to authenticated using (has_role((select auth.uid()), 'owner'));

-- ---------------------------------------------------------------------------
-- Public submissions (the ONLY way visitors write). Throttled; a filled "website" honeypot is silently dropped.
-- ---------------------------------------------------------------------------
create or replace function submit_inquiry(
  p_name text, p_phone text, p_email text, p_message text,
  p_property uuid default null, p_in date default null, p_out date default null, p_guests int default null,
  p_website text default ''
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_phone text; v_id uuid; n int;
begin
  if coalesce(p_website, '') <> '' then return null; end if;
  v_phone := normalize_ke_phone(p_phone);
  if v_phone is null then raise exception 'Enter a valid Kenyan phone number, for example 0712 345 678.' using errcode = 'check_violation'; end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Please enter your name.' using errcode = 'check_violation'; end if;
  if char_length(trim(coalesce(p_message, ''))) < 2 then raise exception 'Please write a message.' using errcode = 'check_violation'; end if;
  select count(*) into n from rate_limit_events where key = 'inquiry:' || v_phone and created_at > now() - interval '1 hour';
  if n >= 3 then raise exception 'Too many messages from this number. Please wait a while and try again.' using errcode = 'check_violation'; end if;
  select count(*) into n from rate_limit_events where key = 'inquiry:all' and created_at > now() - interval '1 hour';
  if n >= 60 then raise exception 'We are receiving many messages right now. Please try again shortly.' using errcode = 'check_violation'; end if;
  insert into rate_limit_events(key) values ('inquiry:' || v_phone), ('inquiry:all');
  insert into inquiries(name, phone, email, message, property_id, check_in, check_out, guests, source)
  values (trim(p_name), v_phone, nullif(trim(coalesce(p_email, '')), ''), trim(p_message),
          (select id from properties where id = p_property and active), p_in, p_out, p_guests, 'website')
  returning id into v_id;
  return v_id;
end $$;
grant execute on function submit_inquiry(text,text,text,text,uuid,date,date,int,text) to anon, authenticated;

create or replace function submit_review(
  p_name text, p_stay text, p_property uuid, p_rating int, p_body text, p_website text default ''
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; n int; k text;
begin
  if coalesce(p_website, '') <> '' then return null; end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Please enter your name.' using errcode = 'check_violation'; end if;
  if char_length(trim(coalesce(p_body, ''))) < 5 then raise exception 'Please write a few words about your stay.' using errcode = 'check_violation'; end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then raise exception 'Choose 1 to 5 stars.' using errcode = 'check_violation'; end if;
  k := 'review:' || lower(trim(p_name));
  select count(*) into n from rate_limit_events where key = k and created_at > now() - interval '1 day';
  if n >= 2 then raise exception 'Thank you, we already received your review.' using errcode = 'check_violation'; end if;
  select count(*) into n from rate_limit_events where key = 'review:all' and created_at > now() - interval '1 hour';
  if n >= 30 then raise exception 'Please try again shortly.' using errcode = 'check_violation'; end if;
  insert into rate_limit_events(key) values (k), ('review:all');
  insert into reviews(guest_name, stay_label, property_id, rating, body, status)
  values (trim(p_name), nullif(trim(coalesce(p_stay, '')), ''), (select id from properties where id = p_property and active), p_rating, trim(p_body), 'pending')
  returning id into v_id;
  return v_id;
end $$;
grant execute on function submit_review(text,text,uuid,int,text,text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Audit trail (existing generic trigger function)
-- ---------------------------------------------------------------------------
create trigger trg_audit_inquiry      after insert or update or delete on inquiries     for each row execute function audit_generic('inquiry');
create trigger trg_audit_review       after insert or update or delete on reviews       for each row execute function audit_generic('review');
create trigger trg_audit_announcement after insert or update or delete on announcements for each row execute function audit_generic('announcement');
