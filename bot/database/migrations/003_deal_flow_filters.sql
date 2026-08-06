-- Migration 003: Deal flow enhancements, filters, and deadline alerts for group_deals

-- 1) Admin chat filters (word -> bot response)
CREATE TABLE IF NOT EXISTS chat_filters (
  id SERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  trigger_word TEXT NOT NULL,
  bot_response TEXT NOT NULL,
  created_by BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(chat_id, trigger_word)
);

CREATE INDEX IF NOT EXISTS idx_chat_filters_chat ON chat_filters(chat_id);

-- 2) Group deal flow state: track payment, release, refund stages
ALTER TABLE group_deals
  ADD COLUMN IF NOT EXISTS payment_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_received_by BIGINT,
  ADD COLUMN IF NOT EXISTS status_after_payment TEXT DEFAULT 'PAYMENT_CONFIRMED',
  -- PAYMENT_CONFIRMED | RELEASED | REFUNDED | REVERSED | EXPIRED
  ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS released_by BIGINT,
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refunded_by BIGINT,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS eta_minutes INT,
  ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_warning_sent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS second_warning_sent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS expired_after_warnings BOOLEAN NOT NULL DEFAULT false;

-- 3) /fee command response stored in settings
INSERT INTO settings (key, value)
VALUES ('fee_info', 'Contact admin for escrow fee details.')
ON CONFLICT (key) DO NOTHING;

-- 4) /dispute command (standalone) handler expects dispute info
INSERT INTO settings (key, value)
VALUES ('dispute_info', 'To open a dispute, use the ⚖️ Open Dispute button on the deal details view or tap the dispute button on an active deal.')
ON CONFLICT (key) DO NOTHING;
