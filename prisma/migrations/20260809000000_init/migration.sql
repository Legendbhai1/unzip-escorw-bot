-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('CREATED', 'JOINED', 'AWAITING_FUNDING', 'FUNDED', 'IN_PROGRESS', 'DELIVERED', 'RELEASE_PENDING', 'COMPLETED', 'DISPUTED', 'UNDER_REVIEW', 'REFUNDED', 'RELEASED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DealRole" AS ENUM ('BUYER', 'SELLER');

-- CreateEnum
CREATE TYPE "DealCategory" AS ENUM ('FREELANCE_SERVICES', 'PHYSICAL_GOODS', 'GIFT_CARDS', 'OTHER_LAWFUL');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'ESCROW_LOCK', 'ESCROW_RELEASE', 'REFUND', 'FEE');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPENED', 'UNDER_REVIEW', 'RESOLVED');

-- CreateEnum
CREATE TYPE "DisputeResolution" AS ENUM ('RELEASE_TO_SELLER', 'REFUND_BUYER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'BANNED');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'ESCROW_LOCK', 'ESCROW_RELEASE', 'REFUND', 'FEE');

-- CreateEnum
CREATE TYPE "ReferenceType" AS ENUM ('DEAL', 'TRANSACTION', 'DISPUTE', 'WITHDRAWAL_REQUEST', 'BLOCKCHAIN_DEPOSIT');

-- CreateEnum
CREATE TYPE "AdminActionType" AS ENUM ('DISPUTE_RESOLVE_RELEASE', 'DISPUTE_RESOLVE_REFUND', 'DEAL_CANCEL', 'USER_SUSPEND', 'USER_BAN', 'WITHDRAWAL_APPROVE', 'WITHDRAWAL_REJECT');

-- CreateEnum
CREATE TYPE "WithdrawalRequestStatus" AS ENUM ('PENDING', 'RESERVING', 'QUEUED', 'BROADCASTING', 'CONFIRMING', 'COMPLETED', 'FAILED', 'REVERSED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "telegram_id" BIGINT NOT NULL,
    "username" VARCHAR(64),
    "first_name" VARCHAR(128) NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balances" (
    "user_id" UUID NOT NULL,
    "asset" VARCHAR(10) NOT NULL,
    "available" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "locked" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "balances_pkey" PRIMARY KEY ("user_id","asset")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invite_code" VARCHAR(12) NOT NULL,
    "buyer_id" UUID NOT NULL,
    "seller_id" UUID,
    "asset" VARCHAR(10) NOT NULL,
    "network" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "buyer_fee_bps" INTEGER NOT NULL DEFAULT 100,
    "seller_fee_bps" INTEGER NOT NULL DEFAULT 100,
    "buyer_fee_amount" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "seller_fee_amount" DECIMAL(18,8) NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "category" "DealCategory" NOT NULL,
    "status" "DealStatus" NOT NULL,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" VARCHAR(32) NOT NULL,
    "asset" VARCHAR(10) NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "network" VARCHAR(20),
    "idempotency_key" VARCHAR(128) NOT NULL,
    "deal_id" UUID,
    "reference_type" VARCHAR(32),
    "reference_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" BIGSERIAL NOT NULL,
    "ledger_tx_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "deal_id" UUID,
    "type" "LedgerEntryType" NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "asset" VARCHAR(10) NOT NULL,
    "balance_after" DECIMAL(18,8) NOT NULL,
    "referenceType" "ReferenceType",
    "reference_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blockchain_deposits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "tx_hash" VARCHAR(128) NOT NULL,
    "log_index" INTEGER NOT NULL DEFAULT 0,
    "from_address" VARCHAR(128) NOT NULL,
    "to_address" VARCHAR(128) NOT NULL,
    "asset" VARCHAR(10) NOT NULL,
    "network" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "required_confs" INTEGER NOT NULL DEFAULT 20,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "credited_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blockchain_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" "TransactionType" NOT NULL,
    "asset" VARCHAR(10) NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "tx_hash" VARCHAR(128),
    "deal_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "asset" VARCHAR(10) NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "network" VARCHAR(20) NOT NULL,
    "to_address" VARCHAR(128) NOT NULL,
    "status" "WithdrawalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "idempotency_key" VARCHAR(128) NOT NULL,
    "tx_hash" VARCHAR(128),
    "ledger_tx_id" UUID,
    "error" TEXT,
    "reserved_at" TIMESTAMPTZ,
    "queued_at" TIMESTAMPTZ,
    "broadcast_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "failed_at" TIMESTAMPTZ,
    "reversed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deal_id" UUID NOT NULL,
    "opened_by" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPENED',
    "resolution" "DisputeResolution",
    "assigned_admin" UUID,
    "resolved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_evidence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dispute_id" UUID NOT NULL,
    "submitted_by" UUID NOT NULL,
    "message" TEXT NOT NULL,
    "file_type" VARCHAR(50),
    "file_id" VARCHAR(256),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_id" UUID NOT NULL,
    "action_type" "AdminActionType" NOT NULL,
    "deal_id" UUID,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_id_key" ON "users"("telegram_id");

-- CreateIndex
CREATE UNIQUE INDEX "deals_invite_code_key" ON "deals"("invite_code");

-- CreateIndex
CREATE INDEX "deals_buyer_id_status_idx" ON "deals"("buyer_id", "status");

-- CreateIndex
CREATE INDEX "deals_seller_id_status_idx" ON "deals"("seller_id", "status");

-- CreateIndex
CREATE INDEX "deals_status_idx" ON "deals"("status");

-- CreateIndex
CREATE INDEX "deals_status_expires_at_idx" ON "deals"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_idempotency_key_key" ON "ledger_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "ledger_transactions_type_created_at_idx" ON "ledger_transactions"("type", "created_at");

-- CreateIndex
CREATE INDEX "ledger_transactions_deal_id_idx" ON "ledger_transactions"("deal_id");

-- CreateIndex
CREATE INDEX "ledger_transactions_idempotency_key_idx" ON "ledger_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "ledger_entries_user_id_created_at_idx" ON "ledger_entries"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "ledger_entries_ledger_tx_id_idx" ON "ledger_entries"("ledger_tx_id");

-- CreateIndex
CREATE INDEX "blockchain_deposits_user_id_created_at_idx" ON "blockchain_deposits"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "blockchain_deposits_status_network_idx" ON "blockchain_deposits"("status", "network");

-- CreateIndex
CREATE INDEX "blockchain_deposits_to_address_idx" ON "blockchain_deposits"("to_address");

-- CreateIndex
CREATE UNIQUE INDEX "blockchain_deposits_network_tx_hash_log_index_key" ON "blockchain_deposits"("network", "tx_hash", "log_index");

-- CreateIndex
CREATE INDEX "transactions_user_id_created_at_idx" ON "transactions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "transactions_status_idx" ON "transactions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_requests_idempotency_key_key" ON "withdrawal_requests"("idempotency_key");

-- CreateIndex
CREATE INDEX "withdrawal_requests_user_id_status_idx" ON "withdrawal_requests"("user_id", "status");

-- CreateIndex
CREATE INDEX "withdrawal_requests_status_created_at_idx" ON "withdrawal_requests"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "disputes_deal_id_key" ON "disputes"("deal_id");

-- CreateIndex
CREATE INDEX "admin_actions_admin_id_created_at_idx" ON "admin_actions"("admin_id", "created_at");

-- AddForeignKey
ALTER TABLE "balances" ADD CONSTRAINT "balances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_ledger_tx_id_fkey" FOREIGN KEY ("ledger_tx_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blockchain_deposits" ADD CONSTRAINT "blockchain_deposits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_ledger_tx_id_fkey" FOREIGN KEY ("ledger_tx_id") REFERENCES "ledger_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_opened_by_fkey" FOREIGN KEY ("opened_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_assigned_admin_fkey" FOREIGN KEY ("assigned_admin") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

