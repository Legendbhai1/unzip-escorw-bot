import { prisma, Prisma } from "../lib/db.js";
import { treasuryService, HOUSE_USER_ID } from "./treasuryService.js";
import { logger } from "../lib/logger.js";

function dec(val: string | number): Prisma.Decimal {
  return new Prisma.Decimal(val);
}

export const reconciliationService = {
  /**
   * Validate ALL ledger transactions net to zero.
   * DEPOSIT, WITHDRAWAL, WITHDRAWAL_REVERSAL are exempt (external flows).
   * Returns violations for admin review.
   */
  async validateAllLedgerTransactions(): Promise<
    Array<{ id: string; type: string; netSum: string }>
  > {
    const allTx = await prisma.ledgerTransaction.findMany({
      select: { id: true, type: true },
    });

    const violations: Array<{ id: string; type: string; netSum: string }> = [];
    const exemptTypes = ["DEPOSIT", "WITHDRAWAL", "WITHDRAWAL_REVERSAL"];

    for (const tx of allTx) {
      const result = await treasuryService.validateLedgerTx(tx.id);
      if (!result.valid) {
        violations.push({ id: tx.id, type: tx.type, netSum: result.netSum });
      }
    }

    return violations;
  },

  /**
   * Reconcile user balances against ledger entries.
   * For each user/asset: sum of all ledger entries should equal
   * current available + locked.
   *
   * Does NOT silently repair. Returns discrepancies for admin review.
   */
  async reconcileUserBalances(): Promise<
    Array<{
      userId: string;
      asset: string;
      dbAvailable: string;
      dbLocked: string;
      ledgerTotal: string;
      diff: string;
    }>
  > {
    const balances = await prisma.balance.findMany();
    const discrepancies: Array<{
      userId: string; asset: string;
      dbAvailable: string; dbLocked: string;
      ledgerTotal: string; diff: string;
    }> = [];

    for (const bal of balances) {
      // Sum all ledger entries for this user/asset
      const entries = await prisma.ledgerEntry.findMany({
        where: { userId: bal.userId, asset: bal.asset },
        select: { amount: true },
      });

      let ledgerTotal = dec(0);
      for (const e of entries) {
        ledgerTotal = ledgerTotal.add(dec(e.amount.toString()));
      }

      const dbTotal = dec(bal.available.toString()).add(dec(bal.locked.toString()));
      const diff = dbTotal.sub(ledgerTotal);

      if (diff.abs().gt(dec("0.00000001"))) {
        discrepancies.push({
          userId: bal.userId,
          asset: bal.asset,
          dbAvailable: bal.available.toString(),
          dbLocked: bal.locked.toString(),
          ledgerTotal: ledgerTotal.toString(),
          diff: diff.toString(),
        });
      }
    }

    return discrepancies;
  },

  /**
   * Reconcile platform (house) fee balances.
   * Sum of all FEE entries should equal house available balance.
   */
  async reconcilePlatformFees(): Promise<
    Array<{ asset: string; houseBalance: string; feeTotal: string; diff: string }>
  > {
    // Get all unique assets
    const feeEntries = await prisma.ledgerEntry.findMany({
      where: { userId: HOUSE_USER_ID, type: "FEE" },
      select: { asset: true, amount: true },
    });

    const feeByAsset = new Map<string, Prisma.Decimal>();
    for (const e of feeEntries) {
      const current = feeByAsset.get(e.asset) ?? dec(0);
      feeByAsset.set(e.asset, current.add(dec(e.amount.toString())));
    }

    const discrepancies: Array<{ asset: string; houseBalance: string; feeTotal: string; diff: string }> = [];

    for (const [asset, feeTotal] of feeByAsset) {
      const houseBal = await prisma.balance.findUnique({
        where: { userId_asset: { userId: HOUSE_USER_ID, asset } },
      });

      const houseAvailable = houseBal ? dec(houseBal.available.toString()) : dec(0);
      const diff = houseAvailable.sub(feeTotal);

      if (diff.abs().gt(dec("0.00000001"))) {
        discrepancies.push({
          asset,
          houseBalance: houseAvailable.toString(),
          feeTotal: feeTotal.toString(),
          diff: diff.toString(),
        });
      }
    }

    return discrepancies;
  },

  /**
   * Run full reconciliation.
   * Logs all issues but does NOT repair.
   */
  async runFull(): Promise<{
    ledgerViolations: number;
    userBalanceDiscrepancies: number;
    platformFeeDiscrepancies: number;
    stuckWithdrawals: number;
  }> {
    logger.info("Running full reconciliation...");

    // 1. Ledger net-zero
    const ledgerViolations = await this.validateAllLedgerTransactions();
    for (const v of ledgerViolations) {
      logger.error({ ledgerTxId: v.id, type: v.type, netSum: v.netSum },
        "LEDGER NET-ZERO VIOLATION"
      );
    }

    // 2. User balance reconciliation
    const userDiscrepancies = await this.reconcileUserBalances();
    for (const d of userDiscrepancies) {
      logger.error(d, "USER BALANCE DISCREPANCY");
    }

    // 3. Platform fee reconciliation
    const feeDiscrepancies = await this.reconcilePlatformFees();
    for (const d of feeDiscrepancies) {
      logger.error(d, "PLATFORM FEE DISCREPANCY");
    }

    // 4. Stuck withdrawals
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

    const result = {
      ledgerViolations: ledgerViolations.length,
      userBalanceDiscrepancies: userDiscrepancies.length,
      platformFeeDiscrepancies: feeDiscrepancies.length,
      stuckWithdrawals: stuckWithdrawals.length,
    };

    logger.info(result, "Reconciliation complete");
    return result;
  },
};
