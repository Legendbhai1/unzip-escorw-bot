# Escrow Bot

P2P Crypto Escrow Telegram Bot — custodial escrow for legitimate trades.

## What it does

- **Deals**: create a deal, invite the counterparty by Telegram username, both
  parties accept, buyer funds the escrow from their in-app wallet.
- **Wallet**: users deposit USDT (TRC20 / BEP20) to their own deposit address;
  funds are credited after the required confirmations.
- **Escrow**: 1% buyer fee + 1% seller fee (configurable via
  `BUYER_FEE_BPS` / `SELLER_FEE_BPS`). For a 100 USDT deal: buyer pays 101,
  100 is locked, seller receives 99, platform earns 2.
- **Disputes**: either party can open a dispute; admins review and resolve.
- **Ledger**: all balance changes flow through an append-only double-entry
  ledger (`treasuryService`) with idempotency keys.

## Required environment variables

| Variable | Required | Purpose |
|---|---|---|
| `BOT_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `DATABASE_URL` | ✅ | PostgreSQL URL (Prisma migrations auto-apply on deploy) |
| `ADMIN_TELEGRAM_IDS` | ✅ | Comma-separated admin Telegram IDs |
| `DEPOSIT_HD_MNEMONIC` | ✅ | **Secret.** BIP-39 mnemonic used ONLY to derive per-user deposit addresses (BIP-44: `m/44'/60'/0'/0/{i}` for BEP20, `m/44'/195'/0'/0/{i}` for TRC20). If missing/invalid, the Deposit screen shows “Deposits temporarily unavailable — address not configured.” Never commit, log, or reuse it as a withdrawal signing key. |

Optional: `TRON_API_KEY`, `TRON_CONTRACT_USDT`, `BSC_RPC_URL`,
`BSC_CONTRACT_USDT`, `REDIS_URL` (falls back to in-memory sessions when
unavailable), `WITHDRAWAL_SIGNER_PRIVATE_KEY`, `NODE_ENV`, `LOG_LEVEL`,
`MONITOR_POLL_INTERVAL_MS`, `RECONCILIATION_INTERVAL_MS`.

> The sandbox blocks editing `.env.example`; add the same keys to your
> `.env`/hosting dashboard.

## Commands

```bash
npm install
npx prisma generate
npx prisma migrate deploy   # applies migrations (forward-only)
npm run build               # tsc -> dist/
npm start                   # node dist/index.js (long polling + health server)
npm test                    # vitest (needs a local Postgres at the URL in vitest.config.ts)
```

## Deployment (Render)

Build: `npm install && npx prisma generate && npx prisma migrate deploy && npm run build`
Start: `npm start`

The app binds a minimal HTTP health endpoint on `PORT` (default 8080) so
Render can mark the service live.
