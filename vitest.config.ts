import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      BOT_TOKEN: 'test_token',
      DATABASE_URL: 'postgresql://escrow:escrow_pass@localhost:5432/escrow_db',
      REDIS_URL: 'redis://localhost:6379',
      // Refund tests document: "buyerFeeRefundOnRefund = false is the test default"
      BUYER_FEE_REFUND_ON_REFUND: 'false',
      // Public BIP-39 test mnemonic — used ONLY by tests that exercise
      // deposit-address derivation. Tests that verify missing-mnemonic
      // behavior delete this env var at runtime.
      DEPOSIT_HD_MNEMONIC: 'test test test test test test test test test test test junk',
      // Escrower manual payment instructions (used by payment-instruction tests)
      ESCROW_UPI_ID: 'escrow@upi.example',
      ESCROW_UPI_NAME: 'Escrow Services',
      ESCROW_CRYPTO_ADDRESS_USDT_TRC20: 'TTestEscrowerAddress1234567890ABCDEF',
      ESCROW_CRYPTO_ADDRESS_USDT_BEP20: '0xTestEscrowerBep20Address0000000000000000000001',
    },
    // Test files share a single Postgres database (cleanAll deletes rows), so
    // run files sequentially to avoid cross-file interference.
    fileParallelism: false,
  },
});
