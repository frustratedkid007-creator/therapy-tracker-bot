-- RLS hardening for Therapy Tracker (Supabase)
-- Run this after database.sql and database_hardening.sql

ALTER TABLE IF EXISTS users ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS monthly_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS children ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS child_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS feedback_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS processed_inbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS processed_payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS subscription_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Enable all access for service role" ON users;
DROP POLICY IF EXISTS "Enable all access for service role" ON monthly_config;
DROP POLICY IF EXISTS "Enable all access for service role" ON sessions;
DROP POLICY IF EXISTS "Enable all access for service role" ON holidays;

DROP POLICY IF EXISTS users_service_role_all ON users;
DROP POLICY IF EXISTS monthly_config_service_role_all ON monthly_config;
DROP POLICY IF EXISTS sessions_service_role_all ON sessions;
DROP POLICY IF EXISTS holidays_service_role_all ON holidays;
DROP POLICY IF EXISTS children_service_role_all ON children;
DROP POLICY IF EXISTS child_members_service_role_all ON child_members;
DROP POLICY IF EXISTS feedback_notes_service_role_all ON feedback_notes;
DROP POLICY IF EXISTS consent_events_service_role_all ON consent_events;
DROP POLICY IF EXISTS processed_inbound_messages_service_role_all ON processed_inbound_messages;
DROP POLICY IF EXISTS processed_payment_events_service_role_all ON processed_payment_events;
DROP POLICY IF EXISTS subscription_payments_service_role_all ON subscription_payments;

CREATE POLICY users_service_role_all ON users
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY monthly_config_service_role_all ON monthly_config
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY sessions_service_role_all ON sessions
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY holidays_service_role_all ON holidays
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY children_service_role_all ON children
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY child_members_service_role_all ON child_members
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY feedback_notes_service_role_all ON feedback_notes
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY consent_events_service_role_all ON consent_events
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY processed_inbound_messages_service_role_all ON processed_inbound_messages
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY processed_payment_events_service_role_all ON processed_payment_events
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY subscription_payments_service_role_all ON subscription_payments
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE users FROM anon, authenticated;
REVOKE ALL ON TABLE monthly_config FROM anon, authenticated;
REVOKE ALL ON TABLE sessions FROM anon, authenticated;
REVOKE ALL ON TABLE holidays FROM anon, authenticated;
REVOKE ALL ON TABLE children FROM anon, authenticated;
REVOKE ALL ON TABLE child_members FROM anon, authenticated;
REVOKE ALL ON TABLE feedback_notes FROM anon, authenticated;
REVOKE ALL ON TABLE consent_events FROM anon, authenticated;
REVOKE ALL ON TABLE processed_inbound_messages FROM anon, authenticated;
REVOKE ALL ON TABLE processed_payment_events FROM anon, authenticated;
REVOKE ALL ON TABLE subscription_payments FROM anon, authenticated;
