-- Therapy Tracker Database Schema for Supabase

-- Users table
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  waiting_for TEXT,
  timezone TEXT DEFAULT 'Asia/Kolkata',
  reminders_enabled BOOLEAN DEFAULT TRUE,
  last_reminder_sent DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Monthly configuration table
CREATE TABLE monthly_config (
  id BIGSERIAL PRIMARY KEY,
  user_phone TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
  month TEXT NOT NULL, -- Format: YYYY-MM
  paid_sessions INTEGER NOT NULL,
  cost_per_session INTEGER NOT NULL,
  carry_forward INTEGER DEFAULT 0,
  child_id BIGINT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_phone, month)
);

-- Sessions table
CREATE TABLE sessions (
  id BIGSERIAL PRIMARY KEY,
  user_phone TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
  date DATE NOT NULL,
  month TEXT NOT NULL, -- Format: YYYY-MM
  status TEXT NOT NULL CHECK (status IN ('attended', 'cancelled')),
  reason TEXT,
  child_id BIGINT,
  logged_by TEXT,
  sessions_done INTEGER DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Holidays table
CREATE TABLE holidays (
  id BIGSERIAL PRIMARY KEY,
  user_phone TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
  date DATE NOT NULL,
  month TEXT NOT NULL, -- Format: YYYY-MM
  child_id BIGINT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_phone, date)
);

-- Indexes for better performance
CREATE INDEX idx_sessions_user_month ON sessions(user_phone, month);
CREATE INDEX idx_sessions_date ON sessions(date);
CREATE INDEX idx_sessions_child_month ON sessions(child_id, month);
CREATE INDEX idx_monthly_config_user_month ON monthly_config(user_phone, month);
CREATE INDEX idx_holidays_user_month ON holidays(user_phone, month);
CREATE INDEX idx_holidays_child_month ON holidays(child_id, month);

-- Enable Row Level Security (RLS) - Optional but recommended
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE holidays ENABLE ROW LEVEL SECURITY;

-- Create policies (allows service role to access all data)
CREATE POLICY "Enable all access for service role" ON users FOR ALL USING (true);
CREATE POLICY "Enable all access for service role" ON monthly_config FOR ALL USING (true);
CREATE POLICY "Enable all access for service role" ON sessions FOR ALL USING (true);
CREATE POLICY "Enable all access for service role" ON holidays FOR ALL USING (true);
-- Children (shared credit entity)
CREATE TABLE children (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(phone) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Child members
CREATE TABLE child_members (
  id BIGSERIAL PRIMARY KEY,
  child_id BIGINT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  member_phone TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
  role TEXT DEFAULT 'member',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(child_id, member_phone)
);

CREATE TABLE processed_inbound_messages (
  id BIGSERIAL PRIMARY KEY,
  message_id TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_processed_inbound_messages_created_at ON processed_inbound_messages(created_at);
