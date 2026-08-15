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
  Seller), category, description, **deal duration**, **release condition** and
  **refund condition**, then preview and confirm. The duration is a
  term/deadline only — the bot never auto-refunds or auto-releases when it
  passes.
- **Group deal card**: the finished deal is posted to an **approved** escrow
  group. **The Telegram message itself is the deal reference** — there are no
  web links. The card shows the full terms and a `🤝 Agreement` section with
  `[✅ Agree to Deal]`. The bot identifies WHO clicked and records the
  agreement for that party only — nobody can agree on someone else's behalf.
- **Party agreement**: once **both** parties have agreed to the posted terms,
  the card shows `Status: WAITING FOR ADMIN` with `[🛡 Accept Deal]`, and the
  owner + that group's escrow admins are notified in DM.
- **Group authorization**: only the bot owner can authorize a group
  (`/allowgroup` inside the group, persisted in the DB). `/disallowgroup`
  disables new escrow activity in the group **without deleting** deals, users
  or audit records. Deal creation is refused until the escrow group is
  approved.
- **Group-specific escrow admins**: the owner assigns admins per group with
  `/addadmin @user` (inside that group). Being a normal Telegram group admin
  gives **no** escrow powers — every sensitive action is re-checked
  server-side against the active assignment for **that specific group**.
- **Admin acceptance**: only the bot owner, a global admin, or an ACTIVE
  escrow admin for the deal's group can press `Accept Deal` (checked
  server-side, and only after both parties agreed). The deal moves to
  `AWAITING_PAYMENT`, `acceptedBy` / `acceptedAt` are recorded, and the group
  card itself becomes the payment instructions for THAT group: the exact
  amount to pay, the escrower's configured receiving details (scoped to the
  deal's group) and an `[I've Paid]` button for the payer. No payment details
  are DMed to the parties. Duplicate acceptance is rejected and shows who
  already accepted.
- **Manual payment**: the payer (buyer, or the configured crypto payer for
  USDT deals) pays the escrower directly using the **admin-entered** payment
  details, then taps **Payment Sent / Check Payment** — this only creates a
  `PAYMENT_REPORTED` record. It NEVER funds the deal.
- **Manual verification**: ONLY the admin who **accepted** the deal
  (`acceptedBy`) can verify its payment — other admins are never notified and
  their callbacks are rejected server-side. This is the ONLY way a deal
  becomes `PAYMENT_RECEIVED`, the terminal state of the bot. The bot never
  infers payment from blockchain events, screenshots, "I paid" or hashes.
  The group card is updated to 🟢 `PAYMENT RECEIVED` and the bot stops — no
  party DMs, no release/refund/delivery buttons.
- **The bot stops at PAYMENT_RECEIVED**: delivery, payout and refunds happen
  **manually outside the bot**. `/release`, `/refund` and the old
  deliver/release/refund buttons are disabled (they answer with a clear
  message and never touch a deal). The service-layer release/refund/dispute
  code remains in the repo for historical rows and audit, but the current
  flow never reaches it.
- **Fees**: 1% buyer + 1% seller (configurable via `BUYER_FEE_BPS` /
  `SELLER_FEE_BPS`), shown explicitly in the summary and admin screens.
  E.g. ₹10,000 deal: buyer pays ₹10,100, seller receives ₹9,900, escrower earns
  ₹200. Fees are recorded as `FEE_RECORDED` audit entries.
- **Stale-button / stale-text protection**: every interactive flow (deal form,
  payment report, evidence, settings) is ONE authoritative flow per user with
  a version **token** stamped into the buttons it renders and rotated on every
  step. Buttons from older messages carry an older token and are rejected with
  "This button has expired. Please use the latest deal message." — they can
  never restart or rewind a flow. Free text is only consumed in the chat where
  the flow started (a message typed in another chat is never interpreted by an
  old question) and abandoned flows expire after 30 minutes.
- **Audit**: every financial event (`DEAL_CREATED`, `ADMIN_ACCEPTED`,
  `PAYMENT_INSTRUCTIONS_SENT`, `PAYMENT_REPORTED`, `PAYMENT_VERIFIED`,
  `PAYMENT_REJECTED`, `DELIVERY_MARKED`, `RELEASE_REQUESTED`, `RELEASE_AGREED`,
  `MANUAL_RELEASE_CONFIRMED`, `REFUND_REQUESTED`, `REFUND_AGREED`,
  `MANUAL_REFUND_CONFIRMED`, `FEE_RECORDED`, `DISPUTE_OPENED`,
  `DISPUTE_RESOLVED`) is recorded in `escrow_audit_logs` with deal, actor,
  amount, currency, reference and time.
- **Disputes**: legacy flow kept for historical rows; the current bot ends at
  `PAYMENT_RECEIVED`, so disputes after that point are handled manually
  outside the bot.

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
| `ADMIN_TELEGRAM_IDS` | ✅ | Comma-separated global admin/escrower Telegram IDs (they can accept deals, verify payment, edit payment settings; group-scoped escrow admins via `/addadmin` too) |
| `ESCROW_GROUP_ID` | ⚠️ | Fallback chat id of the escrow group where deal cards are posted. Can also be set at runtime via `/settings` → `escrow_group_id` (the DB value takes precedence). The group must also be authorized by the owner with `/allowgroup`; if unset, the first approved group is used |
| `BOT_OWNER_TELEGRAM_ID` | ⚠️ | The single bot owner who can run `/allowgroup`, `/disallowgroup`, `/addadmin`, `/removeadmin`, `/groupadmins`. Falls back to the first `ADMIN_TELEGRAM_IDS` entry when unset |

## Payment settings (admin-entered, never generated)

The escrower's receiving details are entered by an authorized admin with
`/settings` and stored in the `admin_settings` table. Settings are **scoped per
authorized escrow group**: each group can have its own UPI ID, UPI name and
USDT BEP20 receiving address, so different groups (with different escrow
admins) never show each other's details.

- Running `/settings` **inside a group** edits that group's own details (bot
  owner, a global admin, or that group's escrow admin only).
- Running `/settings` **in DM** edits the **global fallback**, which any group
  without its own details falls back to.

If a method has no details for a group (and no global fallback), users see:

> Payment method is currently unavailable. Please contact an admin.

For deployments that have not entered settings yet, the following env vars are
used as a **deployment-level fallback**:

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
OWNER: /allowgroup in the group, then /addadmin @user for its escrow admins
CREATE DEAL (button / /form / "form")
  → PAYMENT METHOD (INR / UPI | USDT BEP20)
  → ROLE → COUNTERPARTY → AMOUNT → (USDT: CRYPTO PAYER) → CATEGORY
  → DESCRIPTION → DEAL DURATION → RELEASE CONDITION → REFUND CONDITION → CONFIRM
  → deal card posted to the APPROVED escrow group the form ran in
    (DM forms use the configured escrow group; Status: WAITING FOR PARTY AGREEMENT)
  → BUYER [✅ Agree to Deal] → SELLER [✅ Agree to Deal] (bot records who clicked)
  → BOTH AGREED → Status: WAITING FOR ADMIN → owner + group admins notified
  → GROUP ESCROW ADMIN [🛡 Accept Deal] → AWAITING_PAYMENT (acceptedBy/acceptedAt recorded)
  → THE GROUP CARD BECOMES THE PAYMENT INSTRUCTIONS: exact amount + that
    group's escrow details + [I've Paid] (nothing DMed to the parties)
  → PAYER PAYS ESCROWER MANUALLY (INR: buyer pays UPI · USDT: the configured crypto payer)
  → PAYER REPORTS (I've Paid) → PAYMENT_REPORTED → group card updated
  → ONLY THE ASSIGNED ADMIN gets the verification prompt in DM
  → ASSIGNED ADMIN MANUALLY VERIFIES → PAYMENT_RECEIVED ✅ → group card updated → STOP
  → THE BOT'S JOB IS DONE — delivery/payout continue manually outside the bot
```

