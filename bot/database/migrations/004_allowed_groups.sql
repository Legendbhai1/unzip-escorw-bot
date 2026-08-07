-- Migration 004: Group allowlist — only admin-approved groups can use the bot.

CREATE TABLE IF NOT EXISTS allowed_groups (
  chat_id BIGINT PRIMARY KEY,
  title TEXT,
  added_by BIGINT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'active'   -- 'active' | 'revoked'
);

CREATE INDEX IF NOT EXISTS idx_allowed_groups_status ON allowed_groups(status);
