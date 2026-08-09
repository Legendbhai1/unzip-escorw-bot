import { prisma } from "../lib/db.js";
import { treasuryService } from "./treasuryService.js";
import { tronService } from "./tronService.js";
import { bscService } from "./bscService.js";
import { getMonitoredAddresses, getUserIdForAddress } from "./depositAddressService.js";
import { notificationService } from "./notificationService.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";
import { redis } from "../lib/redis.js";
import type { DetectedTransaction } from "../types/index.js";

const lastPollTimestamp = new Map<string, number>();

// Only USDT is supported as a deposit asset. Deposits of any other token are
// ignored — token verification must never be weakened.
const SUPPORTED_ASSET = "USDT";

// System user used to record deposits that cannot be attributed to a user
// (e.g. static platform deposit address). Never credited automatically.
const UNATTRIBUTED_USER_ID = "00000000-0000-0000-0000-000000000001";

// Throttle identical monitor errors so a missing table / API outage does not
// spam the logs on every poll. New/different errors still log immediately.
let lastErrorKey = "";
let lastErrorAt = 0;

/**
 * Ensure the unattributed system user exists (idempotent).
 * Needed because blockchain_deposits.user_id has a foreign key to users(id).
 */
async function ensureUnattributedUser() {
  try {
    await prisma.user.upsert({
      where: { id: UNATTRIBUTED_USER_ID },
      create: {
        id: UNATTRIBUTED_USER_ID,
        telegramId: BigInt(0), // not a real Telegram account
        username: "unattributed",
        firstName: "Unattributed Deposit",
        status: "ACTIVE",
      },
      update: {},
    });
  } catch (e) {
    logger.warn({ err: e }, "Could not ensure unattributed system user");
  }
}

/**
 * Log a monitor error, throttling identical repeated messages to avoid spam
 * (e.g. P2021 while tables are missing, or an RPC outage).
 */
function logMonitorError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const now = Date.now();
  const isRepeat = msg === lastErrorKey && now - lastErrorAt < 300_000;
  if (isRepeat) {
    logger.debug({ err }, "Blockchain monitor poll error (repeated, throttled)");
    return;
  }
  lastErrorKey = msg;
  lastErrorAt = now;
  logger.error({ err }, "Blockchain monitor poll error");
}

/**
 * Blockchain Monitor detects incoming deposits and credits USER WALLETS.
 * Deposits are NOT deal-specific. They go to user available balance.
 *
 * Idempotency: network + txHash + logIndex (composite unique in DB).
 * For TRC20 where logIndex isn't available from API, use 0.
 */
