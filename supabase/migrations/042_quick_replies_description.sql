-- ============================================================
-- 042_quick_replies_description.sql
--
-- Optional description imported from ladiesbags.lk admin quick
-- messages (what the quick reply includes). Shown in Settings.
-- ============================================================

ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS description TEXT;