The assigned admin (the one who clicked Accept Deal) is the ONLY person who
can confirm or reject the payment — this is enforced server-side, row-locked.
The old `FUNDED → deliver → release/refund` machine remains in the codebase
for historical rows and audit only; the current flow never reaches it.

## Commands

- `/start` — main menu
- `/form` or typing `form` — create a deal. **Group-first**: run it inside the
  authorized escrow group and the finished deal card is posted to that same
  group (the group where the form ran is the deal's home). Run it in DM and
  the card goes to the configured escrow group (setting / env / first approved
  group). The form is refused entirely in a group the owner has not approved
  with `/allowgroup`
- `/allowgroup` — authorize the current group for escrow (bot owner only)
- `/disallowgroup` — disable escrow in the current group, keeping all data
  (bot owner only)
- `/addadmin @user` — assign a group-specific escrow admin for the current
  group (bot owner only)
- `/removeadmin @user` — remove a group-specific escrow admin (bot owner only)
- `/groupadmins` — list the current group's escrow admins (bot owner only)
- `/admin` — admin dashboard (global admins only)
- `/settings` — view/edit escrow payment details. In DM: the global fallback
  (global admins only). Inside a group: that group's own details (bot owner /
  global admin / that group's escrow admin)
- `/disputes`, `/review`, `/ban`, `/suspend`, `/user` — admin tooling
- `/release` / `/refund` — **out of scope**: the bot ends at
  PAYMENT_RECEIVED; these commands answer with a message pointing to the
  manual escrower and never touch a deal

## Telegram group setup (permissions)

For the group flow to work, the escrow group should be configured via
`ESCROW_GROUP_ID` (or `/settings` → `escrow_group_id`, whose DB value takes
precedence), the bot added to it, and the group **authorized** by the bot
owner with `/allowgroup` inside the group. Escrow admins are then assigned
per group with `/addadmin @user`. Recommended permissions:

- **Add the bot as a group administrator** (or disable **Privacy Mode**) so the
  bot reliably receives messages in the group. This matters for:
  - `/form` and the word `form` in the group (the bot must see the message to
    start the deal form there);
  - old `/release` / `/refund` commands sent as replies (they now answer with
    the out-of-scope message and never touch a deal);
  - making `@username` text into links (admin rights are required for Telegram
    to render `@`-mentions; the bot's own deal card instead uses
    `tg://user?id=…` links, which work without admin rights).
- Inline-button callbacks on the bot's own deal card work regardless of admin
  status, and sessions are keyed **per user** (not per chat), so members in the
  same group never share form state or pending flows. Deal-scoped callbacks are
  also re-checked server-side against the deal's group: a callback crafted in
  or forwarded from any OTHER group is rejected.
- The bot posts the deal card itself, so it needs permission to **send
  messages** (and ideally to **edit messages**, which it has for its own
  messages).
- Only the bot owner, global admins (`ADMIN_TELEGRAM_IDS`) or an ACTIVE
  group escrow admin (`/addadmin`) for that group can accept/verify deals —
  the bot re-checks authorization server-side on every callback; a crafted
  callback from a non-admin is rejected. Deal cards are only posted to groups
  approved with `/allowgroup`; a normal Telegram group admin gets no escrow
  powers.

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
