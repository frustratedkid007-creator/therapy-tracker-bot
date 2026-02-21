-- Idempotent hardening migration for Therapy Tracker
-- Run this on existing projects after database.sql

-- Tenant scoping columns (optional, used when ENABLE_TENANT_SCOPING=true)
ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE users SET tenant_id = 'default' WHERE tenant_id IS NULL;
ALTER TABLE users ALTER COLUMN tenant_id SET DEFAULT 'default';
ALTER TABLE users ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_tenant_phone ON users(tenant_id, phone);

ALTER TABLE monthly_config ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE monthly_config SET tenant_id = 'default' WHERE tenant_id IS NULL;
ALTER TABLE monthly_config ALTER COLUMN tenant_id SET DEFAULT 'default';
ALTER TABLE monthly_config ALTER COLUMN tenant_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_monthly_config_tenant_user_month
  ON monthly_config(tenant_id, user_phone, month);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE sessions SET tenant_id = 'default' WHERE tenant_id IS NULL;
ALTER TABLE sessions ALTER COLUMN tenant_id SET DEFAULT 'default';
ALTER TABLE sessions ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_user_month
  ON sessions(tenant_id, user_phone, month);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_child_month
  ON sessions(tenant_id, child_id, month);

ALTER TABLE holidays ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE holidays SET tenant_id = 'default' WHERE tenant_id IS NULL;
ALTER TABLE holidays ALTER COLUMN tenant_id SET DEFAULT 'default';
ALTER TABLE holidays ALTER COLUMN tenant_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_holidays_tenant_user_date
  ON holidays(tenant_id, user_phone, date);

ALTER TABLE children ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE children SET tenant_id = 'default' WHERE tenant_id IS NULL;
ALTER TABLE children ALTER COLUMN tenant_id SET DEFAULT 'default';
ALTER TABLE children ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_children_tenant_created_by ON children(tenant_id, created_by);

ALTER TABLE child_members ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE child_members SET tenant_id = 'default' WHERE tenant_id IS NULL;
ALTER TABLE child_members ALTER COLUMN tenant_id SET DEFAULT 'default';
ALTER TABLE child_members ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_child_members_tenant_child ON child_members(tenant_id, child_id);
CREATE INDEX IF NOT EXISTS idx_child_members_tenant_phone ON child_members(tenant_id, member_phone);

CREATE TABLE IF NOT EXISTS processed_inbound_messages (
  id BIGSERIAL PRIMARY KEY,
  message_id TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
ALTER TABLE processed_inbound_messages ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE processed_inbound_messages SET tenant_id = 'default' WHERE tenant_id IS NULL;
ALTER TABLE processed_inbound_messages ALTER COLUMN tenant_id SET DEFAULT 'default';
ALTER TABLE processed_inbound_messages ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_processed_inbound_messages_tenant_created
  ON processed_inbound_messages(tenant_id, created_at);

-- Pro/entitlement and session enrichment
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_pro BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_expires_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mood TEXT;

-- Feedback notes captured from voice/text reflections
CREATE TABLE IF NOT EXISTS feedback_notes (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_phone TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
  transcript TEXT NOT NULL,
  summary TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
ALTER TABLE feedback_notes ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE feedback_notes SET tenant_id = 'default' WHERE tenant_id IS NULL;
ALTER TABLE feedback_notes ALTER COLUMN tenant_id SET DEFAULT 'default';
ALTER TABLE feedback_notes ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_feedback_notes_tenant_user_created
  ON feedback_notes(tenant_id, user_phone, created_at DESC);

-- Consent/audit log for legal traceability
CREATE TABLE IF NOT EXISTS consent_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_phone TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_consent_events_tenant_user_created
  ON consent_events(tenant_id, user_phone, created_at DESC);

-- Payment webhook idempotency (prevents duplicate pro extensions)
CREATE TABLE IF NOT EXISTS processed_payment_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  event_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_processed_payment_events_tenant_created
  ON processed_payment_events(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS subscription_payments (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  payment_id TEXT,
  event_key TEXT NOT NULL,
  event_name TEXT NOT NULL,
  user_phone TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
  plan_code TEXT,
  plan_days INTEGER NOT NULL,
  amount_paise INTEGER,
  currency TEXT DEFAULT 'INR',
  status TEXT DEFAULT 'paid',
  paid_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  notes JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(event_key)
);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_tenant_user_created
  ON subscription_payments(tenant_id, user_phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_payment_id
  ON subscription_payments(payment_id);
