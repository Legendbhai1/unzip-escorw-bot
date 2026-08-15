-- Forward-only migration: add the PAYMENT_RECEIVED terminal status and the
-- PAYMENT_RECEIVED audit action.
-- The bot's scope now ends when the assigned escrow admin manually confirms
-- payment received; delivery/payout continue manually outside the bot.
-- Adding enum values is additive and never touches existing rows.
ALTER TYPE "DealStatus" ADD VALUE 'PAYMENT_RECEIVED';
ALTER TYPE "EscrowAuditAction" ADD VALUE 'PAYMENT_RECEIVED';
