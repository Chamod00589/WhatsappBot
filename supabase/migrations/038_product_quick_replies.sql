-- ============================================================
-- 038_product_quick_replies.sql
--
-- Product catalog quick replies for Ladies Bags.
--
-- Stores ONLY a lightweight stub (title + external product_id).
-- Caption text and image URLs are resolved live from the
-- ladiesbags.lk catalog at send time — nothing is copied into
-- Supabase storage or duplicated into content_text.
--
-- Note: kind also allows 'catalog' so this migration stays compatible
-- with 039 (and any prior manual apply that already used catalog).
-- ============================================================

-- Allow kind = 'product' / 'catalog' alongside text / interactive.
ALTER TABLE quick_replies
  DROP CONSTRAINT IF EXISTS quick_replies_kind_check;

ALTER TABLE quick_replies
  ADD CONSTRAINT quick_replies_kind_check
  CHECK (kind IN ('text', 'interactive', 'product', 'catalog'));

-- External product id from https://www.ladiesbags.lk/api/products
ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS product_id TEXT;

-- One stub per catalog product per account (re-import upserts).
CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_replies_account_product
  ON quick_replies (account_id, product_id)
  WHERE product_id IS NOT NULL AND kind = 'product';
