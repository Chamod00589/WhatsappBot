-- ============================================================
-- 043_sales_agent.sql — Ladies Bags Sales Agent
--
-- Extends AI auto-reply with deterministic product/identify/QR
-- matching plus tool-calling order ops. Idempotent.
-- ============================================================

-- Sales Agent master + capability toggles on ai_configs
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS sales_agent_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS sa_product_match boolean NOT NULL DEFAULT true;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS sa_identify boolean NOT NULL DEFAULT true;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS sa_custom_qr_match boolean NOT NULL DEFAULT true;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS sa_ai_text boolean NOT NULL DEFAULT true;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS sa_create_order boolean NOT NULL DEFAULT true;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS sa_quotation boolean NOT NULL DEFAULT true;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS sa_tracking boolean NOT NULL DEFAULT true;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS sa_edit_order boolean NOT NULL DEFAULT true;

-- Allow higher per-conversation caps for full sales chats
ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_auto_reply_max_per_conversation_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_auto_reply_max_per_conversation_check
  CHECK (auto_reply_max_per_conversation BETWEEN 1 AND 100);

-- Identify confirm state + question dedupe on conversations
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS sa_identify_pending jsonb;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS sa_last_question_fp text;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS sa_last_answered_at timestamptz;

-- Compact AI context for outbound quick replies / order confirm / tracking
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ai_context_summary text;
