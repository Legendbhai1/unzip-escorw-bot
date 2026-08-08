import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/db.js";
import { treasuryService } from "../services/treasuryService.js";
import { walletService } from "../services/walletService.js";
import { notificationService } from "../services/notificationService.js";
import Queue from "bull";
import { redis as redisClient } from "../lib/redis.js";
import { randomUUID } from "node:crypto";

// ── Withdrawal Queue ──────────────────────────────────────────────
export const withdrawalQueue = new Queue("withdrawal", config.redisUrl, {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export interface WithdrawalJob {
  withdrawalRequestId: string;
  userId: string;
  asset: string;
  amount: string;
  toAddress: string;
  network: string;
}

/**
 * Create a withdrawal request and reserve funds atomically.
 * This is the entry point called by bot handlers.
 *
 * Flow:
 *   1. Validate user has sufficient available balance
 *   2. Create WithdrawalRequest record (PENDING)
 *   3. Reserve/debit funds via TreasuryService
 *   4. Update request to QUEUED
 *   5. Enqueue job for the signer worker
 *
 * If step 3 fails (insufficient balance), the request stays PENDING and is not queued.
 */
export async function requestWithdrawal(params: {
  userId: string;
  asset: string;
  amount: string;
  toAddress: string;
  network: string;
}): Promise<string> {
  const { userId, asset, amount, toAddress, network } = params;

  // 1. Validate balance
  const bal = await walletService.getBalance(userId, asset);
  if (parseFloat(bal.available) < parseFloat(amount)) {
    throw new Error(
      `Insufficient balance: available=${bal.available}, requested=${amount}`
    );
  }

  // 2. Create withdrawal request
  const idempotencyKey = `wd_req:${userId}:${asset}:${amount}:${toAddress}`;
  const request = await prisma.withdrawalRequest.create({
    data: {
      userId,
      asset,
      amount,
      network,
      toAddress,
      status: "PENDING",
      idempotencyKey,
    },
  }).catch((e) => {
    if (e.message?.includes("Unique")) {
      throw new Error("IDEMPOTENT_DUPLICATE: withdrawal request already exists");
    }
    throw e;
  });

  // 3. Reserve funds atomically via TreasuryService
  try {
    await treasuryService.reserveWithdrawal({
      userId,
      amount,
      asset,
      withdrawalRequestId: request.id,
    });
  } catch (e) {
    // Reservation failed — mark request as FAILED, do NOT queue
    await prisma.withdrawalRequest.update({
      where: { id: request.id },
      data: { status: "FAILED", error: "Reservation failed" },
    });
    throw e;
  }

  // 4. Update status and enqueue
  await prisma.withdrawalRequest.update({
    where: { id: request.id },
    data: { status: "QUEUED", queuedAt: new Date() },
  });

  const jobId = `wd_${request.id}`;
  await withdrawalQueue.add(
    {
      withdrawalRequestId: request.id,
      userId,
      asset,
      amount,
      toAddress,
      network,
    } satisfies WithdrawalJob,
    { jobId }
  );

  // Create user-facing PENDING transaction
  await prisma.transaction.create({
    data: {
      userId,
      type: "WITHDRAWAL",
      asset,
      amount,
      status: "PENDING",
    },
  });

  logger.info(
    { withdrawalRequestId: request.id, userId, asset, amount, toAddress },
    "Withdrawal requested and reserved"
  );

  return request.id;
}

/**
 * Process a withdrawal in the signer worker (separate process).
 *
 * Flow:
 *   1. Re-validate the request
 *   2. Mark BROADCASTING
 *   3. Build & sign on-chain transaction
 *   4. Broadcast to network
 *   5. If broadcast fails → REVERSE the reservation
 *   6. If broadcast succeeds → record txHash, mark CONFIRMING
 *   7. Wait for confirmations
 *   8. Mark COMPLETED
 */
async function processWithdrawal(job: WithdrawalJob) {
  const { withdrawalRequestId, userId, asset, amount, toAddress, network } = job;
  logger.info({ withdrawalRequestId, userId, asset, amount, toAddress, network }, "Processing withdrawal");

  // 1. Re-validate request exists and is QUEUED
  const request = await prisma.withdrawalRequest.findUnique({
    where: { id: withdrawalRequestId },
  });
  if (!request) throw new Error(`Withdrawal request not found: ${withdrawalRequestId}`);
  if (request.status !== "QUEUED") {
    throw new Error(`Withdrawal request in wrong state: ${request.status}`);
  }

  // 2. Mark BROADCASTING
  await prisma.withdrawalRequest.update({
    where: { id: withdrawalRequestId },
    data: { status: "BROADCASTING", broadcastAt: new Date() },
  });

  // 3. Build & sign on-chain transaction
  // In production, this calls the isolated signer process.
  // TRC20: tronweb.sign + broadcast
  // BEP20: ethers.js sign + broadcast
  let txHash: string | null = null;
  try {
    txHash = await broadcastOnChain({ toAddress, amount, asset, network });
  } catch (e) {
    // BROADCAST FAILED → reverse the reservation
    logger.error({ withdrawalRequestId, err: e }, "On-chain broadcast failed, reversing reservation");

    await treasuryService.reverseWithdrawal({
      userId,
      amount,
      asset,
      withdrawalRequestId,
    });

    await prisma.withdrawalRequest.update({
      where: { id: withdrawalRequestId },
      data: {
        status: "REVERSED",
        error: e instanceof Error ? e.message : "Broadcast failed",
        reversedAt: new Date(),
      },
    });

    // Mark user-facing transaction as FAILED
    await prisma.transaction.updateMany({
      where: { userId, type: "WITHDRAWAL", asset, amount, status: "PENDING" },
      data: { status: "FAILED" },
    });

    await notificationService.notifyUser(
      userId,
      `<b>WITHDRAWAL FAILED</b>\n\n${amount} ${asset} has been returned to your wallet.\nReason: ${e instanceof Error ? e.message : "Unknown"}`
    );

    throw e; // re-throw so Bull retries are NOT consumed as success
  }

  // 4. Broadcast succeeded — record txHash
  await prisma.withdrawalRequest.update({
    where: { id: withdrawalRequestId },
    data: { txHash, status: "CONFIRMING" },
  });

  // Update user-facing transaction
  await prisma.transaction.updateMany({
    where: { userId, type: "WITHDRAWAL", asset, amount, status: "PENDING" },
    data: { status: "CONFIRMED", txHash },
  });

  // 5. Mark COMPLETED (in production, wait for on-chain confirmations)
  await prisma.withdrawalRequest.update({
    where: { id: withdrawalRequestId },
    data: { status: "COMPLETED", completedAt: new Date() },
  });

  // 6. Notify user
  await notificationService.notifyWithdrawalComplete(userId, asset, amount, txHash);

  logger.info({ withdrawalRequestId, txHash }, "Withdrawal completed");
}

/**
 * Broadcast a transaction on-chain.
 * In production, this calls the isolated signer process via IPC or API.
 * For now, returns a placeholder — NEVER treat this as production-ready.
 */
async function broadcastOnChain(params: {
  toAddress: string;
  amount: string;
  asset: string;
  network: string;
}): Promise<string> {
  // TODO: Implement real blockchain broadcast
  // TRC20: use tronweb with WITHDRAWAL_SIGNER_PRIVATE_KEY
  // BEP20: use ethers.js Wallet with WITHDRAWAL_SIGNER_PRIVATE_KEY
  if (!config.withdrawalSignerKey) {
    throw new Error(
      "WITHDRAWAL_SIGNER_PRIVATE_KEY not configured. " +
      "Cannot broadcast on-chain transaction."
    );
  }
  throw new Error("On-chain broadcast not yet implemented — configure signer process");
}

// ── Reconciliation ─────────────────────────────────────────────────
async function reconcile() {
  logger.info("Running reconciliation...");

  const balances = await prisma.balance.findMany();
  let totalByAsset: Record<string, { available: number; locked: number }> = {};

  for (const b of balances) {
    if (!totalByAsset[b.asset]) totalByAsset[b.asset] = { available: 0, locked: 0 };
    totalByAsset[b.asset].available += parseFloat(b.available.toString());
    totalByAsset[b.asset].locked += parseFloat(b.locked.toString());
  }

  for (const [asset, totals] of Object.entries(totalByAsset)) {
    logger.info(
      { asset, available: totals.available, locked: totals.locked, total: totals.available + totals.locked },
      "Asset balance summary"
    );
  }

  // Validate all LedgerTransactions net to zero
  const allTx = await prisma.ledgerTransaction.findMany({ select: { id: true } });
  let violations = 0;
  for (const tx of allTx) {
    const result = await treasuryService.validateLedgerTx(tx.id);
    if (!result.valid) {
      logger.error({ ledgerTxId: tx.id, netSum: result.netSum }, "LEDGER NET-ZERO VIOLATION");
      violations++;
    }
  }
  if (violations > 0) {
    logger.error({ violations }, `Found ${violations} net-zero violations!`);
  } else {
    logger.info("All ledger transactions pass net-zero check");
  }

  // Check stuck withdrawals
  const stuckWithdrawals = await prisma.withdrawalRequest.findMany({
    where: {
      status: { in: ["BROADCASTING", "CONFIRMING"] },
      createdAt: { lt: new Date(Date.now() - 3_600_000) },
    },
  });
  if (stuckWithdrawals.length > 0) {
    logger.warn(
      { count: stuckWithdrawals.length },
      "Found stuck withdrawals — manual review needed"
    );
  }

  logger.info("Reconciliation complete");
}

// ── Run Mode ────────────────────────────────────────────────────────
const mode = process.argv[2];

if (mode === "reconcile") {
  reconcile()
    .then(() => process.exit(0))
    .catch((e) => { logger.error(e); process.exit(1); });
} else {
  withdrawalQueue.process("withdrawal", async (bullJob) => {
    const data = bullJob.data as WithdrawalJob;
    await processWithdrawal(data);
  });

  withdrawalQueue.on("failed", (job, err) => {
    logger.error({ jobId: job.id, err }, "Withdrawal job failed");
  });

  withdrawalQueue.on("completed", (job) => {
    logger.info({ jobId: job.id }, "Withdrawal job completed");
  });

  logger.info("Withdrawal worker started, consuming from queue");
  setInterval(() => { logger.debug("Withdrawal worker heartbeat"); }, 60_000);
}
