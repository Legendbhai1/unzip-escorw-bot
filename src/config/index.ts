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
  // Deals in AWAITING_FUNDING expire after this many ms (default 24h)
  dealFundingExpiryMs: intEnv("DEAL_FUNDING_EXPIRY_MS", 86_400_000),

  // Deals in FUNDED expire after this many ms if no progress (default 7d)
  dealFundedExpiryMs: intEnv("DEAL_FUNDED_EXPIRY_MS", 604_800_000),
} as const;

export function isAdmin(telegramId: number): boolean {
  return config.adminTelegramIds.has(telegramId);
}
