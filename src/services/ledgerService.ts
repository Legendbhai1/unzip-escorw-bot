import { prisma } from "../lib/db.js";
import { logger } from "../lib/logger.js";

/**
 * Ledger Service — READ-ONLY query layer.
 * All mutations are handled by dealService (atomic) or treasuryService (standalone).
 * This service exists for querying the immutable audit trail.
 */
export const ledgerService = {
  /**
   * Get all ledger entries for a user, ordered by time.
   */
  async getEntriesForUser(userId: string, limit = 50) {
    return prisma.ledgerEntry.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  },

  /**
   * Get all entries in a LedgerTransaction (the full double-entry group).
   */
  async getTransactionEntries(ledgerTxId: string) {
    return prisma.ledgerEntry.findMany({
      where: { ledgerTxId },
      orderBy: { id: "asc" },
    });
  },

  /**
   * Get all LedgerTransactions for a deal.
   */
  async getTransactionsForDeal(dealId: string) {
    return prisma.ledgerTransaction.findMany({
      where: { dealId },
      include: { entries: true },
      orderBy: { createdAt: "asc" },
    });
  },

  /**
   * Get LedgerTransactions by idempotency key.
   */
  async findByIdempotencyKey(idempotencyKey: string) {
    return prisma.ledgerTransaction.findUnique({
      where: { idempotencyKey },
      include: { entries: true },
    });
  },

  /**
   * Validate all ledger transactions net to zero.
   * Returns any that violate the invariant.
   */
  async findNetZeroViolations(): Promise<Array<{ id: string; type: string; netSum: string }>> {
    const allTx = await prisma.ledgerTransaction.findMany({
      select: { id: true, type: true },
    });

    const violations: Array<{ id: string; type: string; netSum: string }> = [];
    const exemptTypes = ["DEPOSIT", "WITHDRAWAL", "WITHDRAWAL_REVERSAL"];

    for (const tx of allTx) {
      const entries = await prisma.ledgerEntry.findMany({
        where: { ledgerTxId: tx.id },
        select: { amount: true },
      });

      let netSum = new (await import("@prisma/client")).Prisma.Decimal(0);
      for (const e of entries) {
        netSum = netSum.add(e.amount);
      }

      const isExempt = exemptTypes.includes(tx.type);
      if (!isExempt && netSum.abs().gt(new (await import("@prisma/client")).Prisma.Decimal("0.00000001"))) {
        violations.push({ id: tx.id, type: tx.type, netSum: netSum.toString() });
      }
    }

    return violations;
  },
};
