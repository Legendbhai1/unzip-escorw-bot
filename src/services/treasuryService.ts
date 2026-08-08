import { prisma, Prisma } from "../lib/db.js";
import { logger } from "../lib/logger.js";

// ─── Types ─────────────────────────────────────────────────────────────

export interface LedgerEntryInput {
  userId: string;
  type: string; // LedgerEntryType
  amount: string; // signed: positive=credit, negative=debit
  dealId?: string;
  referenceType?: string;
  referenceId?: string;
}

export interface TreasuryResult {
  ledgerTxId: string;
  entries: Array<{
    userId: string;
    amount: string;
    balanceAfter: string;
    type: string;
  }>;
}

// ─── Decimal helpers (avoid float issues) ──────────────────────────────

function dec(val: string | number): Prisma.Decimal {
  return new Prisma.Decimal(val);
}

function sumDecimals(...vals: Prisma.Decimal[]): Prisma.Decimal {
  return vals.reduce((a, b) => a.add(b), dec(0));
}

// ─── Idempotency check helper ──────────────────────────────────────────

async function checkIdempotency(idempotencyKey: string): Promise<boolean> {
  const existing = await prisma.ledgerEntry.findUnique({
    where: { idempotencyKey },
  });
  return existing !== null;
}

// ─── Core: execute a LedgerTransaction atomically ──────────────────────

