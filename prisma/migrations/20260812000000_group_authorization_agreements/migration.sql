-- Group authorization + group-specific escrow admins + party agreement to
-- posted deal terms. All changes are additive and forward-only — nothing is
-- dropped, reset or altered destructively. Existing deals/users/audit rows
-- remain untouched.

-- New enums.
CREATE TYPE "GroupStatus" AS ENUM ('APPROVED', 'DISALLOWED');
CREATE TYPE "GroupAdminStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- New audit action: a party agreed to the posted deal card.
ALTER TYPE "EscrowAuditAction" ADD VALUE 'DEAL_AGREED';

-- ── Deals: party agreement + deal terms ──────────────────────────────
ALTER TABLE "deals"
    ADD COLUMN "buyer_agreed_at" TIMESTAMPTZ,
    ADD COLUMN "seller_agreed_at" TIMESTAMPTZ,
    ADD COLUMN "deal_duration" VARCHAR(64),
    ADD COLUMN "deal_deadline_at" TIMESTAMPTZ,
    ADD COLUMN "release_condition" TEXT,
    ADD COLUMN "refund_condition" TEXT;

-- ── Group authorizations (bot-owner approved escrow groups) ──────────
CREATE TABLE "group_authorizations" (
    "group_id" VARCHAR(64) NOT NULL,
    "group_title" VARCHAR(256),
    "status" "GroupStatus" NOT NULL DEFAULT 'APPROVED',
    "allowed_by" UUID,
    "allowed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disallowed_by" UUID,
    "disallowed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_authorizations_pkey" PRIMARY KEY ("group_id")
);

-- ── Group escrow admins (assigned per group by the bot owner) ────────
CREATE TABLE "group_admins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "group_id" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "assigned_by" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "GroupAdminStatus" NOT NULL DEFAULT 'ACTIVE',
    "removed_at" TIMESTAMPTZ,

    CONSTRAINT "group_admins_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "group_admins_group_id_user_id_key" ON "group_admins"("group_id", "user_id");
CREATE INDEX "group_admins_group_id_status_idx" ON "group_admins"("group_id", "status");

-- Foreign keys
ALTER TABLE "group_authorizations"
    ADD CONSTRAINT "group_authorizations_allowed_by_fkey" FOREIGN KEY ("allowed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "group_authorizations_disallowed_by_fkey" FOREIGN KEY ("disallowed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "group_admins"
    ADD CONSTRAINT "group_admins_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "group_authorizations"("group_id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "group_admins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "group_admins_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
