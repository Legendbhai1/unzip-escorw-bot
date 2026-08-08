import { prisma } from "../lib/db.js";
import { treasuryService } from "./treasuryService.js";
import { tronService } from "./tronService.js";
import { bscService } from "./bscService.js";
import { getMonitoredAddresses } from "./depositAddressService.js";
import { notificationService } from "./notificationService.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";
import { redis } from "../lib/redis.js";
import type { DetectedTransaction } from "../types/index.js";

const lastPollTimestamp = new Map<string, number>();

/**
 * Blockchain Monitor detects incoming deposits and credits USER WALLETS.
 * Deposits are NOT deal-specific. They go to user available balance.
 * The deal then locks from available when both parties agree.
 */
export const blockchainMonitor = {
  /**
   * Process a detected deposit.
   * 1. Check if txHash already processed (idempotency)
   * 2. Determine which user owns the deposit address
   * 3. Credit the user's available balance via TreasuryService
   * 4. Notify user
   * 5. Check if any AWAITING_DEPOSIT deals can now be funded
   */
  async processDeposit(detected: DetectedTransaction) {
    const { txHash, toAddress, amount, confirmations, network, fromAddress } = detected;
    const txHashLower = txHash.toLowerCase();

    // 1. Idempotency: check blockchain_deposits table
    const existing = await prisma.blockchainDeposit.findUnique({
      where: { txHash: txHashLower },
    });
    if (existing) {
      if (existing.status === "CONFIRMED") return null; // already processed
      
      // Update confirmations for pending deposits
      if (confirmations >= existing.requiredConfs && existing.status === "PENDING") {
        return this.confirmAndCredit(existing.id, txHashLower, amount, network, fromAddress);
      }
      return null;
    }

    // 2. Determine user (for static address, find by txHash sender pattern or skip)
    // For static addresses, we record the deposit but need to identify the user.
    // In production with per-user addresses, this is straightforward.
    // For MVP with static address: create a pending record for manual attribution.
    const staticAddr = process.env[`DEPOSIT_ADDRESS_${network}`];
    if (staticAddr && staticAddr.toLowerCase() === toAddress.toLowerCase()) {
      // Static address — we'll need to identify the user from context
      // or require the user to have a unique deposit address.
      // For now, record as pending and let reconciliation handle it.
      await prisma.blockchainDeposit.create({
        data: {
          userId: "00000000-0000-0000-0000-000000000001", // unattributed placeholder
          txHash: txHashLower,
          fromAddress,
          toAddress,
          asset: "USDT",
          network,
          amount,
          confirmations,
          requiredConfs: this.getMinConfirmations(network),
          status: "PENDING",
        },
      });
      logger.warn(
        { txHash: txHashLower, amount, network },
        "Deposit to static address recorded as pending (user attribution needed)"
      );
      return null;
    }

    // 3. For per-user addresses: find the user
    // This requires a reverse lookup. In production, store address->userId mapping.
    // For MVP, skip user attribution from address alone.
    logger.warn(
      { txHash: txHashLower, toAddress, network },
      "Deposit detected but user attribution not implemented for non-static addresses"
    );
    return null;
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
    // Update deposit record
    await prisma.blockchainDeposit.update({
      where: { id: depositId },
      data: { status: "CONFIRMED", creditedAt: new Date() },
    });

    // Credit user via TreasuryService (this is the single financial gate)
    const deposit = await prisma.blockchainDeposit.findUnique({ where: { id: depositId } });
    if (!deposit || deposit.userId === "00000000-0000-0000-0000-000000000001") {
      logger.warn({ depositId }, "Cannot credit unattributed deposit");
      return null;
    }

    try {
      await treasuryService.creditDeposit({
        userId: deposit.userId,
        amount,
        asset: deposit.asset,
        txHash,
        network,
      });

      // Notify user
      await notificationService.notifyDepositCredited(
        deposit.userId, deposit.asset, amount, txHash
      );

      // Check if any AWAITING_DEPOSIT deals for this user can now be funded
      await this.checkAndFundDeals(deposit.userId, deposit.asset);
    } catch (e) {
      logger.error({ depositId, err: e }, "Failed to credit deposit");
    }

    return deposit;
  },

  /**
   * After crediting a user's deposit, check if any AWAITING_DEPOSIT deals
   * can now be auto-funded (buyer has sufficient available balance).
   */
  async checkAndFundDeals(userId: string, asset: string) {
    const { dealService } = await import("./dealService.js");
    const deals = await prisma.deal.findMany({
      where: {
        buyerId: userId,
        asset,
        status: "AWAITING_DEPOSIT",
      },
    });

    for (const deal of deals) {
      const bal = await treasuryService.getBalance(userId, asset);
      const needed = parseFloat(deal.amount.toString());
      const available = parseFloat(bal.available);

      if (available >= needed) {
        try {
          await dealService.fund(deal.id);
          logger.info({ dealId: deal.id }, "Deal auto-funded after deposit credit");
        } catch (e) {
          logger.error({ dealId: deal.id, err: e }, "Auto-fund failed");
        }
      }
    }
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
      const addresses = await getMonitoredAddresses("TRC20");
      if (addresses.length === 0) {
        logger.debug("No TRC20 addresses to monitor");
        return;
      }

      const minTs = lastPollTimestamp.get("TRC20") ?? (Date.now() - 300_000);
      const latestBlock = await tronService.getLatestBlock();

      for (const addr of addresses) {
        const transfers = await tronService.getTrc20Transfers(addr, undefined, minTs);

        for (const t of transfers) {
          const existing = await prisma.blockchainDeposit.findUnique({
            where: { txHash: t.transaction_id.toLowerCase() },
          });
          if (existing) continue;

          const detected = tronService.parseTrc20Transfer(t, latestBlock);
          await this.processDeposit(detected);
        }
      }

      lastPollTimestamp.set("TRC20", Date.now());
    } catch (e) {
      logger.error({ err: e }, "TRON poll error");
    }
  },

  /**
   * BSC BEP20 polling — uses ethers.js event logs.
   */
  async pollBsc() {
    try {
      const addresses = await getMonitoredAddresses("BEP20");
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
          const existing = await prisma.blockchainDeposit.findUnique({
            where: { txHash: t.txHash.toLowerCase() },
          });
          if (existing) continue;

          await this.processDeposit(t);
        }
      }

      await redis.set(lastKey, currentBlock.toString());
      lastPollTimestamp.set("BEP20", Date.now());
    } catch (e) {
      logger.error({ err: e }, "BSC poll error");
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
      } catch (e) {
        logger.error({ err: e }, "Blockchain monitor poll error");
      }
    };

    poll();
    setInterval(poll, interval);
  },
};