async function executeLedgerTransaction(params: {
  type: string;
  asset: string;
  amount: string;
  dealId?: string;
  referenceType?: string;
  referenceId?: string;
  idempotencyKeys: string[];
  entries: LedgerEntryInput[];
}): Promise<TreasuryResult> {
  // Pre-check: if ANY idempotency key already exists, this is a duplicate
  for (const key of params.idempotencyKeys) {
    if (await checkIdempotency(key)) {
      logger.warn({ idempotencyKey: key }, "Idempotency: operation already executed");
      throw new Error(`IDEMPOTENT_DUPLICATE:${key}`);
    }
  }

  // Net-zero validation: sum of all entry amounts must equal 0
  let netSum = dec(0);
  for (const entry of params.entries) {
    netSum = netSum.add(dec(entry.amount));
  }
  // For FEE entries credited to the platform (userId = HOUSE), they count as positive.
  // For operations involving the fee, the total should be:
  // buyer debits + seller credits + fee credits = 0
  if (netSum.abs().gt(dec("0.00000001"))) {
    throw new Error(
      `NET_ZERO_VIOLATION: entries sum to ${netSum.toString()}, expected 0`
    );
  }

  // Execute atomically
  const result = await prisma.$transaction(async (tx) => {
    // 1. Read all affected balances WITH row lock (FOR UPDATE)
    const affectedUserIds = [...new Set(params.entries.map((e) => e.userId))];
    const balanceRows = await tx.$queryRaw<
      Array<{ userId: string; asset: string; available: string; locked: string }>
    >(
      Prisma.sql`SELECT user_id as "userId", asset, available, locked
        FROM balances
        WHERE user_id = ANY(${affectedUserIds}::uuid[])
          AND asset = ${params.asset}
        FOR UPDATE`
    );

    const balanceMap = new Map<string, { available: Prisma.Decimal; locked: Prisma.Decimal }>();
    for (const row of balanceRows) {
      balanceMap.set(row.userId, {
        available: dec(row.available),
        locked: dec(row.locked),
      });
    }

    // 2. Apply mutations to balances and compute balanceAfter for each entry
    const entryResults: TreasuryResult["entries"] = [];
    const userBalances = new Map<string, { available: Prisma.Decimal; locked: Prisma.Decimal }>();

    // Copy starting balances
    for (const [uid, bal] of balanceMap) {
      userBalances.set(uid, { available: bal.available, locked: bal.locked });
    }

    for (const entry of params.entries) {
      let userBal = userBalances.get(entry.userId);
      if (!userBal) {
        // First time seeing this user+asset — create with zeros
        userBal = { available: dec(0), locked: dec(0) };
        userBalances.set(entry.userId, userBal);
      }

      const amount = dec(entry.amount);
      const isNegative = amount.lt(dec(0));
      const absAmount = amount.abs();

      // Determine which bucket to mutate based on entry type
      const type = entry.type as string;
      if (
        type === "ESCROW_LOCK" ||
        type === "ESCROW_RELEASE"
      ) {
        // ESCROW_LOCK: negative = debit from available, positive = credit to locked
        // ESCROW_RELEASE: negative = debit from locked, positive = credit to available
        if (isNegative) {
          if (type === "ESCROW_LOCK") {
            // Debit from available
            if (userBal.available.lt(absAmount)) {
              throw new Error(
                `INSUFFICIENT_AVAILABLE: user=${entry.userId} have=${userBal.available} need=${absAmount}`
              );
            }
            userBal.available = userBal.available.sub(absAmount);
          } else {
            // ESCROW_RELEASE debit from locked
            if (userBal.locked.lt(absAmount)) {
              throw new Error(
                `INSUFFICIENT_LOCKED: user=${entry.userId} have=${userBal.locked} need=${absAmount}`
              );
            }
            userBal.locked = userBal.locked.sub(absAmount);
          }
        } else {
          if (type === "ESCROW_LOCK") {
            // Credit to locked
            userBal.locked = userBal.locked.add(absAmount);
          } else {
            // Credit to available
            userBal.available = userBal.available.add(absAmount);
          }
        }
      } else if (type === "WITHDRAWAL") {
        // Always debit from available
        if (userBal.available.lt(absAmount)) {
          throw new Error(
            `INSUFFICIENT_AVAILABLE: user=${entry.userId} have=${userBal.available} need=${absAmount}`
          );
        }
        userBal.available = userBal.available.sub(absAmount);
      } else if (type === "DEPOSIT") {
        // Always credit to available
        userBal.available = userBal.available.add(absAmount);
      } else if (type === "REFUND") {
        // Refund: positive = credit to available, negative = debit from locked
        if (isNegative) {
          if (userBal.locked.lt(absAmount)) {
            throw new Error(`INSUFFICIENT_LOCKED: user=${entry.userId}`);
          }
          userBal.locked = userBal.locked.sub(absAmount);
        } else {
          userBal.available = userBal.available.add(absAmount);
        }
      } else if (type === "FEE") {
        // Fee credits go to available (platform fee account)
        userBal.available = userBal.available.add(absAmount);
      } else {
        // Generic: positive=credit available, negative=debit available
        if (isNegative) {
          if (userBal.available.lt(absAmount)) {
            throw new Error(`INSUFFICIENT_AVAILABLE: user=${entry.userId}`);
          }
          userBal.available = userBal.available.sub(absAmount);
        } else {
          userBal.available = userBal.available.add(absAmount);
        }
      }

      // balanceAfter = total holdings (available + locked) after this entry
      const balanceAfter = userBal.available.add(userBal.locked);
      entryResults.push({
        userId: entry.userId,
        amount: entry.amount,
        balanceAfter: balanceAfter.toString(),
        type: entry.type,
      });
    }

    // 3. Upsert all affected balances
    for (const [userId, bal] of userBalances) {
      await tx.balance.upsert({
        where: { userId_asset: { userId, asset: params.asset } },
        create: {
          userId,
          asset: params.asset,
          available: bal.available,
          locked: bal.locked,
        },
        update: {
          available: bal.available,
          locked: bal.locked,
        },
      });
    }

    // 4. Create LedgerTransaction (grouping container)
    const ledgerTx = await tx.ledgerTransaction.create({
      data: {
        type: params.type,
        asset: params.asset,
        amount: params.amount,
        dealId: params.dealId,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
      },
    });

    // 5. Create all LedgerEntries
    for (let i = 0; i < params.entries.length; i++) {
      const entry = params.entries[i];
      const result = entryResults[i];
      await tx.ledgerEntry.create({
        data: {
          ledgerTxId: ledgerTx.id,
          userId: entry.userId,
          dealId: entry.dealId,
          type: entry.type as any,
          amount: entry.amount,
          asset: params.asset,
          balanceAfter: result.balanceAfter,
          idempotencyKey: params.idempotencyKeys[i],
          referenceType: (entry.referenceType ?? params.referenceType) as any,
          referenceId: entry.referenceId ?? params.referenceId,
        },
      });
    }

    return {
      ledgerTxId: ledgerTx.id,
      entries: entryResults,
    };
  });

  logger.info(
    { ledgerTxId: result.ledgerTxId, type: params.type, asset: params.asset },
    `Treasury operation: ${params.type}`
  );
  return result;
}

// ─── House / Fee Account ───────────────────────────────────────────────
// The platform fee account is a special user. Its balance represents
// accumulated fees. In production, create this user during seed.

export const HOUSE_USER_ID = "00000000-0000-0000-0000-000000000000";

