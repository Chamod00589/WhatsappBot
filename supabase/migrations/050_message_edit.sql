-- Message edit tracking (inbox-side). Meta Cloud API cannot edit messages
-- on the customer's phone; this drives the shared-inbox "Edited" badge and
-- inbound coexistence edit webhooks.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS edited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN messages.edited_at IS
  'When set, the message body/caption was edited (inbox or inbound webhook).';
COMMENT ON COLUMN messages.edited_by IS
  'Agent who edited; NULL for customer-side edit webhooks.';
