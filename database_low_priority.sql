-- Low-priority feature migration (LP-02..LP-05)
-- Run after database_hardening.sql

ALTER TABLE users ADD COLUMN IF NOT EXISTS locale TEXT DEFAULT 'en';
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT DEFAULT 'sunrise';
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_referral_code
  ON users(tenant_id, referral_code)
  WHERE referral_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS referral_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  referrer_phone TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
  referred_phone TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
  coupon_code TEXT,
  reward_days INTEGER NOT NULL DEFAULT 7,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(tenant_id, referred_phone)
);
CREATE INDEX IF NOT EXISTS idx_referral_events_tenant_referrer
  ON referral_events(tenant_id, referrer_phone, created_at DESC);

CREATE TABLE IF NOT EXISTS coupon_codes (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  code TEXT NOT NULL,
  discount_type TEXT NOT NULL DEFAULT 'days',
  discount_value INTEGER NOT NULL DEFAULT 0,
  max_redemptions INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(tenant_id, code)
);
CREATE INDEX IF NOT EXISTS idx_coupon_codes_tenant_active
  ON coupon_codes(tenant_id, active, expires_at);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  code TEXT NOT NULL,
  user_phone TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
  applied_days INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(tenant_id, code, user_phone)
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_tenant_user
  ON coupon_redemptions(tenant_id, user_phone, created_at DESC);

-- Example seed (optional):
-- INSERT INTO coupon_codes (tenant_id, code, discount_type, discount_value, max_redemptions, active)
-- VALUES ('default', 'BETA30', 'days', 30, 100, TRUE)
-- ON CONFLICT (tenant_id, code) DO NOTHING;