async function ensureHouseAccount(asset: string) {
  await prisma.balance.upsert({
    where: { userId_asset: { userId: HOUSE_USER_ID, asset } },
    create: { userId: HOUSE_USER_ID, asset, available: dec(0), locked: dec(0) },
    update: {},
  });
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — the ONLY way to mutate balances
// ═══════════════════════════════════════════════════════════════════════

export const treasuryService = {
  /**
   * Credit a blockchain-verified deposit to a user's available balance.
   * Flow: Blockchain Deposit -> User Wallet (Available)
   *
   * LedgerTransaction:
   *   User: +amount (DEPOSIT)
   */
  async creditDeposit(params: {
    userId: string;
    amount: string;
    asset: string;
    txHash: string;
    network: string;
  }): Promise<TreasuryResult> {
    const { userId, amount, asset, txHash, network } = params;
    const idempotencyKey = `deposit:${txHash.toLowerCase()}`;

    // Record blockchain deposit (separate from ledger)
    await prisma.blockchainDeposit.upsert({
      where: { txHash: txHash.toLowerCase() },
      create: {
        userId,
        txHash: txHash.toLowerCase(),
        toAddress: "", // filled by monitor
        fromAddress: "",
        asset,
        network,
        amount,
        status: "CONFIRMED",
        creditedAt: new Date(),
      },
      update: { status: "CONFIRMED", creditedAt: new Date() },
    });

    const result = await executeLedgerTransaction({
      type: "DEPOSIT",
      asset,
      amount,
      dealId: undefined,
      referenceType: "BLOCKCHAIN_DEPOSIT",
      referenceId: undefined,
      idempotencyKeys: [idempotencyKey],
      entries: [
        {
          userId,
          type: "DEPOSIT",
          amount, // positive
        },
      ],
    });

    // Create user-facing transaction record
    await prisma.transaction.create({
      data: { userId, type: "DEPOSIT", asset, amount, status: "CONFIRMED", txHash },
    });

    return result;
  },

  /**
   * Lock funds from buyer's available into locked for a deal.
   * Flow: Available Balance -> Escrow Lock
   *
   * LedgerTransaction (2 entries, net zero):
   *   Buyer: -amount (ESCROW_LOCK from available)
   *   Buyer: +amount (ESCROW_LOCK to locked)
   */
  async escrowLock(params: {
    userId: string;
    dealId: string;
    amount: string;
    asset: string;
  }): Promise<TreasuryResult> {
    const { userId, dealId, amount, asset } = params;
    const idempotencyKey = `lock:${dealId}`;

    const result = await executeLedgerTransaction({
      type: "ESCROW_LOCK",
      asset,
      amount,
      dealId,
      referenceType: "DEAL",
      referenceId: dealId,
      idempotencyKeys: [idempotencyKey],
      entries: [
        {
          userId,
          dealId,
          type: "ESCROW_LOCK",
          amount: `-${amount}`, // debit available
        },
        {
          userId,
          dealId,
          type: "ESCROW_LOCK",
          amount, // credit locked
        },
      ],
    });

    // Create user-facing transaction record
    await prisma.transaction.create({
      data: { userId, type: "ESCROW_LOCK", asset, amount, status: "CONFIRMED", dealId },
    });

    return result;
  },

  /**
   * Release escrowed funds from buyer to seller with fee deduction.
   * Flow: Buyer Locked -> Seller Available + House Fee
   *
   * LedgerTransaction (3 entries, net zero):
   *   Buyer:    -amount         (ESCROW_RELEASE from locked)
   *   Seller:   +(amount - fee) (ESCROW_RELEASE to available)
   *   House:    +fee            (FEE to available)
   */
  async escrowRelease(params: {
    buyerId: string;
    sellerId: string;
    dealId: string;
    amount: string;
    asset: string;
    feeRate?: number;
  }): Promise<TreasuryResult> {
    const { buyerId, sellerId, dealId, amount, asset, feeRate = 0.01 } = params;
    const idempotencyKey = `release:${dealId}`;

    const totalAmount = dec(amount);
    const fee = totalAmount.mul(dec(feeRate));
    const sellerReceives = totalAmount.sub(fee);

    await ensureHouseAccount(asset);

    const result = await executeLedgerTransaction({
      type: "ESCROW_RELEASE",
      asset,
      amount,
      dealId,
      referenceType: "DEAL",
      referenceId: dealId,
      idempotencyKeys: [idempotencyKey],
      entries: [
        {
          userId: buyerId,
          dealId,
          type: "ESCROW_RELEASE",
          amount: `-${amount}`, // debit from locked
        },
        {
          userId: sellerId,
          dealId,
          type: "ESCROW_RELEASE",
          amount: sellerReceives.toString(), // credit to available
        },
        {
          userId: HOUSE_USER_ID,
          type: "FEE",
          amount: fee.toString(), // fee credit
          referenceType: "DEAL",
          referenceId: dealId,
        },
      ],
    });

    // Create user-facing transaction records
    await prisma.transaction.create({
      data: { userId: buyerId, type: "ESCROW_RELEASE", asset, amount: `-${amount}`, status: "CONFIRMED", dealId },
    });
    await prisma.transaction.create({
      data: { userId: sellerId, type: "ESCROW_RELEASE", asset, amount: sellerReceives.toString(), status: "CONFIRMED", dealId },
    });

    // Update deal fee amount
    await prisma.deal.update({
      where: { id: dealId },
      data: { feeAmount: fee },
    });

    return result;
  },

  /**
   * Refund escrowed funds from locked back to buyer's available.
   * Flow: Buyer Locked -> Buyer Available
   *
   * LedgerTransaction (2 entries, net zero):
   *   Buyer: -amount (REFUND from locked)
   *   Buyer: +amount (REFUND to available)
   */
  async refund(params: {
    userId: string;
    dealId: string;
    amount: string;
    asset: string;
  }): Promise<TreasuryResult> {
    const { userId, dealId, amount, asset } = params;
    const idempotencyKey = `refund:${dealId}`;

    const result = await executeLedgerTransaction({
      type: "REFUND",
      asset,
      amount,
      dealId,
      referenceType: "DEAL",
      referenceId: dealId,
      idempotencyKeys: [idempotencyKey],
      entries: [
        {
          userId,
          dealId,
          type: "REFUND",
          amount: `-${amount}`, // debit from locked
        },
        {
          userId,
          dealId,
          type: "REFUND",
          amount, // credit to available
        },
      ],
    });

    // Create user-facing transaction record
    await prisma.transaction.create({
      data: { userId, type: "REFUND", asset, amount, status: "CONFIRMED", dealId },
    });

    return result;
  },

  /**
   * Reserve funds for a withdrawal (debit from available).
   * This is the first step of the withdrawal flow.
   * Flow: Available -> Reserved (debit, funds leave user balance)
   *
   * LedgerTransaction (1 entry):
   *   User: -amount (WITHDRAWAL from available)
   *
   * If broadcast fails, call reverseWithdrawal() to credit back.
   */
  async reserveWithdrawal(params: {
    userId: string;
    amount: string;
    asset: string;
    withdrawalRequestId: string;
  }): Promise<TreasuryResult> {
    const { userId, amount, asset, withdrawalRequestId } = params;
    const idempotencyKey = `withdrawal_reserve:${withdrawalRequestId}`;

    const result = await executeLedgerTransaction({
      type: "WITHDRAWAL",
      asset,
      amount,
      referenceType: "WITHDRAWAL_REQUEST",
      referenceId: withdrawalRequestId,
      idempotencyKeys: [idempotencyKey],
      entries: [
        {
          userId,
          type: "WITHDRAWAL",
          amount: `-${amount}`, // debit from available
          referenceType: "WITHDRAWAL_REQUEST",
          referenceId: withdrawalRequestId,
        },
      ],
    });

    return result;
  },

  /**
   * Reverse a failed withdrawal (credit back to available).
   * Flow: Reserved -> Available (credit back)
   *
   * LedgerTransaction (1 entry):
   *   User: +amount (WITHDRAWAL reversal to available)
   */
  async reverseWithdrawal(params: {
    userId: string;
    amount: string;
    asset: string;
    withdrawalRequestId: string;
  }): Promise<TreasuryResult> {
    const { userId, amount, asset, withdrawalRequestId } = params;
    const idempotencyKey = `withdrawal_reverse:${withdrawalRequestId}`;

    const result = await executeLedgerTransaction({
      type: "WITHDRAWAL_REVERSAL",
      asset,
      amount,
      referenceType: "WITHDRAWAL_REQUEST",
      referenceId: withdrawalRequestId,
      idempotencyKeys: [idempotencyKey],
      entries: [
        {
          userId,
          type: "WITHDRAWAL",
          amount, // credit back
          referenceType: "WITHDRAWAL_REQUEST",
          referenceId: withdrawalRequestId,
        },
      ],
    });

    return result;
  },

  // ── Read-only queries ────────────────────────────────────────────

  async getBalance(userId: string, asset: string) {
    const bal = await prisma.balance.findUnique({
      where: { userId_asset: { userId, asset } },
    });
    return {
      available: bal?.available.toString() ?? "0",
      locked: bal?.locked.toString() ?? "0",
    };
  },

  async getAllBalances(userId: string) {
    const rows = await prisma.balance.findMany({ where: { userId } });
    return rows.map((r) => ({
      asset: r.asset,
      available: r.available.toString(),
      locked: r.locked.toString(),
    }));
  },

  /**
   * Validate that a LedgerTransaction's entries net to zero.
   * Used by reconciliation and tests.
   */
  async validateLedgerTx(ledgerTxId: string): Promise<{ netSum: string; valid: boolean }> {
    const entries = await prisma.ledgerEntry.findMany({
      where: { ledgerTxId },
    });
    let netSum = dec(0);
    for (const entry of entries) {
      netSum = netSum.add(dec(entry.amount.toString()));
    }
    return {
      netSum: netSum.toString(),
      valid: netSum.abs().lte(dec("0.00000001")),
    };
  },
};
