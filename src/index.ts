import http from "node:http";
import { config } from "./config/index.js";
import { logger } from "./lib/logger.js";
import { redis } from "./lib/redis.js";
import { bot } from "./bot/index.js";

/**
 * Render (and similar platforms) determine web-service readiness by whether
 * the app listens on the injected PORT. This bot uses long polling and never
 * opened an HTTP port, so deploys would sit in "update_in_progress" forever.
 * Bind a minimal health endpoint (0.0.0.0) so the deploy can go live. The
 * endpoint is intentionally dumb — all real work happens via Telegram polling.
 */
function startHealthServer(): http.Server | null {
  const port = Number(process.env.PORT ?? 8080);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  server.on("error", (err) => {
    logger.warn({ err, port }, "Health server could not bind port (continuing without it)");
  });
  server.listen(port, "0.0.0.0", () => {
    logger.info({ port }, "Health server listening");
  });
  return server;
}

/**
 * Start the bot, retrying on Telegram 409 "terminated by other getUpdates
 * request".
 *
 * Telegram only allows ONE long-polling consumer per bot token. During a
 * Render deploy, a previously-live instance may still be polling while the new
 * instance boots, which produces this 409. If we crash on it, the new deploy
 * fails and the stale instance survives forever (deploy deadlock).
 *
 * Instead we retry with backoff: the process stays up, Render marks the deploy
 * live and deactivates the stale instance, and the next getUpdates succeeds.
 * grammY's bot.start() is re-entrant here — after a 409 the polling loop has
 * already unwound (pollingRunning=false) and a fresh start() re-runs cleanly.
 */
async function startBotWithRetry(attempt = 0): Promise<void> {
  try {
    await bot.start({
      onStart: (info) => {
        logger.info(`Bot started as @${info.username}`);
      },
    });
  } catch (err: any) {
    const isConflict =
      err?.error_code === 409 ||
      (err?.message ?? "").includes("terminated by other getUpdates");
    if (isConflict) {
      // 3s → 6s → 12s → 24s → capped at 30s
      const delayMs = Math.min(30_000, 3_000 * 2 ** Math.min(attempt, 3));
      logger.warn(
        { attempt, delayMs },
        "getUpdates conflict (another bot instance is polling) — retrying"
      );
      await new Promise((r) => setTimeout(r, delayMs));
      return startBotWithRetry(attempt + 1);
    }
    throw err;
  }
}

async function main() {
  await redis.connect().catch(() => {
    logger.warn("Redis not available, sessions will be in-memory");
  });

  // The automated blockchain deposit monitor is DISABLED: the bot no longer
  // receives or credits funds automatically. All payments are manually
  // verified by the escrower outside the bot. (The monitor code remains in
  // src/services/blockchainMonitor.ts for historical/audit reference only.)

  logger.info("Starting escrow bot...");
  startHealthServer();
  await startBotWithRetry();
}

main().catch((err) => {
  logger.error({ err }, "Fatal error");
  process.exit(1);
});
