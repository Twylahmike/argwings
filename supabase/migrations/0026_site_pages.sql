-- 0026_site_pages.sql
-- Editable policy pages (Terms, Privacy, House rules...) shown on the public site at /p/<slug>. A page is public only while
-- it is published. The two starter pages are created as unpublished drafts with a clear "review this" note, so the site never
-- shows legal text that nobody has read.

create table site_pages (
  slug text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  title text not null check (char_length(trim(title)) between 2 and 80),
  body text not null default '' check (char_length(body) <= 30000),
  published boolean not null default false,
  show_in_footer boolean not null default true,
  sort int not null default 0,
  updated_by uuid references profiles on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table site_pages enable row level security;
revoke insert, update, delete on site_pages from anon;
create policy site_pages_public on site_pages for select to anon, authenticated using (published);
create policy site_pages_staff_read on site_pages for select to authenticated using (is_owner_or_manager((select auth.uid())));
create policy site_pages_staff_write on site_pages for all to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy perm_site_pages_write on site_pages as restrictive for all to authenticated
  using (has_permission((select auth.uid()), 'cms.manage') or published) with check (has_permission((select auth.uid()), 'cms.manage'));
create trigger trg_audit_site_page after insert or update or delete on site_pages for each row execute function audit_generic('site_page');
create or replace function stamp_site_page() returns trigger language plpgsql as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
create trigger trg_site_page_stamp before update on site_pages for each row execute function stamp_site_page();

insert into site_pages(slug, title, body, published, show_in_footer, sort) values
('terms', 'Terms and conditions',
 E'# Review before publishing\nThis is a starting outline, not legal advice. Replace it with your own terms, have a lawyer read it, then tick Published.\n\n# Bookings\nA booking is confirmed once the deposit is received. The balance is due before check-in.\n\n# Cancellations\nSee the cancellation policy shown when you book.\n\n# House rules\nPlease respect the property, your neighbours and the quiet hours.', false, true, 10),
('privacy', 'Privacy notice',
 E'# Review before publishing\nThis is a starting outline, not legal advice. Replace it with a notice that matches how you really handle personal data (Kenya Data Protection Act, 2019), then tick Published.\n\n# What we collect\nName, phone number, email and booking details, so we can manage your stay.\n\n# How we use it\nTo confirm bookings, take payments and send confirmations and reminders.\n\n# Your rights\nYou can ask to see, correct or delete your personal data by contacting us.', false, true, 20);
