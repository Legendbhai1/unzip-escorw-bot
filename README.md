# Escrow Bot

P2P Telegram escrow bot with a **manually-verified** payment workflow.

The bot is an escrow **deal management and audit** system, NOT an automated
crypto wallet. It never receives, monitors, attributes, credits, transfers or
withdraws user funds. The escrower/admin personally verifies incoming payment
and personally pays the seller / refunds the buyer outside the bot.

## What it does

- **Deals**: create a deal via the `[Create Deal]` button, `/form` or the word
  `form` (all share one canonical flow). Choose payment method (**INR / UPI**
  or **USDT BEP20**), your role, the counterparty's Telegram username (they
  must have started the bot), amount, (for USDT: **who pays** — Buyer or
  Seller), category and description, then preview and confirm.
- **Group deal card**: the finished deal is posted to the configured escrow
  group. **The Telegram message itself is the deal reference** — there are no
  web links. The card shows `Status: WAITING FOR ADMIN` with
  `[Accept Deal]` / `[Cancel Deal]` buttons.
- **Admin acceptance**: only an authorized admin can press `Accept Deal`
  (checked server-side). The deal moves to `AWAITING_PAYMENT`, `acceptedBy` /
  `acceptedAt` are recorded, the group card is updated, and both parties
  receive the escrower's payment instructions in DM. Duplicate acceptance is
  rejected and shows who already accepted.
- **Manual payment**: the payer (buyer, or the configured crypto payer for
  USDT deals) pays the escrower directly using the **admin-entered** payment
  details, then taps **Payment Sent / Check Payment** — this only creates a
  `PAYMENT_REPORTED` record. It NEVER funds the deal.
