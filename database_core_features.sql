-- Core collaboration and invite visibility migration
-- Run after database_hardening.sql

ALTER TABLE users ADD COLUMN IF NOT EXISTS has_initiated_chat BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_users_tenant_initiated
  ON users(tenant_id, has_initiated_chat);
CREATE INDEX IF NOT EXISTS idx_users_tenant_last_inbound
  ON users(tenant_id, last_inbound_at DESC);

ALTER TABLE child_members ADD COLUMN IF NOT EXISTS invited_by TEXT;
ALTER TABLE child_members ADD COLUMN IF NOT EXISTS invite_sent_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE child_members ADD COLUMN IF NOT EXISTS invite_delivery_status TEXT;
ALTER TABLE child_members ADD COLUMN IF NOT EXISTS invite_error TEXT;
ALTER TABLE child_members ADD COLUMN IF NOT EXISTS invite_accepted_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_child_members_tenant_invite_status
  ON child_members(tenant_id, invite_delivery_status, invite_sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_child_members_tenant_invite_accepted
  ON child_members(tenant_id, invite_accepted_at DESC);

-- Backfill minimal chat-initiation signal from historical consent events.
UPDATE users u
SET
  has_initiated_chat = TRUE,
  last_inbound_at = COALESCE(u.last_inbound_at, c.last_seen)
FROM (
  SELECT tenant_id, user_phone, MAX(created_at) AS last_seen
  FROM consent_events
  GROUP BY tenant_id, user_phone
) c
WHERE u.phone = c.user_phone
  AND u.tenant_id = c.tenant_id
  AND (u.has_initiated_chat IS DISTINCT FROM TRUE OR u.last_inbound_at IS NULL);

-- Backfill invite states for existing records.
UPDATE child_members
SET invite_delivery_status = 'pending'
WHERE invite_delivery_status IS NULL
  AND role LIKE 'pending_%';

UPDATE child_members
SET
  invite_delivery_status = COALESCE(invite_delivery_status, 'accepted'),
  invite_accepted_at = COALESCE(invite_accepted_at, created_at)
WHERE role IN ('owner', 'parent', 'therapist', 'member');

