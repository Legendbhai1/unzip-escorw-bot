import { config } from "./config/index.js";
import { logger } from "./lib/logger.js";
import { redis } from "./lib/redis.js";
import { bot } from "./bot/index.js";
import { blockchainMonitor } from "./services/blockchainMonitor.js";

async function main() {
  await redis.connect().catch(() => {
    logger.warn("Redis not available, sessions will be in-memory");
  });

  if (config.nodeEnv !== "test") {
    blockchainMonitor.startPolling();
    logger.info("Blockchain monitor started");
  }

  logger.info("Starting escrow bot...");
  await bot.start({
    onStart: (info) => {
      logger.info(`Bot started as @${info.username}`);
    },
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal error");
  process.exit(1);
});
