-- ============================================================
-- 048_gemini_api_key_2.sql
--
-- Second Google AI Studio key for Gemini free-tier rotation.
-- Encrypted at rest (same AES-GCM format as api_key). The Sales Agent
-- walks key×model attempts so one project's daily quota doesn't stall
-- the inbox when the other key still has capacity.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS gemini_api_key_2 TEXT;
