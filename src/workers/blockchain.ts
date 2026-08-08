import { blockchainMonitor } from "../services/blockchainMonitor.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";

/**
 * Blockchain Monitor Worker
 * Runs the polling loop independently from the bot process.
 * In production, deploy this as a separate container with leader election.
 */
async function main() {
  logger.info("Blockchain monitor worker starting...");
  blockchainMonitor.startPolling();

  // Keep alive
  setInterval(() => {
    logger.debug("Monitor heartbeat");
  }, 60_000);
}

main().catch((e) => {
  logger.error({ err: e }, "Monitor worker fatal error");
  process.exit(1);
});
