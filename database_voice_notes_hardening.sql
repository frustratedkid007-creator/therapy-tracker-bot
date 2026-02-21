-- Voice note reliability schema updates (idempotent)
-- Run this after database_hardening.sql

ALTER TABLE feedback_notes ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'text';
ALTER TABLE feedback_notes ADD COLUMN IF NOT EXISTS media_id TEXT;
ALTER TABLE feedback_notes ADD COLUMN IF NOT EXISTS transcription_status TEXT DEFAULT 'ok';

CREATE INDEX IF NOT EXISTS idx_feedback_notes_tenant_status_created
  ON feedback_notes(tenant_id, transcription_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_notes_media_id
  ON feedback_notes(media_id);

