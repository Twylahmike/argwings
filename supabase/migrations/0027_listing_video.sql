-- 0027_listing_video.sql
-- An optional walkthrough video per listing (chosen from the media library; the file lives in the public image bucket).

alter table properties add column video_url text check (video_url is null or video_url ~ '^https://');
