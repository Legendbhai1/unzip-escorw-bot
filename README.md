# 🛡️ ESCORW — BY NFT MRKT

A structured Telegram escrow **deal management** bot. It coordinates buyers, sellers,
and verified escrowers through a recorded, auditable workflow — it does not hold,
move, or process funds itself. All confirmations require the correct party and an
authorized escrower; nothing completes automatically.

> ⚠️ The bot never claims a transaction is secure or guaranteed. Users must always
> verify deal details and the identity of their escrower independently.

## Architecture

```
bot/
  handlers/     Telegram command & callback handlers (thin — no DB/business logic)
  keyboards/     Inline keyboard builders
  services/      Business logic: deals, escrowers, audit, notifications, settings
  database/      Pool, migration runner, SQL migrations
  models/        (reserved — current version reads/writes via services + raw SQL)
  middleware/    Auth (role checks), idempotency/rate-limit
  utils/         ID generation, HTML escaping, formatting
  jobs/          autoCancel.js — inactivity warnings + auto-expiry (node-cron)
  config/        env.js — validates and centralizes environment variables
  index.js       Entry point: wires middleware, handlers, scheduler, health server
```

Design choices:
- **Postgres transactions** guard every state transition (activate, release,
  complete, cancel, dispute) so two people can't race the same deal into an
  inconsistent state.
- **Numeric Telegram IDs**, never usernames, are the source of authorization —
  usernames are display-only.
- **Idempotent callbacks**: every Telegram `callback_query.id` is deduped in-memory
  so double-taps or retried updates can't double-process an action.
- **Nothing auto-completes.** Release requires the counter-party's confirmation
  *and* the assigned escrower's explicit completion action.

## Setup

```bash
npm install
cp .env.example .env   # fill in BOT_TOKEN, DATABASE_URL, ADMIN_IDS, etc.
npm run migrate        # creates all tables
npm start
```

## Deploying on Render

1. Push this repo to GitHub.
2. In Render: **New → Web Service**, connect the repo.
3. Add a **PostgreSQL** instance (Render → New → PostgreSQL, free tier is fine)
   and copy its **Internal Database URL** into `DATABASE_URL`.
4. Environment variables (Render → your service → Environment):
   - `BOT_TOKEN` — from @BotFather
   - `DATABASE_URL` — from the Render Postgres instance
   - `ADMIN_IDS` — comma-separated numeric Telegram IDs
   - `SUPPORT_USERNAME`, `ESCROW_GROUP_URL`, `INFO_CHANNEL_URL` — optional
   - `INACTIVITY_TIMEOUT_HOURS` (default 24), `INACTIVITY_WARNING_HOURS` (default `12,23`)
   - `DEFAULT_FEE_PERCENT` (default 0)
5. **Build command:** `npm install`
6. **Start command:** `npm run migrate && npm start`
   (safe to run every deploy — migrations are idempotent and skip already-applied files)
7. Render's free web-service tier requires the app to bind to `$PORT`; `bot/index.js`
   runs a tiny HTTP health-check server for this (`GET /` → `200 OK`). The bot itself
   runs in **long-polling** mode, so no webhook/public URL is required.
8. First deploy: seed at least one escrower with `/addescrower <your_telegram_id>`
   from an admin account (your ID must also be in `ADMIN_IDS` to run admin commands).

## User commands

| Command | Description |
|---|---|
| `/start` | Welcome + main menu |
| `/form` | Create a new deal (guided form) |
| `/mydeals` | List your deals |
| `/deal <id>` | View a specific deal |
| `/rules` | Platform rules |
| `/escrowers` | List official escrowers |
| `/escrower <username or ID>` | View one escrower's profile |
| `/help` | Show welcome/menu again |
| `/support` | Support contact |

## Admin commands

| Command | Description |
|---|---|
| `/addescrower <id> [username] [limit]` | Add/reactivate an escrower |
| `/removeescrower <id>` | Deactivate an escrower |
| `/escrowerinfo <id>` | Full escrower profile |
| `/setlimit <id> <amount>` | Change an escrower's max deal limit |
| `/suspend <id>` / `/unsuspend <id>` | Suspend / reinstate an escrower |
| `/activedeals` | List all non-final deals |
| `/finddeal <id>` | Raw deal record |
| `/reassign <deal_id> <new_escrower_id>` | Reassign an active deal (logged) |
| `/override <deal_id> COMPLETE\|CANCEL CONFIRM` | Force-complete or force-cancel (requires literal `CONFIRM`, always logged) |
| `/stats` | Deal counts by status, escrower counts |
| `/auditlog` | Last 20 admin actions |
| `/setfee <percent>` | Change the escrow fee shown on new deals |
| `/settimeout <hours>` | Change the inactivity auto-cancel window |
| `/broadcast <message>` | Message every known user |
| `/resolvedispute <dispute_id> RELEASE\|REFUND\|CANCEL` | Resolve a dispute |

## Manual test checklist

Run these against a staging bot + database before going live:

- [ ] `/form` end-to-end for a **NORMAL** deal → seller delivers → release → confirm → escrower completes
- [ ] `/form` end-to-end for a **P2P** deal → buyer pays → release → confirm → escrower completes
- [ ] Second escrower attempts `deal:complete` on a deal they didn't activate → rejected
- [ ] Activation attempt with amount above the escrower's `max_deal_limit` → `LIMIT EXCEEDED`
- [ ] Rapid double-tap on a button (e.g. `Activate Deal`) → only processed once
- [ ] Open a dispute mid-deal → normal buttons no longer complete the deal → `/resolvedispute`
- [ ] Cancel a `PENDING` deal, then a `DISPUTED` deal (should require admin)
- [ ] Let a deal sit past the warning thresholds → confirm 12h/second-warning messages fire once each, then `EXPIRED` after the full window (fast way to test: `/settimeout 1` on a scratch deal and adjust cron interval, or manually backdate `last_activity_at` in the DB)
- [ ] `/override <id> COMPLETE` without `CONFIRM` → blocked; with `CONFIRM` → applied and logged in `/auditlog`
- [ ] Non-admin runs any `/admin`-only command → refused

## Notes on scope

This build implements the full **deal-record and coordination workflow** — creation,
activation, delivery/payment marking, release requests, disputes, completion,
auto-expiry, escrower management, and an admin panel — using database records and
manual human verification, exactly as specified. It intentionally does **not**
include actual crypto custody, wallet generation, or payment processing; per the
spec, that would be a separate, independently audited module built on top of this
foundation, not bolted into deal completion logic.
