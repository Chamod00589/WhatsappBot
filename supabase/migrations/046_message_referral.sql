-- ============================================================
-- 046_message_referral.sql
--
-- Click-to-WhatsApp (CTWA) / FB ads referral context.
--
-- When a customer opens a chat from a Facebook/Instagram ad, Meta
-- attaches a `referral` object on the first inbound webhook message
-- (headline, body, image/video URLs, source_url, ctwa_clid, …).
-- Persist it so the inbox can render the same ad-info card that
-- normal WhatsApp shows above the customer's greeting text.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS referral JSONB;
