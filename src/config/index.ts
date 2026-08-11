import path from "node:path";
import dotenv from "dotenv";

// Load .env from project root (2 levels up from src/config/)
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function intEnv(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  if (isNaN(n) || n < 0) throw new Error(`Invalid integer env var: ${key}=${val}`);
  return n;
}

function boolEnv(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (!val) return fallback;
  return val === "true" || val === "1";
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  logLevel: process.env.LOG_LEVEL ?? "info",

  // Telegram
  botToken: required("BOT_TOKEN"),
  // Admin ids are read from ADMIN_TELEGRAM_IDS, with ADMIN_IDS kept as a
  // fallback for deployments configured before the rename.
  adminTelegramIds: new Set(
    (process.env.ADMIN_TELEGRAM_IDS ?? process.env.ADMIN_IDS ?? "")
      .split(",")
      .map(Number)
      .filter(Boolean)
  ),
  // The bot owner is the only user who can /allowgroup, /disallowgroup,
  // /addadmin, /removeadmin and /groupadmins. Explicitly configured via
  // BOT_OWNER_TELEGRAM_ID; falls back to the first ADMIN_TELEGRAM_IDS entry
  // so existing deployments keep working without a new env var.
  botOwnerTelegramId:
    Number(process.env.BOT_OWNER_TELEGRAM_ID ?? "") ||
    Number(
      (process.env.ADMIN_TELEGRAM_IDS ?? process.env.ADMIN_IDS ?? "")
        .split(",")[0] ?? ""
    ) ||
    0,

  // Database
  databaseUrl: required("DATABASE_URL"),

  // Redis
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  // Blockchain
  tron: {
    apiKey: process.env.TRON_API_KEY ?? "",
    usdtContract: process.env.TRON_CONTRACT_USDT ?? "",
  },
  bsc: {
    rpcUrl: process.env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org",
    usdtContract: process.env.BSC_CONTRACT_USDT ?? "",
  },

  // Withdrawal
  withdrawalMinConfirmations: intEnv("WITHDRAWAL_MIN_CONFIRMATIONS", 3),
  withdrawalSignerKey: process.env.WITHDRAWAL_SIGNER_PRIVATE_KEY ?? "",

  // Reconciliation
  reconciliationIntervalMs: intEnv("RECONCILIATION_INTERVAL_MS", 900_000),

  // Blockchain monitor
  monitorPollIntervalMs: intEnv("MONITOR_POLL_INTERVAL_MS", 15_000),

  // ── Fee Configuration (basis points, NO floating point) ──────────
  // 100 bps = 1%, 50 bps = 0.5%
  buyerFeeBps: intEnv("BUYER_FEE_BPS", 100),
  sellerFeeBps: intEnv("SELLER_FEE_BPS", 100),

  // ── Refund Fee Policy ───────────────────────────────────────────
  // If true, buyer fee is refunded to buyer on refund.
  // If false, buyer fee is kept by the platform.
  buyerFeeRefundOnRefund: boolEnv("BUYER_FEE_REFUND_ON_REFUND", true),

  // If true, seller fee is still charged when deal is resolved as refund.
  // If false, no seller fee is charged on refund.
  sellerFeeChargedOnRefund: boolEnv("SELLER_FEE_CHARGED_ON_REFUND", false),

  // ── Deal Expiration ─────────────────────────────────────────────
  // Deals in AWAITING_PAYMENT expire after this many ms (default 24h)
  dealFundingExpiryMs: intEnv("DEAL_FUNDING_EXPIRY_MS", 86_400_000),

  // Deals in FUNDED expire after this many ms if no progress (default 7d)
  dealFundedExpiryMs: intEnv("DEAL_FUNDED_EXPIRY_MS", 604_800_000),

  // ── Escrower manual payment instructions ────────────────────────
  // The escrower personally verifies incoming payment and pays the seller.
  // These are the escrower's own payment details — NEVER auto-generated.
  // If unset, users see "Payment instructions are currently unavailable."
  escrow: {
    upiId: process.env.ESCROW_UPI_ID ?? "",
    upiName: process.env.ESCROW_UPI_NAME ?? "",
    // Only USDT on BEP20 is supported. No other network/asset is accepted.
    cryptoAddresses: {
      "USDT_BEP20": process.env.ESCROW_CRYPTO_ADDRESS_USDT_BEP20 ?? "",
    } as Record<string, string>,
  },

  // Escrow group chat id the deal form card is posted to (optional).
  // When empty, the card is not posted anywhere (form still completes).
  escrowGroupId: process.env.ESCROW_GROUP_ID ?? "",
} as const;

export function isAdmin(telegramId: number): boolean {
  return config.adminTelegramIds.has(telegramId);
}

export function isBotOwner(telegramId: number): boolean {
  return config.botOwnerTelegramId > 0 && telegramId === config.botOwnerTelegramId;
}
