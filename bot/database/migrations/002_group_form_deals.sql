-- Group-chat text-form escrow flow (NFT MRKT ESCROW FORM)
-- Separate from the older wizard-based `deals` table so the existing
-- release/dispute/escrower flows are untouched.

CREATE TABLE IF NOT EXISTS group_deals (
  id SERIAL PRIMARY KEY,
  escrow_id TEXT UNIQUE,                -- set once both sides agree, e.g. ESC-8F42A1

  chat_id BIGINT NOT NULL,
  form_message_id BIGINT,               -- message id of the bot's "agree" card (edited as state changes)

  description TEXT NOT NULL,
  amount TEXT NOT NULL,
  condition TEXT NOT NULL,
  eta TEXT NOT NULL,

  seller_username TEXT NOT NULL,        -- lowercase, no leading @
  buyer_username TEXT NOT NULL,

  seller_id BIGINT,                     -- filled in once that user taps Agree
  buyer_id BIGINT,
  seller_agreed BOOLEAN NOT NULL DEFAULT false,
  buyer_agreed BOOLEAN NOT NULL DEFAULT false,
  seller_agreed_at TIMESTAMPTZ,
  buyer_agreed_at TIMESTAMPTZ,

  status TEXT NOT NULL DEFAULT 'AWAITING_AGREEMENT',
  -- AWAITING_AGREEMENT | AWAITING_ADMIN | CLAIMED | FORWARDED | DISCARDED

  created_by BIGINT NOT NULL,
  claimed_by BIGINT,                    -- admin who pressed "Accept Deal" — owns forward/discard from here
  claimed_at TIMESTAMPTZ,
  resolved_by BIGINT,
  resolved_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_group_deals_escrow_id ON group_deals(escrow_id);
CREATE INDEX IF NOT EXISTS idx_group_deals_status ON group_deals(status);
CREATE INDEX IF NOT EXISTS idx_group_deals_chat ON group_deals(chat_id);

-- Own event log (kept separate from deal_events, which FKs to the older `deals` table)
CREATE TABLE IF NOT EXISTS group_deal_events (
  id SERIAL PRIMARY KEY,
  group_deal_id INT NOT NULL REFERENCES group_deals(id),
  actor_telegram_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_group_deal_events_deal ON group_deal_events(group_deal_id);
