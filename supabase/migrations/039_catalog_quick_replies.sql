-- ============================================================
-- 039_catalog_quick_replies.sql
--
-- Import ALL ladiesbags.lk admin quick messages (products + custom)
-- as lightweight stubs with badge colors. Payload (text + JPEG URLs)
-- is resolved live from /api/quick-messages at send time.
-- ============================================================

ALTER TABLE quick_replies
  DROP CONSTRAINT IF EXISTS quick_replies_kind_check;

ALTER TABLE quick_replies
  ADD CONSTRAINT quick_replies_kind_check
  CHECK (kind IN ('text', 'interactive', 'product', 'catalog'));

-- External id from ladiesbags whatsapp_quick_messages.id
-- (e.g. qm_site_prod_… or qm_site_custom_…)
ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS catalog_message_id TEXT;

ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS badge_color TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_replies_account_catalog
  ON quick_replies (account_id, catalog_message_id)
  WHERE catalog_message_id IS NOT NULL AND kind = 'catalog';

-- Backfill existing product stubs → catalog kind with catalog_message_id.
UPDATE quick_replies
SET
  kind = 'catalog',
  catalog_message_id = COALESCE(
    catalog_message_id,
    CASE
      WHEN product_id IS NOT NULL AND product_id <> ''
        THEN 'qm_site_prod_' || product_id
      ELSE catalog_message_id
    END
  )
WHERE kind = 'product' AND product_id IS NOT NULL;
