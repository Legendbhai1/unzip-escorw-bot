import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/db.js";
import { treasuryService } from "../services/treasuryService.js";
import { notificationService } from "../services/notificationService.js";
import { reconciliationService } from "../services/reconciliationService.js";
import { esc } from "../lib/html.js";
import Queue from "bull";
import { redis as redisClient } from "../lib/redis.js";

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
 *
 * Flow:
 *   1. Validate user has sufficient available balance
 *   2. Create WithdrawalRequest record (PENDING) with idempotency key
 *   3. Reserve/debit funds via TreasuryService
 *   4. Update request to QUEUED
 *   5. Enqueue job for the signer worker
 */
export async function requestWithdrawal(params: {
  userId: string;
  asset: string;
  amount: string;
  toAddress: string;
  network: string;
}): Promise<string> {
  const { userId, asset, amount, toAddress, network } = params;

  // 1. Validate balance via treasuryService (single source of truth)
  const bal = await treasuryService.getBalance(userId, asset);
  if (parseFloat(bal.available) < parseFloat(amount)) {
    throw new Error(
      `Insufficient balance: available=${bal.available}, requested=${amount}`
    );
  }

  // 2. Create withdrawal request with idempotency key
  const idempotencyKey = `wd_req:${userId}:${asset}:${amount}:${toAddress}`;
  const request = await prisma.withdrawalRequest.create({
    data: {
      userId, asset, amount, network, toAddress,
      status: "PENDING", idempotencyKey,
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
      userId, amount, asset, withdrawalRequestId: request.id,
    });
  } catch (e) {
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
      userId, asset, amount, toAddress, network,
    } satisfies WithdrawalJob,
    { jobId }
  );

  // Create user-facing PENDING transaction
  await prisma.transaction.create({
    data: { userId, type: "WITHDRAWAL", asset, amount, status: "PENDING" },
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
 *   5. If broadcast fails -> REVERSE the reservation
 *   6. If broadcast succeeds -> record txHash, mark CONFIRMING
 *   7. Mark COMPLETED
 */
async function processWithdrawal(job: WithdrawalJob) {
  const { withdrawalRequestId, userId, asset, amount, toAddress, network } = job;
  logger.info({ withdrawalRequestId, userId, asset, amount, toAddress, network }, "Processing withdrawal");

  // 1. Re-validate
  const request = await prisma.withdrawalRequest.findUnique({ where: { id: withdrawalRequestId } });
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
  let txHash: string | null = null;
  try {
    txHash = await broadcastOnChain({ toAddress, amount, asset, network });
  } catch (e) {
    // BROADCAST FAILED -> reverse the reservation
    logger.error({ withdrawalRequestId, err: e }, "On-chain broadcast failed, reversing reservation");

    await treasuryService.reverseWithdrawal({
      userId, amount, asset, withdrawalRequestId,
    });

    await prisma.withdrawalRequest.update({
      where: { id: withdrawalRequestId },
      data: {
        status: "REVERSED",
        error: e instanceof Error ? e.message : "Broadcast failed",
        reversedAt: new Date(),
      },
    });

    await prisma.transaction.updateMany({
      where: { userId, type: "WITHDRAWAL", asset, amount, status: "PENDING" },
      data: { status: "FAILED" },
    });

    await notificationService.notifyUser(
      userId,
      `<b>WITHDRAWAL FAILED</b>\n\n${esc(amount)} ${esc(asset)} has been returned to your wallet.\nReason: ${esc(e instanceof Error ? e.message : "Unknown")}`
    );

    throw e;
  }

  // 4. Broadcast succeeded
  await prisma.withdrawalRequest.update({
    where: { id: withdrawalRequestId },
    data: { txHash, status: "CONFIRMING" },
  });

  await prisma.transaction.updateMany({
    where: { userId, type: "WITHDRAWAL", asset, amount, status: "PENDING" },
    data: { status: "CONFIRMED", txHash },
  });

  // 5. Mark COMPLETED
  await prisma.withdrawalRequest.update({
    where: { id: withdrawalRequestId },
    data: { status: "COMPLETED", completedAt: new Date() },
  });

  await notificationService.notifyWithdrawalComplete(userId, asset, amount, txHash);
  logger.info({ withdrawalRequestId, txHash }, "Withdrawal completed");
}

/**
 * Broadcast a transaction on-chain.
 * In production, calls the isolated signer process via IPC or API.
 * NEVER returns fake/stub hashes.
 */
async function broadcastOnChain(params: {
  toAddress: string;
  amount: string;
  asset: string;
  network: string;
}): Promise<string> {
  if (!config.withdrawalSignerKey) {
    throw new Error(
      "WITHDRAWAL_SIGNER_PRIVATE_KEY not configured. Cannot broadcast on-chain transaction."
    );
  }

  // TODO: Implement real blockchain broadcast
  // TRC20: tronweb.sign + broadcast
  // BEP20: ethers.js Wallet + broadcast
  throw new Error("On-chain broadcast not yet implemented — configure signer process");
}

// ── Run Mode ────────────────────────────────────────────────────────
const mode = process.argv[2];

if (mode === "reconcile") {
  reconciliationService.runFull()
    .then((result) => {
      console.log("Reconciliation result:", JSON.stringify(result, null, 2));
      process.exit(result.ledgerViolations + result.userBalanceDiscrepancies > 0 ? 1 : 0);
    })
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
