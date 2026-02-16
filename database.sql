-- Therapy Tracker Database Schema for Supabase

-- Users table
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  waiting_for TEXT,
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
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Holidays table
CREATE TABLE holidays (
  id BIGSERIAL PRIMARY KEY,
  user_phone TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
  date DATE NOT NULL,
  month TEXT NOT NULL, -- Format: YYYY-MM
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_phone, date)
);

-- Indexes for better performance
CREATE INDEX idx_sessions_user_month ON sessions(user_phone, month);
CREATE INDEX idx_sessions_date ON sessions(date);
CREATE INDEX idx_monthly_config_user_month ON monthly_config(user_phone, month);
CREATE INDEX idx_holidays_user_month ON holidays(user_phone, month);

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
