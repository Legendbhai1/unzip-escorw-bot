import path from "node:path";
import dotenv from "dotenv";

// Load .env from project root (2 levels up from src/config/)
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  logLevel: process.env.LOG_LEVEL ?? "info",

  // Telegram
  botToken: required("BOT_TOKEN"),
  adminTelegramIds: new Set(
    (process.env.ADMIN_TELEGRAM_IDS ?? "").split(",").map(Number).filter(Boolean)
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
  withdrawalMinConfirmations: Number(process.env.WITHDRAWAL_MIN_CONFIRMATIONS ?? 3),
  withdrawalSignerKey: process.env.WITHDRAWAL_SIGNER_PRIVATE_KEY ?? "",

  // Reconciliation
  reconciliationIntervalMs: Number(process.env.RECONCILIATION_INTERVAL_MS ?? 900_000),

  // Blockchain monitor
  monitorPollIntervalMs: Number(process.env.MONITOR_POLL_INTERVAL_MS ?? 15_000),

  // Deal
  escrowFeeRate: 0, // 0 = free for now; can set e.g. 0.005 for 0.5%
} as const;

export function isAdmin(telegramId: number): boolean {
  return config.adminTelegramIds.has(telegramId);
}
