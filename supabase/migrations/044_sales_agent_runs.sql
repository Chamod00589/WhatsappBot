-- ============================================================
-- 044_sales_agent_runs.sql — Troubleshoot logs for Sales Agent
--
-- One row per inbound dispatch. Agents view these in /inbox.
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS sales_agent_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id        uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- inbound snapshot
  inbound_text      text,
  content_type      text,
  -- outcome
  status            text NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'skipped', 'completed', 'failed')),
  skip_reason       text,
  -- structured debug payload: steps[], context[], tools[], reply, usage, …
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);

CREATE INDEX IF NOT EXISTS sales_agent_runs_conversation_created_idx
  ON sales_agent_runs (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS sales_agent_runs_account_created_idx
  ON sales_agent_runs (account_id, created_at DESC);

ALTER TABLE sales_agent_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sales_agent_runs_select ON sales_agent_runs;
CREATE POLICY sales_agent_runs_select ON sales_agent_runs FOR SELECT
  USING (is_account_member(account_id));

-- Inserts/updates are service-role only (webhook). No member INSERT/UPDATE.