export const blockchainMonitor = {
  /**
   * Process a detected deposit.
   * 1. Check if (network, txHash, logIndex) already processed
   * 2. Determine which user owns the deposit address
   * 3. Credit the user's available balance via TreasuryService
   * 4. Notify user
   */
  async processDeposit(detected: DetectedTransaction) {
    const { txHash, toAddress, amount, confirmations, network, fromAddress } = detected;
    const txHashLower = txHash.toLowerCase();
    const logIndex = (detected as any).logIndex ?? 0;

    // Token verification: only USDT is supported as a deposit asset. Detectors
    // filter at the source, but this guard must never be weakened — a foreign
    // token (or spoofed symbol) reaching this point is ignored outright.
    if (detected.token !== SUPPORTED_ASSET) {
      logger.warn(
        { txHash: txHashLower, token: detected.token, network, toAddress },
        "Deposit skipped: unsupported token"
      );
      return null;
    }

    // 1. Idempotency: check blockchain_deposits with composite key
    try {
      // Use txHash as unique key for idempotency check (composite index is at DB level)
      const existing = await prisma.blockchainDeposit.findFirst({
        where: { txHash: txHashLower, network, logIndex },
      });
      if (existing) {
        if (existing.status === "CONFIRMED") return null;

        // Unattributed deposits can never be credited — skip silently
        if (existing.userId === UNATTRIBUTED_USER_ID) return null;

        // Update confirmations for pending deposits
        if (confirmations >= existing.requiredConfs && existing.status === "PENDING") {
          return this.confirmAndCredit(existing.id, txHashLower, amount, network, fromAddress);
        }
        return null;
      }
    } catch (e) {
      // If the unique constraint lookup fails, it might be a migration issue.
      // Fall through to try creating.
      logger.warn({ err: e, txHash: txHashLower, network }, "Blockchain deposit lookup error");
    }

    // 2. Determine user from deposit address
    // For MVP with static addresses: we can't determine user from address alone.
    // The deposit is recorded as PENDING for admin attribution.
    const userId = await this.resolveUserId(toAddress, network, txHashLower, fromAddress);

    if (!userId) {
      // Record as pending — admin must attribute manually
      await ensureUnattributedUser();
      try {
        await prisma.blockchainDeposit.upsert({
          where: {
            blockchain_deposit_unique: {
              network,
              txHash: txHashLower,
              logIndex,
            },
          },
          create: {
            userId: UNATTRIBUTED_USER_ID,
            txHash: txHashLower,
            logIndex,
            fromAddress,
            toAddress,
            asset: "USDT",
            network,
            amount,
            confirmations,
            requiredConfs: this.getMinConfirmations(network),
            status: "PENDING",
          },
          update: { confirmations, amount },
        });
      } catch (e) {
        logger.warn(
          { err: e, txHash: txHashLower, amount, network, toAddress },
          "Could not record unattributed deposit"
        );
        return null;
      }
      logger.warn(
        { txHash: txHashLower, amount, network, toAddress },
        "Deposit recorded as pending (user attribution needed)"
      );
      return null;
    }

    // 3. Check if we have enough confirmations
    const requiredConfs = this.getMinConfirmations(network);
    if (confirmations < requiredConfs) {
      // Upsert (not create) so a re-poll racing the first write can never
      // create a duplicate PENDING record for the same on-chain event.
      await prisma.blockchainDeposit.upsert({
        where: {
          blockchain_deposit_unique: {
            network,
            txHash: txHashLower,
            logIndex,
          },
        },
        create: {
          userId,
          txHash: txHashLower,
          logIndex,
          fromAddress,
          toAddress,
          asset: "USDT",
          network,
          amount,
          confirmations,
          requiredConfs,
          status: "PENDING",
        },
        update: { confirmations, amount },
      });
      logger.info(
        { txHash: txHashLower, confirmations, requiredConfs, userId },
        "Deposit pending confirmations"
      );
      return null;
    }

    // 4. Credit user via TreasuryService
    try {
      await treasuryService.creditDeposit({
        userId,
        amount,
        asset: "USDT",
        txHash: txHashLower,
        network,
        logIndex,
        fromAddress,
        toAddress,
      });

      await notificationService.notifyDepositCredited(userId, "USDT", amount, txHashLower);
      logger.info(
        { txHash: txHashLower, userId, amount, network },
        "Deposit credited to user wallet"
      );
      return { userId, amount, txHash: txHashLower };
    } catch (e: any) {
      if (e.message?.includes("IDEMPOTENT_DUPLICATE")) {
        logger.warn({ txHash: txHashLower }, "Deposit already credited (idempotent)");
        return null;
      }
      logger.error({ txHash: txHashLower, userId, err: e }, "Failed to credit deposit");
      return null;
    }
  },

  /**
   * Confirm a pending deposit and credit the user's wallet.
   */
  async confirmAndCredit(
    depositId: string,
    txHash: string,
    amount: string,
    network: string,
    fromAddress: string,
  ) {
    const deposit = await prisma.blockchainDeposit.findUnique({ where: { id: depositId } });
    if (!deposit) return null;
    if (deposit.userId === UNATTRIBUTED_USER_ID) {
      logger.debug({ depositId }, "Skipping unattributed deposit");
      return null;
    }

    try {
      await treasuryService.creditDeposit({
        userId: deposit.userId,
        amount,
        asset: deposit.asset,
        txHash,
        network,
        logIndex: deposit.logIndex,
        fromAddress,
        toAddress: deposit.toAddress,
      });

      await prisma.blockchainDeposit.update({
        where: { id: depositId },
        data: { status: "CONFIRMED", creditedAt: new Date() },
      });

      await notificationService.notifyDepositCredited(
        deposit.userId, deposit.asset, amount, txHash
      );

      return deposit;
    } catch (e: any) {
      if (e.message?.includes("IDEMPOTENT_DUPLICATE")) {
        await prisma.blockchainDeposit.update({
          where: { id: depositId },
          data: { status: "CONFIRMED", creditedAt: new Date() },
        });
        return deposit;
      }
      logger.error({ depositId, err: e }, "Failed to credit pending deposit");
      return null;
    }
  },

  /**
   * Resolve userId from a deposit address via the persisted
   * (network, asset, address) -> userId mapping. Returns null when the
   * address is not one of our deposit addresses (recorded as unattributed).
   */
  async resolveUserId(
    toAddress: string,
    network: string,
    _txHash: string,
    _fromAddress: string,
  ): Promise<string | null> {
    return getUserIdForAddress(toAddress, network, "USDT");
  },

  getMinConfirmations(network: string): number {
    const map: Record<string, number> = {
      TRC20: 20, BEP20: 15, BTC: 3, LTC: 6, TON: 10, ERC20: 12,
    };
    return map[network] ?? 12;
  },

  /**
   * TRON TRC20 polling.
   */
  async pollTron() {
    try {
      const addresses = await getMonitoredAddresses("TRC20", "USDT");
      if (addresses.length === 0) {
        logger.debug("No TRC20 addresses to monitor");
        return;
      }

      const minTs = lastPollTimestamp.get("TRC20") ?? (Date.now() - 300_000);
      const latestBlock = await tronService.getLatestBlock();

      for (const addr of addresses) {
        const transfers = await tronService.getTrc20Transfers(addr, undefined, minTs);

        for (const t of transfers) {
          try {
            // TRC20 API does not expose a log index — keep logIndex undefined so
            // it defaults to 0. Using the batch position would make the dedup key
            // (network, txHash, logIndex) unstable across polls and could cause
            // duplicate credits for the same transaction.
            //
            // The transfer object has no block number, so fetch the tx info once
            // to compute real confirmations; without it TRC20 deposits would stay
            // PENDING forever (0 confirmations).
            let txBlockNumber: number | undefined;
            try {
              const txInfo = await tronService.getTransactionInfo(t.transaction_id);
              txBlockNumber = txInfo.blockNumber;
            } catch {
              /* tx info unavailable -> 0 confirmations this poll */
            }
            const detected = tronService.parseTrc20Transfer(t, latestBlock, txBlockNumber);
            await this.processDeposit(detected);
          } catch (e) {
            logMonitorError(e);
          }
        }
      }

      lastPollTimestamp.set("TRC20", Date.now());
    } catch (e) {
      // Route through the throttled logger: repeated identical errors (RPC
      // outage, missing tables) must not spam the logs every poll cycle.
      logMonitorError(e);
    }
  },

  /**
   * BSC BEP20 polling — uses ethers.js event logs.
   */
  async pollBsc() {
    try {
      const addresses = await getMonitoredAddresses("BEP20", "USDT");
      if (addresses.length === 0) {
        logger.debug("No BEP20 addresses to monitor");
        return;
      }

      const currentBlock = await bscService.getLatestBlock();
      const lastKey = "BEP20:lastBlock";
      const rawLast = await redis.get(lastKey);
      const fromBlock = rawLast ? Number(rawLast) + 1 : currentBlock - 1000;
      const safeFrom = Math.max(fromBlock, currentBlock - 5000);

      for (const addr of addresses) {
        const transfers = await bscService.getBep20Transfers(addr, safeFrom, currentBlock);

        for (const t of transfers) {
          await this.processDeposit(t);
        }
      }

      await redis.set(lastKey, currentBlock.toString());
      lastPollTimestamp.set("BEP20", Date.now());
    } catch (e) {
      // Route through the throttled logger: Redis may be unavailable (the app
      // intentionally falls back to in-memory sessions), and BSC polling must
      // not log an error every cycle in that case.
      logMonitorError(e);
    }
  },

  /**
   * Check pending deposits that may now have enough confirmations.
   */
  async confirmPendingDeposits() {
    const pending = await prisma.blockchainDeposit.findMany({
      where: { status: "PENDING" },
      take: 100,
    });

    for (const dep of pending) {
      if (dep.userId === UNATTRIBUTED_USER_ID) continue;

      // Check current confirmations
      let currentConfs = dep.confirmations;
      if (dep.network === "BEP20") {
        currentConfs = await bscService.getTxConfirmations(dep.txHash);
      }
      // TRC20: would need another API call; skip for now

      if (currentConfs >= dep.requiredConfs) {
        await this.confirmAndCredit(
          dep.id, dep.txHash, dep.amount.toString(), dep.network, dep.fromAddress
        );
      }
    }
  },

  /**
   * Start the polling loop.
   */
  startPolling() {
    const interval = config.monitorPollIntervalMs;
    logger.info({ intervalMs: interval }, "Blockchain monitor started");

    const poll = async () => {
      try {
        await this.pollTron();
        await this.pollBsc();
        await this.confirmPendingDeposits();
      } catch (e) {
        logMonitorError(e);
      }
    };

    poll();
    setInterval(poll, interval);
  },
};


