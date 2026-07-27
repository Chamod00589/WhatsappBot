-- ============================================================
-- 041_tags_sort_order.sql
--
-- Allow reordering tags in Settings → Fields & tags.
-- ============================================================

ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_tags_account_sort
  ON tags (account_id, sort_order ASC, created_at ASC);

-- Backfill existing rows by created_at within each account.
WITH ordered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY account_id
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS rn
  FROM tags
)
UPDATE tags t
SET sort_order = ordered.rn
FROM ordered
WHERE t.id = ordered.id
  AND t.sort_order = 0;
