import { prisma, Prisma } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { config } from "../config/index.js";

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
  idempotencyKey: string;
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

/**
 * Calculate fee from amount in basis points.
 * Uses integer math: fee = amount * bps / 10000
 * Returns Prisma.Decimal with 8 decimal places.
 */
function calcFee(amount: string | Prisma.Decimal, bps: number): Prisma.Decimal {
  const a = typeof amount === "string" ? dec(amount) : amount;
  return a.mul(dec(bps)).div(dec(10000));
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

// ─── Idempotency check helper ──────────────────────────────────────────
// Idempotency is now on LedgerTransaction.idempotencyKey (unique constraint).

async function checkIdempotency(idempotencyKey: string): Promise<boolean> {
  const existing = await prisma.ledgerTransaction.findUnique({
    where: { idempotencyKey },
  });
  return existing !== null;
}

// ─── Core: execute a LedgerTransaction atomically ──────────────────────

async function executeLedgerTransaction(params: {
  type: string;
  asset: string;
  amount: string;
  idempotencyKey: string;
  network?: string;
  dealId?: string;
  referenceType?: string;
  referenceId?: string;
  entries: LedgerEntryInput[];
}): Promise<TreasuryResult> {
  // Pre-check: idempotency on LedgerTransaction
  if (await checkIdempotency(params.idempotencyKey)) {
    logger.warn({ idempotencyKey: params.idempotencyKey }, "Idempotency: operation already executed");
    throw new Error(`IDEMPOTENT_DUPLICATE:${params.idempotencyKey}`);
  }

  // Net-zero validation: sum of all entry amounts must equal 0
  let netSum = dec(0);
  for (const entry of params.entries) {
    netSum = netSum.add(dec(entry.amount));
  }
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
        userBal = { available: dec(0), locked: dec(0) };
        userBalances.set(entry.userId, userBal);
      }

      const amount = dec(entry.amount);
      const isNegative = amount.lt(dec(0));
      const absAmount = amount.abs();

      const type = entry.type as string;
      if (type === "ESCROW_LOCK") {
        // ESCROW_LOCK: negative = debit from available, positive = credit to locked
        if (isNegative) {
          if (userBal.available.lt(absAmount)) {
            throw new Error(
              `INSUFFICIENT_AVAILABLE: user=${entry.userId} have=${userBal.available} need=${absAmount}`
            );
          }
          userBal.available = userBal.available.sub(absAmount);
        } else {
          userBal.locked = userBal.locked.add(absAmount);
        }
      } else if (type === "ESCROW_RELEASE") {
        // ESCROW_RELEASE: negative = debit from locked, positive = credit to available
        if (isNegative) {
          if (userBal.locked.lt(absAmount)) {
            throw new Error(
              `INSUFFICIENT_LOCKED: user=${entry.userId} have=${userBal.locked} need=${absAmount}`
            );
          }
          userBal.locked = userBal.locked.sub(absAmount);
        } else {
          userBal.available = userBal.available.add(absAmount);
        }
      } else if (type === "WITHDRAWAL") {
        if (isNegative) {
          if (userBal.available.lt(absAmount)) {
            throw new Error(
              `INSUFFICIENT_AVAILABLE: user=${entry.userId} have=${userBal.available} need=${absAmount}`
            );
          }
          userBal.available = userBal.available.sub(absAmount);
        } else {
          userBal.available = userBal.available.add(absAmount);
        }
      } else if (type === "DEPOSIT") {
        if (isNegative) {
          throw new Error(`INVALID_DEPOSIT_DEBIT: deposits must be positive`);
        }
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
        create: { userId, asset: params.asset, available: bal.available, locked: bal.locked },
        update: { available: bal.available, locked: bal.locked },
      });
    }

    // 4. Create LedgerTransaction (grouping container) with idempotency key
    const ledgerTx = await tx.ledgerTransaction.create({
      data: {
        type: params.type,
        asset: params.asset,
        amount: params.amount,
        network: params.network,
        idempotencyKey: params.idempotencyKey,
        dealId: params.dealId,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
      },
    });

    // 5. Create all LedgerEntries (NO per-entry idempotency key — that moved to LedgerTransaction)
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
          referenceType: (entry.referenceType ?? params.referenceType) as any,
          referenceId: entry.referenceId ?? params.referenceId,
        },
      });
    }

    return {
      ledgerTxId: ledgerTx.id,
      idempotencyKey: params.idempotencyKey,
      entries: entryResults,
    };
  });

  logger.info(
    { ledgerTxId: result.ledgerTxId, type: params.type, asset: params.asset, idempotencyKey: params.idempotencyKey },
    `Treasury operation: ${params.type}`
  );
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — the ONLY way to mutate balances
// ═══════════════════════════════════════════════════════════════════════

