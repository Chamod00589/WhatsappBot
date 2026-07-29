-- Pending order intake (awaiting color) for Sales Agent
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS sa_order_pending jsonb;
