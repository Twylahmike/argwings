-- 0016_media_gallery_banners.sql
-- Media library (files already live in the public "property-images" bucket), a managed public gallery with
-- categories, and homepage banners with a publish window. Only staff write; the public sees what is published.

create table media_assets (
  id uuid primary key default gen_random_uuid(),
  url text not null unique check (url ~ '^https://'),
  storage_path text not null,
  kind text not null default 'image' check (kind in ('image','video')),
  title text check (title is null or char_length(title) <= 120),
  alt_text text check (alt_text is null or char_length(alt_text) <= 200),
  category text not null default 'general' check (char_length(category) between 1 and 40),
  size_bytes int check (size_bytes is null or size_bytes >= 0),
  uploaded_by uuid references profiles on delete set null,
  created_at timestamptz not null default now()
);
create index on media_assets (category, created_at desc);

create table gallery_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 40),
  sort int not null default 0,
  published boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index gallery_categories_name_uniq on gallery_categories (lower(name));

create table gallery_items (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references gallery_categories on delete cascade,
  url text not null check (url ~ '^https://'),
  kind text not null default 'image' check (kind in ('image','video')),
  alt_text text check (alt_text is null or char_length(alt_text) <= 200),
  caption text check (caption is null or char_length(caption) <= 140),
  sort int not null default 0,
  published boolean not null default true,
  created_at timestamptz not null default now()
);
create index on gallery_items (category_id, sort);

create table homepage_banners (
  id uuid primary key default gen_random_uuid(),
  placement text not null check (placement in ('hero','promo')),
  title text check (title is null or char_length(title) <= 100),
  subtitle text check (subtitle is null or char_length(subtitle) <= 200),
  image_url text not null check (image_url ~ '^https://'),
  link_url text check (link_url is null or link_url ~ '^(https://|/)'),
  link_label text check (link_label is null or char_length(link_label) <= 40),
  sort int not null default 0,
  published boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  created_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create index on homepage_banners (placement, sort);

alter table media_assets enable row level security;
alter table gallery_categories enable row level security;
alter table gallery_items enable row level security;
alter table homepage_banners enable row level security;
revoke insert, update, delete on media_assets, gallery_categories, gallery_items, homepage_banners from anon;
revoke all on media_assets from anon;

create policy media_staff_all on media_assets for all to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy gallery_cat_public on gallery_categories for select to anon, authenticated using (published);
create policy gallery_cat_staff on gallery_categories for all to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy gallery_items_public on gallery_items for select to anon, authenticated
  using (published and exists (select 1 from gallery_categories c where c.id = category_id and c.published));
create policy gallery_items_staff on gallery_items for all to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));
create policy banners_public on homepage_banners for select to anon, authenticated
  using (published and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));
create policy banners_staff on homepage_banners for all to authenticated
  using (is_owner_or_manager((select auth.uid()))) with check (is_owner_or_manager((select auth.uid())));

create trigger trg_audit_banner  after insert or update or delete on homepage_banners  for each row execute function audit_generic('homepage_banner');
create trigger trg_audit_galitem after insert or update or delete on gallery_items     for each row execute function audit_generic('gallery_item');

-- Is a file still used anywhere on the site?
create or replace function media_in_use(p_url text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from gallery_items where url = p_url)
      or exists (select 1 from homepage_banners where image_url = p_url)
      or exists (select 1 from properties where cover_image = p_url or p_url = any(gallery))
      or exists (select 1 from units where p_url = any(images))
      or exists (select 1 from settings where key in ('logo_url','site_content') and value::text like '%' || p_url || '%')
$$;
revoke execute on function media_in_use(text) from public, anon;
grant execute on function media_in_use(text) to authenticated;

-- Deleting a library file is refused while it is in use. Returns the storage path so the client can remove the object.
create or replace function delete_media_asset(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare a media_assets;
begin
  if not is_owner_or_manager((select auth.uid())) then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into a from media_assets where id = p_id for update;
  if not found then raise exception 'File not found' using errcode = 'no_data_found'; end if;
  if media_in_use(a.url) then raise exception 'This file is still used on the website. Remove it there first.' using errcode = 'check_violation'; end if;
  delete from media_assets where id = p_id;
  return a.storage_path;
end $$;
grant execute on function delete_media_asset(uuid) to authenticated;