export const treasuryService = {
  /**
   * Credit a blockchain-verified deposit to a user's available balance.
   * Flow: Blockchain Deposit -> User Wallet (Available)
   *
   * LedgerTransaction (1 entry — no counterparty, net != 0 is allowed for external inflows):
   *   Actually, for pure deposits from external blockchain, we still need net-zero.
   *   We treat it as: User +amount, no counterparty.
   *   To maintain net-zero invariant for ALL ledger transactions,
   *   deposits use a single positive entry. The net-zero check is relaxed
   *   for DEPOSIT type since the "other side" is the external blockchain.
   */
  async creditDeposit(params: {
    userId: string;
    amount: string;
    asset: string;
    txHash: string;
    network: string;
    logIndex?: number;
    fromAddress?: string;
    toAddress?: string;
  }): Promise<TreasuryResult> {
    const { userId, amount, asset, txHash, network, logIndex = 0, fromAddress = "", toAddress = "" } = params;
    const idempotencyKey = `deposit:${network}:${txHash.toLowerCase()}:${logIndex}`;

    // Record blockchain deposit (separate from ledger)
    // Use firstOrCreate since composite unique is at DB level
    await prisma.blockchainDeposit.upsert({
      where: { id: `placeholder_${txHash.toLowerCase()}_${logIndex}` },
      create: {
        userId,
        txHash: txHash.toLowerCase(),
        logIndex,
        fromAddress,
        toAddress,
        asset,
        network,
        amount,
        status: "CONFIRMED",
        creditedAt: new Date(),
      },
      update: { status: "CONFIRMED", creditedAt: new Date() },
    }).catch(() => {
      // Unique constraint violation means it already exists - that's fine
    });

    // For deposits, we allow non-zero net since money comes from outside the system.
    // We bypass the net-zero check by executing directly.
    if (await checkIdempotency(idempotencyKey)) {
      logger.warn({ idempotencyKey }, "Idempotency: deposit already credited");
      throw new Error(`IDEMPOTENT_DUPLICATE:${idempotencyKey}`);
    }

    const result = await prisma.$transaction(async (tx) => {
      // Lock and read user balance
      const rows = await tx.$queryRaw<
        Array<{ userId: string; asset: string; available: string; locked: string }>
      >(
        Prisma.sql`SELECT user_id as "userId", asset, available, locked
          FROM balances WHERE user_id = ${userId} AND asset = ${asset}
          FOR UPDATE`
      );

      let available = dec(0);
      let locked = dec(0);
      if (rows.length > 0) {
        available = dec(rows[0].available);
        locked = dec(rows[0].locked);
      }

      available = available.add(dec(amount));
      const balanceAfter = available.add(locked);

      await tx.balance.upsert({
        where: { userId_asset: { userId, asset } },
        create: { userId, asset, available, locked },
        update: { available },
      });

      const ledgerTx = await tx.ledgerTransaction.create({
        data: {
          type: "DEPOSIT",
          asset,
          amount,
          network,
          idempotencyKey,
          referenceType: "BLOCKCHAIN_DEPOSIT",
        },
      });

      await tx.ledgerEntry.create({
        data: {
          ledgerTxId: ledgerTx.id,
          userId,
          type: "DEPOSIT",
          amount, // positive
          asset,
          balanceAfter: balanceAfter.toString(),
          referenceType: "BLOCKCHAIN_DEPOSIT",
        },
      });

      return {
        ledgerTxId: ledgerTx.id,
        idempotencyKey,
        entries: [{ userId, amount, balanceAfter: balanceAfter.toString(), type: "DEPOSIT" }],
      };
    });

    // Create user-facing transaction record
    await prisma.transaction.create({
      data: { userId, type: "DEPOSIT", asset, amount, status: "CONFIRMED", txHash },
    });

    logger.info({ ledgerTxId: result.ledgerTxId, userId, amount, asset, network, txHash }, "Deposit credited");
    return result;
  },

  /**
   * Fund an escrow deal from buyer's available balance.
   * Collects buyer fee upfront.
   *
   * Buyer must have: deal_amount + buyer_fee in AVAILABLE balance.
   *
   * LedgerTransaction (3 entries, net zero):
   *   Buyer AVAILABLE       -(amount + buyerFee)  [ESCROW_LOCK debit]
   *   Buyer ESCROW_LOCKED   +amount               [ESCROW_LOCK credit]
   *   Platform FEE          +buyerFee             [FEE credit]
   *
   * Net = -(amount + buyerFee) + amount + buyerFee = 0
   */
  async fundEscrow(params: {
    userId: string;       // buyer
    dealId: string;
    amount: string;       // deal amount (principal)
    asset: string;
    buyerFeeBps: number;  // basis points
  }): Promise<TreasuryResult> {
    const { userId, dealId, amount, asset, buyerFeeBps } = params;
    const idempotencyKey = `fund:${dealId}`;

    const totalAmount = dec(amount);
    const buyerFee = calcFee(totalAmount, buyerFeeBps);
    const totalDebit = totalAmount.add(buyerFee); // what buyer pays

    await ensureHouseAccount(asset);

    const result = await executeLedgerTransaction({
      type: "ESCROW_FUND",
      asset,
      amount,
      idempotencyKey,
      dealId,
      referenceType: "DEAL",
      referenceId: dealId,
      entries: [
        {
          userId,
          dealId,
          type: "ESCROW_LOCK",
          amount: `-${totalDebit.toString()}`, // debit from available
        },
        {
          userId,
          dealId,
          type: "ESCROW_LOCK",
          amount: totalAmount.toString(), // credit to locked
        },
        {
          userId: HOUSE_USER_ID,
          type: "FEE",
          amount: buyerFee.toString(), // fee to platform
          referenceType: "DEAL",
          referenceId: dealId,
        },
      ],
    });

    // Update deal with buyer fee collected
    await prisma.deal.update({
      where: { id: dealId },
      data: { buyerFeeAmount: buyerFee },
    });

    // Create user-facing transaction record
    await prisma.transaction.create({
      data: { userId, type: "ESCROW_LOCK", asset, amount: totalDebit.toString(), status: "CONFIRMED", dealId },
    });

    return result;
  },

  /**
   * Release escrowed funds from buyer's locked to seller's available.
   * Deducts seller fee from the escrow amount.
   *
   * LedgerTransaction (3 entries, net zero):
   *   Buyer ESCROW_LOCKED   -amount             [ESCROW_RELEASE debit from locked]
   *   Seller AVAILABLE      +(amount - sellerFee) [ESCROW_RELEASE credit to available]
   *   Platform FEE          +sellerFee           [FEE credit]
   *
   * Net = -amount + (amount - sellerFee) + sellerFee = 0
   */
  async releaseEscrow(params: {
    buyerId: string;
    sellerId: string;
    dealId: string;
    amount: string;        // deal principal amount (the locked amount)
    asset: string;
    sellerFeeBps: number;  // basis points
  }): Promise<TreasuryResult> {
    const { buyerId, sellerId, dealId, amount, asset, sellerFeeBps } = params;
    const idempotencyKey = `release:${dealId}`;

    const totalAmount = dec(amount);
    const sellerFee = calcFee(totalAmount, sellerFeeBps);
    const sellerReceives = totalAmount.sub(sellerFee);

    await ensureHouseAccount(asset);

    const result = await executeLedgerTransaction({
      type: "ESCROW_RELEASE",
      asset,
      amount,
      idempotencyKey,
      dealId,
      referenceType: "DEAL",
      referenceId: dealId,
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
          amount: sellerFee.toString(), // seller fee to platform
          referenceType: "DEAL",
          referenceId: dealId,
        },
      ],
    });

    // Update deal with seller fee collected
    await prisma.deal.update({
      where: { id: dealId },
      data: { sellerFeeAmount: sellerFee },
    });

    // Create user-facing transaction records
    await prisma.transaction.create({
      data: { userId: buyerId, type: "ESCROW_RELEASE", asset, amount: `-${amount}`, status: "CONFIRMED", dealId },
    });
    await prisma.transaction.create({
      data: { userId: sellerId, type: "ESCROW_RELEASE", asset, amount: sellerReceives.toString(), status: "CONFIRMED", dealId },
    });

    return result;
  },

  /**
   * Refund escrowed funds from buyer's locked back to buyer's available.
   * Fee policy is configurable via config.
   *
   * If BUYER_FEE_REFUND_ON_REFUND = true:
   *   Return the full escrow principal + buyer fee to buyer.
   *   Debit buyer fee from platform account.
   *
   * If BUYER_FEE_REFUND_ON_REFUND = false:
   *   Return only the escrow principal. Buyer fee stays with platform.
   *
   * SELLER_FEE_CHARGED_ON_REFUND: never applicable for refund
   *   (seller fee is only charged on release).
   *
   * Case 1: Refund principal only (buyer fee kept by platform):
   *   Buyer LOCKED  -amount  [REFUND debit]
   *   Buyer AVAILABLE +amount  [REFUND credit]
   *   Net = 0
   *
   * Case 2: Refund principal + buyer fee:
   *   Buyer LOCKED     -amount      [REFUND debit]
   *   Buyer AVAILABLE   +amount      [REFUND credit]
   *   Platform FEE     -buyerFee    [FEE debit from platform available]
   *   Buyer AVAILABLE   +buyerFee    [REFUND credit]
   *   Net = -amount + amount - buyerFee + buyerFee = 0
   */
  async refundEscrow(params: {
    userId: string;       // buyer
    dealId: string;
    amount: string;       // escrow principal (the locked amount)
    buyerFeeAmount: string; // the buyer fee that was collected during funding
    asset: string;
    refundBuyerFee: boolean; // from config
  }): Promise<TreasuryResult> {
    const { userId, dealId, amount, buyerFeeAmount, asset, refundBuyerFee } = params;
    const idempotencyKey = `refund:${dealId}`;

    await ensureHouseAccount(asset);

    const entries: LedgerEntryInput[] = [
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
    ];

    // If refunding buyer fee, debit from platform and credit to buyer
    if (refundBuyerFee && dec(buyerFeeAmount).gt(dec(0))) {
      entries.push({
        userId: HOUSE_USER_ID,
        type: "FEE",
        amount: `-${buyerFeeAmount}`, // debit from platform available
        referenceType: "DEAL",
        referenceId: dealId,
      });
      entries.push({
        userId,
        dealId,
        type: "REFUND",
        amount: buyerFeeAmount, // credit to buyer available
      });
    }

    const result = await executeLedgerTransaction({
      type: "REFUND",
      asset,
      amount,
      idempotencyKey,
      dealId,
      referenceType: "DEAL",
      referenceId: dealId,
      entries,
    });

    // Create user-facing transaction record
    await prisma.transaction.create({
      data: { userId, type: "REFUND", asset, amount, status: "CONFIRMED", dealId },
    });

    return result;
  },

  /**
   * Reserve funds for a withdrawal (debit from available).
   * Flow: Available -> Reserved (debit, funds leave user balance)
   *
   * LedgerTransaction (1 entry):
   *   User: -amount (WITHDRAWAL from available)
   *
   * Note: Single-entry withdrawals don't net to zero internally —
   * the funds are "leaving" the system (going to external blockchain).
   * We bypass net-zero check for WITHDRAWAL type.
   */
  async reserveWithdrawal(params: {
    userId: string;
    amount: string;
    asset: string;
    withdrawalRequestId: string;
  }): Promise<TreasuryResult> {
    const { userId, amount, asset, withdrawalRequestId } = params;
    const idempotencyKey = `withdrawal_reserve:${withdrawalRequestId}`;

    // Withdrawals are single-entry (money leaving the system).
    // Bypass net-zero check.
    if (await checkIdempotency(idempotencyKey)) {
      throw new Error(`IDEMPOTENT_DUPLICATE:${idempotencyKey}`);
    }

    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ userId: string; asset: string; available: string; locked: string }>
      >(
        Prisma.sql`SELECT user_id as "userId", asset, available, locked
          FROM balances WHERE user_id = ${userId} AND asset = ${asset}
          FOR UPDATE`
      );

      let available = dec(0);
      let locked = dec(0);
      if (rows.length > 0) {
        available = dec(rows[0].available);
        locked = dec(rows[0].locked);
      }

      const amt = dec(amount);
      if (available.lt(amt)) {
        throw new Error(
          `INSUFFICIENT_AVAILABLE: user=${userId} have=${available} need=${amt}`
        );
      }

      available = available.sub(amt);
      const balanceAfter = available.add(locked);

      await tx.balance.upsert({
        where: { userId_asset: { userId, asset } },
        create: { userId, asset, available, locked },
        update: { available },
      });

      const ledgerTx = await tx.ledgerTransaction.create({
        data: {
          type: "WITHDRAWAL",
          asset,
          amount,
          idempotencyKey,
          referenceType: "WITHDRAWAL_REQUEST",
          referenceId: withdrawalRequestId,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          ledgerTxId: ledgerTx.id,
          userId,
          type: "WITHDRAWAL",
          amount: `-${amount}`,
          asset,
          balanceAfter: balanceAfter.toString(),
          referenceType: "WITHDRAWAL_REQUEST",
          referenceId: withdrawalRequestId,
        },
      });

      return {
        ledgerTxId: ledgerTx.id,
        idempotencyKey,
        entries: [{ userId, amount: `-${amount}`, balanceAfter: balanceAfter.toString(), type: "WITHDRAWAL" }],
      };
    });

    return result;
  },

  /**
   * Reverse a failed withdrawal (credit back to available).
   * Flow: Reserved -> Available (credit back)
   */
  async reverseWithdrawal(params: {
    userId: string;
    amount: string;
    asset: string;
    withdrawalRequestId: string;
  }): Promise<TreasuryResult> {
    const { userId, amount, asset, withdrawalRequestId } = params;
    const idempotencyKey = `withdrawal_reverse:${withdrawalRequestId}`;

    // Single-entry credit (money returning to the system from failed external tx).
    if (await checkIdempotency(idempotencyKey)) {
      throw new Error(`IDEMPOTENT_DUPLICATE:${idempotencyKey}`);
    }

    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ userId: string; asset: string; available: string; locked: string }>
      >(
        Prisma.sql`SELECT user_id as "userId", asset, available, locked
          FROM balances WHERE user_id = ${userId} AND asset = ${asset}
          FOR UPDATE`
      );

      let available = dec(0);
      let locked = dec(0);
      if (rows.length > 0) {
        available = dec(rows[0].available);
        locked = dec(rows[0].locked);
      }

      available = available.add(dec(amount));
      const balanceAfter = available.add(locked);

      await tx.balance.upsert({
        where: { userId_asset: { userId, asset } },
        create: { userId, asset, available, locked },
        update: { available },
      });

      const ledgerTx = await tx.ledgerTransaction.create({
        data: {
          type: "WITHDRAWAL_REVERSAL",
          asset,
          amount,
          idempotencyKey,
          referenceType: "WITHDRAWAL_REQUEST",
          referenceId: withdrawalRequestId,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          ledgerTxId: ledgerTx.id,
          userId,
          type: "WITHDRAWAL",
          amount, // positive = credit back
          asset,
          balanceAfter: balanceAfter.toString(),
          referenceType: "WITHDRAWAL_REQUEST",
          referenceId: withdrawalRequestId,
        },
      });

      return {
        ledgerTxId: ledgerTx.id,
        idempotencyKey,
        entries: [{ userId, amount, balanceAfter: balanceAfter.toString(), type: "WITHDRAWAL" }],
      };
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
   * For DEPOSIT, WITHDRAWAL, WITHDRAWAL_REVERSAL types, net-zero is not required
   * since they represent external inflows/outflows.
   */
  async validateLedgerTx(ledgerTxId: string): Promise<{ netSum: string; valid: boolean; type: string }> {
    const tx = await prisma.ledgerTransaction.findUnique({ where: { id: ledgerTxId } });
    const entries = await prisma.ledgerEntry.findMany({ where: { ledgerTxId } });
    let netSum = dec(0);
    for (const entry of entries) {
      netSum = netSum.add(dec(entry.amount.toString()));
    }

    // External flow types are exempt from net-zero
    const exemptTypes = ["DEPOSIT", "WITHDRAWAL", "WITHDRAWAL_REVERSAL"];
    const isExempt = tx ? exemptTypes.includes(tx.type) : false;

    return {
      netSum: netSum.toString(),
      valid: isExempt || netSum.abs().lte(dec("0.00000001")),
      type: tx?.type ?? "UNKNOWN",
    };
  },

  /**
   * Calculate fee in basis points. Exposed for UI display.
   */
  calcFee(amount: string, bps: number): string {
    return calcFee(amount, bps).toString();
  },
};
