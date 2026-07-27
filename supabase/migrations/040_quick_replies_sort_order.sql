-- ============================================================
-- 040_quick_replies_sort_order.sql
--
-- Keep WhatsAppBot quick-reply list order in sync with
-- ladiesbags.lk /admin/quick-messages sort_order.
-- ============================================================

ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_quick_replies_account_sort
  ON quick_replies (account_id, sort_order ASC, created_at DESC);
