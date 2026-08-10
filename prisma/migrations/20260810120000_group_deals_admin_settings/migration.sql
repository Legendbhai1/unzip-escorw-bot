-- Group deal admin acceptance, crypto payer, partial release/refund and
-- admin-entered payment settings. All changes are additive and forward-only.

-- New enum: who pays USDT to the escrow (USDT deals only).
CREATE TYPE "CryptoPayer" AS ENUM ('BUYER', 'SELLER');

-- New deal status for the manual refund request flow.
ALTER TYPE "DealStatus" ADD VALUE 'REFUND_REQUESTED';

-- New audit actions for the group/manual workflow.
ALTER TYPE "EscrowAuditAction" ADD VALUE 'DEAL_CREATED';
ALTER TYPE "EscrowAuditAction" ADD VALUE 'ADMIN_ACCEPTED';
ALTER TYPE "EscrowAuditAction" ADD VALUE 'PAYMENT_INSTRUCTIONS_SENT';
ALTER TYPE "EscrowAuditAction" ADD VALUE 'RELEASE_AGREED';
ALTER TYPE "EscrowAuditAction" ADD VALUE 'REFUND_AGREED';
ALTER TYPE "EscrowAuditAction" ADD VALUE 'DISPUTE_RESOLVED';

-- ── Deals: new columns ──────────────────────────────────────────────
ALTER TABLE "deals"
    ADD COLUMN "crypto_payer" "CryptoPayer",
    ADD COLUMN "accepted_by" UUID,
    ADD COLUMN "accepted_at" TIMESTAMPTZ,
    ADD COLUMN "payment_instructions_sent_at" TIMESTAMPTZ,
    ADD COLUMN "group_chat_id" VARCHAR(64),
    ADD COLUMN "group_message_id" INTEGER,
    ADD COLUMN "release_requested_by" UUID,
    ADD COLUMN "release_requested_amount" DECIMAL(18,8),
    ADD COLUMN "release_requested_from" VARCHAR(20),
    ADD COLUMN "release_agreed_by" UUID,
    ADD COLUMN "release_agreed_at" TIMESTAMPTZ,
    ADD COLUMN "released_amount" DECIMAL(18,8) NOT NULL DEFAULT 0,
    ADD COLUMN "refund_requested_by" UUID,
    ADD COLUMN "refund_requested_amount" DECIMAL(18,8),
    ADD COLUMN "refund_requested_from" VARCHAR(20),
    ADD COLUMN "refund_agreed_by" UUID,
    ADD COLUMN "refund_agreed_at" TIMESTAMPTZ,
    ADD COLUMN "refunded_amount" DECIMAL(18,8) NOT NULL DEFAULT 0,
    ADD COLUMN "remaining_amount" DECIMAL(18,8);

-- ── Admin settings (escrower's manually entered payment details) ────
CREATE TABLE "admin_settings" (
    "key" VARCHAR(64) NOT NULL,
    "value" TEXT NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "admin_settings_pkey" PRIMARY KEY ("key")
);

-- AddForeignKey
ALTER TABLE "admin_settings" ADD CONSTRAINT "admin_settings_updated_by_fkey"
    FOREIGN KEY ("updated_by") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
