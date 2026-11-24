-- 011_leads_address_coords.sql
-- Additive: physical address + coordinates for discovered/imported leads
-- (free-first local discovery, Phase 2).
--
-- Existing rows keep NULL — nothing is backfilled or invented. The values
-- arrive only from evidence: an OSM dataset record (addr tags / way centroid)
-- or an explicit CSV column. CHECK constraints reject out-of-range coords at
-- the database level so a bad import can never persist garbage.

ALTER TABLE businesses ADD COLUMN address TEXT;

ALTER TABLE businesses ADD COLUMN latitude REAL
  CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90));

ALTER TABLE businesses ADD COLUMN longitude REAL
  CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180));
