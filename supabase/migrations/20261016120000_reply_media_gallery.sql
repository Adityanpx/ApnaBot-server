-- Reply-node photo gallery + one video, limited per subscription plan.
--
--   Basic: 1 photo per reply   Pro: up to 3   Business: up to 10 photos + 1 video (<= 16 MB)
--
-- The node's existing single image (flow_nodes.media_id / image_url) stays photo #1 and is
-- sent exactly as before. The new columns carry only the EXTRA media:
--
--   plans.images_per_reply        total photos one reply may carry, photo #1 included (1..10)
--   plans.video_per_reply         whether a reply may carry a video
--   flow_nodes.gallery_media_ids  ordered business_media ids of photos #2..N, as a jsonb array
--   flow_nodes.video_media_id     the reply's video (business_media.id), or NULL
--
-- Why gallery_media_ids is a jsonb array and not a join table / uuid[] with a foreign key:
-- it is a short (<= 9), always-read-with-the-node, ordered list, and flow_snapshots store
-- flow_nodes rows verbatim as jsonb (an array column would not round-trip through
-- writeBusinessGraphRows). The price is that Postgres cannot enforce the reference, so:
--
--   * Dangling ids are cleaned by the trigger below: deleting a business_media row (the
--     library DELETE endpoint AND the storage sweeper both do) strips its id from every
--     gallery of that business in the same transaction. video_media_id needs no trigger,
--     its foreign key is ON DELETE SET NULL.
--   * The API refuses to delete a media file still used by a gallery or video
--     (businessMedia.service.js), exactly as it does for media_id.
--   * Anything that slips through (an old flow_snapshots row restored later, a template
--     import) is skipped silently at send time: the webhook looks each id up in the
--     business's own library and drops ids that no longer resolve.
--
-- save_flow_graph_full is NOT changed on purpose: its UPDATE SET does not list the new
-- columns, so a canvas batch save neither reads nor nulls them (and a brand-new node gets the
-- defaults). See 20260922120000 / feedback on jsonb_to_recordset whitelists.
--
-- DEPLOY ORDER: apply this BEFORE deploying the server code from the same commit.

-- ---- plans ---------------------------------------------------------------------------
alter table plans add column if not exists images_per_reply integer not null default 1;
alter table plans add column if not exists video_per_reply boolean not null default false;

alter table plans drop constraint if exists plans_images_per_reply_range;
alter table plans add constraint plans_images_per_reply_range check (images_per_reply between 1 and 10);

update plans set images_per_reply = 1,  video_per_reply = false where name = 'basic';
update plans set images_per_reply = 3,  video_per_reply = false where name = 'pro';
update plans set images_per_reply = 10, video_per_reply = true  where name = 'business';

-- ---- flow_nodes ----------------------------------------------------------------------
alter table flow_nodes add column if not exists gallery_media_ids jsonb not null default '[]'::jsonb;
alter table flow_nodes add column if not exists video_media_id uuid references business_media(id) on delete set null;

alter table flow_nodes drop constraint if exists flow_nodes_gallery_media_ids_is_array;
alter table flow_nodes add constraint flow_nodes_gallery_media_ids_is_array
  check (jsonb_typeof(gallery_media_ids) = 'array');

-- ---- dangling-id cleanup -------------------------------------------------------------
create or replace function remove_deleted_media_from_galleries() returns trigger as $$
begin
  update flow_nodes
     set gallery_media_ids = gallery_media_ids - old.id::text
   where business_id = old.business_id
     and gallery_media_ids @> jsonb_build_array(old.id::text);
  return old;
end;
$$ language plpgsql;

drop trigger if exists trg_business_media_remove_from_galleries on business_media;
create trigger trg_business_media_remove_from_galleries
  after delete on business_media
  for each row execute function remove_deleted_media_from_galleries();