- **Manual verification**: only an authorized admin can verify the payment —
  this is the ONLY way a deal becomes `FUNDED`. The bot never infers payment
  from blockchain events, screenshots, "I paid" or hashes. Both parties are
  then notified in DM ("Payment verified by escrow admin. @buyer and @seller,
  continue the deal here.") with the appropriate controls.
- **Release / Refund (partial or full)**: `/release all`, `/release 50`,
  `/refund all`, `/refund 50` — works by replying to the deal message (or in
  DM, on the last deal you viewed, optionally with the deal code). A release or
  refund request is never executed immediately: the counterparty must agree
  (`[Agree] [Reject] [Dispute]`), then the admin is notified, pays/refunds
  manually outside the bot, and clicks `Mark Release/Refund Completed`.
  Partial amounts keep the deal active with the remaining balance tracked.
- **Fees**: 1% buyer + 1% seller (configurable via `BUYER_FEE_BPS` /
  `SELLER_FEE_BPS`), shown explicitly in the summary and admin screens.
  E.g. ₹10,000 deal: buyer pays ₹10,100, seller receives ₹9,900, escrower earns
  ₹200. Fees are recorded as `FEE_RECORDED` audit entries.
- **Audit**: every financial event (`DEAL_CREATED`, `ADMIN_ACCEPTED`,
  `PAYMENT_INSTRUCTIONS_SENT`, `PAYMENT_REPORTED`, `PAYMENT_VERIFIED`,
  `PAYMENT_REJECTED`, `DELIVERY_MARKED`, `RELEASE_REQUESTED`, `RELEASE_AGREED`,
  `MANUAL_RELEASE_CONFIRMED`, `REFUND_REQUESTED`, `REFUND_AGREED`,
  `MANUAL_REFUND_CONFIRMED`, `FEE_RECORDED`, `DISPUTE_OPENED`,
  `DISPUTE_RESOLVED`) is recorded in `escrow_audit_logs` with deal, actor,
  amount, currency, reference and time.
- **Disputes**: either party can open a dispute after payment is verified;
  admins review and resolve by **manual refund** (`REFUNDED`) or **manual
  release** (`RELEASED`).

## Payment methods (only these two)

| Method | Notes |
|---|---|
| **INR / UPI** | Buyer pays the escrower's UPI ID. |
| **USDT BEP20** | The configured **crypto payer** (Buyer or Seller) sends USDT on BEP20 to the escrower's address. **TRC20, BTC, LTC, ETH and other networks are NOT supported.** |

## Required environment variables

| Variable | Required | Purpose |
|---|---|---|
| `BOT_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `DATABASE_URL` | ✅ | PostgreSQL URL (Prisma migrations auto-apply on deploy) |
| `ADMIN_TELEGRAM_IDS` | ✅ | Comma-separated admin/escrower Telegram IDs (only they can accept deals, verify payment, complete releases/refunds, resolve disputes, edit payment settings) |
| `ESCROW_GROUP_ID` | ⚠️ | Fallback chat id of the escrow group where deal cards are posted (required for the group flow). Can also be set at runtime via `/settings` → `escrow_group_id`, which takes precedence. |

## Payment settings (admin-entered, never generated)

The escrower's receiving details are entered by an authorized admin with
`/settings` in the bot (stored in the `admin_settings` table). The bot NEVER
generates or derives an address. If a method has no details, users see:

> Payment method is currently unavailable. Please contact an admin.

For deployments that have not entered settings yet, the following env vars are
used as a **fallback**:

| Variable | Purpose |
|---|---|
| `ESCROW_UPI_ID` | Escrower's UPI ID for INR deals |
| `ESCROW_UPI_NAME` | Escrower's name shown for INR deals |
| `ESCROW_CRYPTO_ADDRESS_USDT_BEP20` | Escrower's USDT BEP20 receive address |
| `ESCROW_GROUP_ID` | Fallback escrow group chat id (see below) |

The escrow group chat id is also an admin setting (`/settings` →
`escrow_group_id`); the DB value overrides the env fallback, so the group can
be re-pointed without redeploying.

## Flow

```
CREATE DEAL (button / /form / "form")
  → PAYMENT METHOD (INR / UPI | USDT BEP20)
  → ROLE → COUNTERPARTY → AMOUNT → (USDT: CRYPTO PAYER) → CATEGORY → TERMS → CONFIRM
  → deal card posted to escrow group (Status: WAITING FOR ADMIN)
  → ADMIN ACCEPTS (group card) → AWAITING_PAYMENT (acceptedBy/acceptedAt recorded)
  → PAYMENT INSTRUCTIONS sent to both parties in DM
  → PAYER PAYS ESCROWER MANUALLY (UPI or USDT BEP20)
  → PAYER REPORTS (Payment Sent) → PAYMENT_REPORTED
  → ADMIN MANUALLY VERIFIES → FUNDED → both notified in DM
  → SELLER DELIVERS → DELIVERED
  → RELEASE/REFUND REQUEST (/release 50 | /refund all …)
  → COUNTERPARTY AGREES → admin notified
  → ADMIN MANUALLY PAYS/REFUNDS → Mark Release/Refund Completed
  → COMPLETED / REFUNDED (partial amounts keep the deal active)
```

Disputes: `FUNDED/DELIVERED/RELEASE_REQUESTED/REFUND_REQUESTED → DISPUTED →
UNDER_REVIEW → MANUAL_REFUND (REFUNDED)` or `MANUAL_RELEASE (RELEASED)`.

## Commands

- `/start` — main menu
- `/form` or typing `form` — create a deal (works in DM and in the escrow
  group, subject to Telegram permissions)
- `/admin` — admin dashboard (admins only)
- `/settings` — view/edit escrow payment details (admins only)
- `/disputes`, `/review`, `/ban`, `/suspend`, `/user` — admin tooling
- `/release all` | `/release 50` — request a (partial) release; reply to the
  deal message in the group, or use your last viewed deal in DM (optionally
  pass the deal code)
- `/refund all` | `/refund 50` — request a (partial) refund (same context)

## Telegram group setup (permissions)

For the group flow to work, the escrow group should be configured via
`ESCROW_GROUP_ID` (or `/settings` → `escrow_group_id`) and the bot added to it.
Recommended permissions:

- **Add the bot as a group administrator** (or disable **Privacy Mode**) so the
  bot reliably receives messages in the group. This matters for:
  - `/form` and the word `form` in the group (the bot must see the message to
    start the deal form there);
  - `/release all`, `/release 50`, `/refund all`, `/refund 50` when sent as a
    reply to a deal card in the group;
  - making `@username` text into links (admin rights are required for Telegram
    to render `@`-mentions; the bot's own deal card instead uses
    `tg://user?id=…` links, which work without admin rights).
- Inline-button callbacks on the bot's own deal card work regardless of admin
  status, and sessions are keyed **per user** (not per chat), so members in the
  same group never share form state or pending flows.
- The bot posts the deal card itself, so it needs permission to **send
  messages** (and ideally to **edit messages**, which it has for its own
  messages).
- Only admins from `ADMIN_TELEGRAM_IDS` can accept/cancel deals, verify
  payments, complete releases/refunds and resolve disputes — the bot
  re-checks authorization server-side on every callback; a crafted callback
  from a non-admin is rejected.

## Build / test

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

## Legacy / optional variables

- `REDIS_URL` — session storage; falls back to in-memory when unavailable.
- `BUYER_FEE_BPS`, `SELLER_FEE_BPS` — fees (default 100 = 1% each).
- `DEAL_FUNDING_EXPIRY_MS` — payment deadline for `AWAITING_PAYMENT`.
- `DEPOSIT_HD_MNEMONIC`, `TRON_API_KEY`, `TRON_CONTRACT_USDT`, `BSC_RPC_URL`,
  `BSC_CONTRACT_USDT`, `WITHDRAWAL_SIGNER_PRIVATE_KEY`, `MONITOR_POLL_INTERVAL_MS`
  — **legacy custodial-era settings, unused.** The blockchain monitor and the
  withdrawal queue are disabled; the bot holds no funds. The code remains in
  the repo for historical/audit reference.
