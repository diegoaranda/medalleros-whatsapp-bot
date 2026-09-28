-- The catalog-media bucket is used exclusively for catalog item photographs
-- (see api/catalog-media.ts) and holds no conversation, contact, or other
-- internal attachments. Its contents are commercial product photography
-- intended to be publicly visible, so the bucket can be served publicly
-- without exposing anything outside the catalog.
update storage.buckets
set public = true
where id = 'catalog-media';
