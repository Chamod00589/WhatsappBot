-- Soft-delete for inbox messages (WhatsApp-style "This message was deleted").
-- Meta Cloud API cannot revoke messages on the customer's phone; this column
-- drives shared-inbox tombstones for all agents + inbound revoke webhooks.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_conversation_not_deleted
  ON messages (conversation_id, created_at)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN messages.deleted_at IS
  'When set, the message is soft-deleted (tombstone in inbox). Content fields may be scrubbed.';
COMMENT ON COLUMN messages.deleted_by IS
  'Agent who soft-deleted the message; NULL for customer-side revoke webhooks.';
