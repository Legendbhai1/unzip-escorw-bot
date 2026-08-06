-- ESCORW core schema

CREATE TABLE IF NOT EXISTS users (
  telegram_id BIGINT PRIMARY KEY,
  username TEXT,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user', -- user | escrower | admin
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS escrowers (
  telegram_id BIGINT PRIMARY KEY REFERENCES users(telegram_id),
  username TEXT,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | INACTIVE | SUSPENDED
  max_deal_limit NUMERIC(20,2) NOT NULL DEFAULT 1000,
  supported_assets TEXT[] NOT NULL DEFAULT '{}',
  completed_deals INT NOT NULL DEFAULT 0,
  disputes_handled INT NOT NULL DEFAULT 0,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY, -- e.g. ESC-8F42A1
  deal_type TEXT NOT NULL, -- NORMAL | P2P
  description TEXT NOT NULL,
  amount NUMERIC(20,2) NOT NULL,
  currency TEXT NOT NULL,
  buyer_id BIGINT NOT NULL,
  seller_id BIGINT NOT NULL,
  escrower_id BIGINT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  -- PENDING | ACTIVE | RELEASE_REQUESTED | DISPUTED | RESOLVED_RELEASE
  -- RESOLVED_REFUND | COMPLETED | CANCELLED | EXPIRED
  release_condition TEXT,
  refund_condition TEXT,
  notes TEXT,
  fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  deadline TIMESTAMPTZ,
  delivered BOOLEAN NOT NULL DEFAULT false,
  payment_marked BOOLEAN NOT NULL DEFAULT false,
  timer_paused BOOLEAN NOT NULL DEFAULT false,
  warned_12h BOOLEAN NOT NULL DEFAULT false,
  warned_23h BOOLEAN NOT NULL DEFAULT false,
  created_by BIGINT NOT NULL,
  activated_by_user_id BIGINT,
  completed_by_user_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deal_participants (
  id SERIAL PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  telegram_id BIGINT NOT NULL,
  role TEXT NOT NULL, -- buyer | seller | escrower
  UNIQUE(deal_id, telegram_id, role)
);

CREATE TABLE IF NOT EXISTS deal_events (
  id SERIAL PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  actor_telegram_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS release_requests (
  id SERIAL PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  requested_by BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | CONFIRMED | REJECTED
  confirmed_by BIGINT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS disputes (
  id SERIAL PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  opened_by BIGINT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'DISPUTED',
  -- DISPUTED | RESOLVED_RELEASE | RESOLVED_REFUND | CANCELLED
  resolved_by BIGINT,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS dispute_messages (
  id SERIAL PRIMARY KEY,
  dispute_id INT NOT NULL REFERENCES disputes(id),
  sender_telegram_id BIGINT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_actions (
  id SERIAL PRIMARY KEY,
  admin_telegram_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  deal_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value)
VALUES ('fee_percent', '0'), ('inactivity_timeout_hours', '24')
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status);
CREATE INDEX IF NOT EXISTS idx_deals_escrower ON deals(escrower_id);
CREATE INDEX IF NOT EXISTS idx_deal_events_deal ON deal_events(deal_id);
