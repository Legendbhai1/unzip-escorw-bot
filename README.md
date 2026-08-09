# Escrow Bot

P2P Telegram escrow bot with a **manually-verified** payment workflow.

The bot is an escrow **deal management and audit** system, NOT an automated
crypto wallet. It never receives, monitors, attributes, credits, transfers or
withdraws user funds. The escrower personally verifies incoming payment and
personally pays the seller outside the bot.

## What it does

- **Deals**: create a deal via the `[Create Deal]` button, `/form` or the word
  `form` (all share one canonical flow). Choose payment method (**INR / UPI**
  or **Crypto**), your role, the counterparty's Telegram username, amount,
  category and description, then preview and confirm. The finished deal card is
  posted to the configured escrow group.
- **Manual payment**: after both parties join, the buyer sees the escrower's
  configured payment instructions (`ESCROW_UPI_ID` / `ESCROW_UPI_NAME` /
  `ESCROW_CRYPTO_ADDRESS_*`). The buyer pays the escrower directly and taps
  **I've Paid**, which only creates a `PAYMENT_REPORTED` record.
- **Manual verification**: only an authorized admin/escrower can verify the
  payment — this is the ONLY way a deal becomes `FUNDED`. The bot never infers
  payment from blockchain events, screenshots, "I paid" or hashes.
- **Manual release**: the buyer accepts delivery → `RELEASE_REQUESTED` → the
  escrower pays the seller manually → admin marks the deal `RELEASED` →
  `COMPLETED`.
- **Fees**: 1% buyer + 1% seller (configurable via `BUYER_FEE_BPS` /
  `SELLER_FEE_BPS`), shown explicitly in the summary and admin release screen.
  E.g. ₹10,000 deal: buyer pays ₹10,100, seller receives ₹9,900, escrower earns
  ₹200. Fees are recorded as `FEE_RECORDED` audit entries.
- **Audit**: every financial event (`PAYMENT_REPORTED`, `PAYMENT_VERIFIED`,
  `PAYMENT_REJECTED`, `RELEASE_REQUESTED`, `MANUAL_RELEASE_CONFIRMED`,
  `REFUND_REQUESTED`, `MANUAL_REFUND_CONFIRMED`, `FEE_RECORDED`) is recorded in
  `escrow_audit_logs` with deal, actor, amount, currency, reference and time.
- **Disputes**: either party can open a dispute after payment is verified;
  admins review and resolve by **manual refund** (`REFUNDED`) or **manual
  release** (`RELEASED`).

## Required environment variables

| Variable | Required | Purpose |
|---|---|---|
| `BOT_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `DATABASE_URL` | ✅ | PostgreSQL URL (Prisma migrations auto-apply on deploy) |
| `ADMIN_TELEGRAM_IDS` | ✅ | Comma-separated admin/escrower Telegram IDs (only they can verify payment / confirm release / resolve disputes) |

## Escrower payment instructions (no generated addresses)

The bot shows the escrower's OWN payment details — it never generates or
derives addresses. If a needed value is unset, the user sees "Payment
instructions are currently unavailable. Please contact the escrower."

| Variable | Purpose |
|---|---|
| `ESCROW_UPI_ID` | Escrower's UPI ID for INR deals |
| `ESCROW_UPI_NAME` | Escrower's name shown for INR deals |
| `ESCROW_CRYPTO_ADDRESS_USDT_TRC20` | Escrower's USDT TRC20 receive address |
| `ESCROW_CRYPTO_ADDRESS_USDT_BEP20` | Escrower's USDT BEP20 receive address |
| `ESCROW_GROUP_ID` | Chat id where the deal form card is posted (optional; skipped when empty) |

## Legacy / optional variables

- `REDIS_URL` — session storage; falls back to in-memory when unavailable.
- `BUYER_FEE_BPS`, `SELLER_FEE_BPS` — fees (default 100 = 1% each).
- `DEAL_FUNDING_EXPIRY_MS` — payment deadline for `AWAITING_PAYMENT`.
- `DEPOSIT_HD_MNEMONIC`, `TRON_API_KEY`, `TRON_CONTRACT_USDT`, `BSC_RPC_URL`,
  `BSC_CONTRACT_USDT`, `WITHDRAWAL_SIGNER_PRIVATE_KEY`, `MONITOR_POLL_INTERVAL_MS`
  — **legacy custodial-era settings, unused.** The blockchain monitor and the
  withdrawal queue are disabled; the bot holds no funds. The code remains in
  the repo for historical/audit reference.

## Flow

```
CREATE DEAL (button / /form / "form")
  → PAYMENT METHOD (INR / UPI | Crypto)
  → ROLE → COUNTERPARTY → AMOUNT → TERMS → CONFIRM
  → deal card posted to escrow group
  → COUNTERPARTY ACCEPTS → AWAITING_PAYMENT
  → PAYMENT INSTRUCTIONS (escrower's configured details)
  → BUYER PAYS ESCROWER MANUALLY
  → BUYER REPORTS (I've Paid) → PAYMENT_REPORTED
  → ESCROWER MANUALLY VERIFIES → FUNDED
  → SELLER DELIVERS → DELIVERED
  → BUYER ACCEPTS → RELEASE_REQUESTED
  → ESCROWER MANUALLY PAYS SELLER → MARKS RELEASED → COMPLETED
```

Disputes: `FUNDED/DELIVERED/RELEASE_REQUESTED → DISPUTED → UNDER_REVIEW →
MANUAL_REFUND (REFUNDED)` or `MANUAL_RELEASE (RELEASED)`.

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
