-- CreateTable
CREATE TABLE "deposit_addresses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "network" VARCHAR(20) NOT NULL,
    "asset" VARCHAR(10) NOT NULL,
    "address" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deposit_addresses_user_id_network_asset_idx" ON "deposit_addresses"("user_id", "network", "asset");

-- CreateIndex
CREATE INDEX "deposit_addresses_network_asset_address_idx" ON "deposit_addresses"("network", "asset", "address");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_addresses_network_asset_address_key" ON "deposit_addresses"("network", "asset", "address");

-- AddForeignKey
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
