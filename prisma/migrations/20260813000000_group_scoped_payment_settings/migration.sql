-- Group-scoped payment settings.
--
-- admin_settings previously used `key` as its primary key, so each setting
-- existed exactly once (global). Escrow payment details must now be
-- configurable PER approved group (each group has its own UPI ID / UPI name /
-- USDT BEP20 receiving address), with "" = the global fallback that groups
-- without their own details fall back to.
--
-- Forward-only: existing rows are kept untouched and become the global
-- fallback (group_id = ''). No data is deleted or reset.

-- 1. New surrogate primary key.
ALTER TABLE "admin_settings" ADD COLUMN "id" UUID NOT NULL DEFAULT gen_random_uuid();

-- 2. Group scope: "" means the global fallback.
ALTER TABLE "admin_settings" ADD COLUMN "group_id" VARCHAR(64) NOT NULL DEFAULT '';

-- 3. Replace the old `key` primary key with the new `id` primary key.
ALTER TABLE "admin_settings" DROP CONSTRAINT "admin_settings_pkey";
ALTER TABLE "admin_settings" ADD CONSTRAINT "admin_settings_pkey" PRIMARY KEY ("id");

-- 4. One value per (key, group) — the global row keeps key + ''.
CREATE UNIQUE INDEX "admin_settings_key_group_id_key" ON "admin_settings"("key", "group_id");
