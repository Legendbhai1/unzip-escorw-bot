-- Manual escrower-verified payment workflow.
-- The bot no longer has custody of funds: it records payment reports, manual
-- verification, manual release and refunds as audit data only.
-- This migration is forward-only and adds new enum values + tables; it does
-- NOT drop, reset or truncate anything.

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('INR', 'CRYPTO');

-- CreateEnum
CREATE TYPE "PaymentReportStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "EscrowAuditAction" AS ENUM (
  'PAYMENT_REPORTED',
  'PAYMENT_VERIFIED',
  'PAYMENT_REJECTED',
  'EVIDENCE_REQUESTED',
  'EVIDENCE_SUBMITTED',
  'RELEASE_REQUESTED',
  'MANUAL_RELEASE_CONFIRMED',
  'REFUND_REQUESTED',
  'MANUAL_REFUND_CONFIRMED',
  'FEE_RECORDED',
  'DELIVERY_MARKED',
  'DISPUTE_OPENED'
);

-- AlterEnum: new deal states for the manual payment flow
ALTER TYPE "DealStatus" ADD VALUE IF NOT EXISTS 'AWAITING_PAYMENT';
ALTER TYPE "DealStatus" ADD VALUE IF NOT EXISTS 'PAYMENT_REPORTED';
ALTER TYPE "DealStatus" ADD VALUE IF NOT EXISTS 'RELEASE_REQUESTED';

-- AlterTable: deals — manual payment / release / refund audit columns
ALTER TABLE "deals"
  ADD COLUMN "payment_method" "PaymentMethod" NOT NULL DEFAULT 'CRYPTO',
  ADD COLUMN "currency" VARCHAR(10),
  ADD COLUMN "payment_reference" VARCHAR(256),
  ADD COLUMN "payment_reported_at" TIMESTAMPTZ,
  ADD COLUMN "payment_reported_by" UUID,
  ADD COLUMN "payment_verified_at" TIMESTAMPTZ,
  ADD COLUMN "payment_verified_by" UUID,
  ADD COLUMN "payment_evidence" TEXT,
  ADD COLUMN "payment_notes" TEXT,
  ADD COLUMN "release_requested_at" TIMESTAMPTZ,
  ADD COLUMN "released_at" TIMESTAMPTZ,
  ADD COLUMN "released_by" UUID,
  ADD COLUMN "payout_reference" VARCHAR(256),
  ADD COLUMN "payout_method" VARCHAR(20),
  ADD COLUMN "seller_payout_amount" DECIMAL(18,8),
  ADD COLUMN "escrow_fee_amount" DECIMAL(18,8),
  ADD COLUMN "refund_requested_at" TIMESTAMPTZ,
  ADD COLUMN "refunded_at" TIMESTAMPTZ,
  ADD COLUMN "refunded_by" UUID,
  ADD COLUMN "refund_reference" VARCHAR(256);

-- CreateTable
CREATE TABLE "payment_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deal_id" UUID NOT NULL,
    "reported_by" UUID NOT NULL,
    "payment_method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "reference" VARCHAR(256),
    "evidence" TEXT,
    "notes" TEXT,
    "status" "PaymentReportStatus" NOT NULL DEFAULT 'PENDING',
    "verified_by" UUID,
    "verified_at" TIMESTAMPTZ,
    "rejected_at" TIMESTAMPTZ,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escrow_audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deal_id" UUID NOT NULL,
    "action" "EscrowAuditAction" NOT NULL,
    "user_id" UUID,
    "actor_username" VARCHAR(64),
    "amount" DECIMAL(18,8),
    "currency" VARCHAR(10),
    "reference" VARCHAR(256),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escrow_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_reports_deal_id_created_at_idx" ON "payment_reports"("deal_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_reports_status_idx" ON "payment_reports"("status");

-- CreateIndex
CREATE INDEX "escrow_audit_logs_deal_id_created_at_idx" ON "escrow_audit_logs"("deal_id", "created_at");

-- CreateIndex
CREATE INDEX "escrow_audit_logs_action_idx" ON "escrow_audit_logs"("action");

-- AddForeignKey
ALTER TABLE "payment_reports" ADD CONSTRAINT "payment_reports_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_reports" ADD CONSTRAINT "payment_reports_reported_by_fkey" FOREIGN KEY ("reported_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_reports" ADD CONSTRAINT "payment_reports_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escrow_audit_logs" ADD CONSTRAINT "escrow_audit_logs_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escrow_audit_logs" ADD CONSTRAINT "escrow_audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
