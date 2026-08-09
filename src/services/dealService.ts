import { prisma, Prisma } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { canTransition, DISPUTABLE_STATES, TERMINAL_STATES, EXPIRABLE_STATES, ACTIVE_STATES } from "../lib/stateMachine.js";
// Legacy custodial ledger helpers (used by fund/release/resolveDispute below,
// which are kept ONLY for historical rows and the ledger test suite. The
// manual escrow workflow never calls them — the bot has no custody of funds).
import { HOUSE_USER_ID } from "./treasuryService.js";
import { config } from "../config/index.js";
import type { DealStatus, DealCategory, PaymentMethod } from "@prisma/client";
import { randomUUID } from "node:crypto";

function generateInviteCode(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}

/**
 * Calculate fee from amount in basis points using integer-safe math.
 * fee = floor(amount * bps / 10000)
 */
function calcFeeBps(amount: string, bps: number): string {
  // Use Prisma.Decimal for precision
  const a = new Prisma.Decimal(amount);
  const fee = a.mul(new Prisma.Decimal(bps)).div(new Prisma.Decimal(10000));
  return fee.toString();
}

export const dealService = {
  // ── Create Deal ────────────────────────────────────────────────
  async create(input: {
    buyerUserId: string;
    sellerUserId: string | null;
    sellerUsername: string;
    amount: string;
    asset: string;
    network: string;
    paymentMethod: "INR" | "CRYPTO";
    currency?: string;
    description: string;
    category: DealCategory;
  }) {
    return prisma.deal.create({
      data: {
        inviteCode: generateInviteCode(),
        buyerId: input.buyerUserId,
        sellerId: input.sellerUserId,
        asset: input.asset,
        network: input.network,
        amount: input.amount,
        paymentMethod: input.paymentMethod as PaymentMethod,
        currency: input.currency ?? input.asset,
        buyerFeeBps: config.buyerFeeBps,
        sellerFeeBps: config.sellerFeeBps,
        description: input.description,
        category: input.category,
        status: "CREATED",
      },
    });
  },

  // ── Join Deal (seller accepts) ────────────────────────────────
  async join(dealId: string, sellerUserId: string) {
    const deal = await prisma.$queryRaw<Array<{
      id: string; status: DealStatus; buyer_id: string;
    }>>(
      Prisma.sql`SELECT id, status, buyer_id FROM deals WHERE id = ${dealId}::uuid FOR UPDATE`
    );

    if (!deal[0]) throw new Error("Deal not found");
    const d = deal[0];
    if (d.status !== "CREATED") throw new Error(`Cannot join deal in ${d.status} state`);

    await prisma.deal.update({
      where: { id: dealId },
      data: { sellerId: sellerUserId, status: "JOINED" },
    });

    // Both parties have joined -> the buyer pays the escrower MANUALLY and the
    // escrower verifies. The bot never holds funds, so there is no funding
    // step: we move straight to AWAITING_PAYMENT.
    const expiryMs = config.dealFundingExpiryMs;
    await prisma.deal.update({
      where: { id: dealId },
      data: {
        status: "AWAITING_PAYMENT",
        expiresAt: new Date(Date.now() + expiryMs),
      },
    });

    logger.info({ dealId, sellerUserId }, "Deal joined -> AWAITING_PAYMENT (manual verification)");
  },

  // ── Manual Payment Workflow (escrower-verified, no custody) ────

  /**
   * Lock a deal row FOR UPDATE inside a transaction.
   */
  async _lockDeal(tx: Prisma.TransactionClient, dealId: string) {
    const rows = await tx.$queryRaw<Array<any>>(
      Prisma.sql`SELECT id, status, buyer_id, seller_id, amount, asset, network,
        currency, payment_method, buyer_fee_bps, seller_fee_bps, buyer_fee_amount
        FROM deals WHERE id = ${dealId}::uuid FOR UPDATE`
    );
    if (!rows[0]) throw new Error("Deal not found");
    return rows[0];
  },

  /**
   * Buyer reports that they paid the escrower manually ("I've Paid").
   * Creates a PENDING PaymentReport + audit record. Deal -> PAYMENT_REPORTED.
   * This NEVER marks the deal funded — only the escrower's manual
   * verification (verifyPayment) can do that.
   */
  async reportPayment(
    dealId: string,
    buyerUserId: string,
    opts: { reference?: string; evidence?: string; notes?: string } = {}
  ) {
    return prisma.$transaction(async (tx) => {
      const d = await this._lockDeal(tx, dealId);
      if (d.buyer_id !== buyerUserId) throw new Error("Only the buyer can report payment");
      const t = canTransition(d.status, "PAYMENT_REPORTED", "BUYER");
      if (!t) throw new Error(`Cannot report payment from ${d.status}`);

      const report = await tx.paymentReport.create({
        data: {
          dealId,
          reportedBy: buyerUserId,
          paymentMethod: d.payment_method as PaymentMethod,
          amount: d.amount,
          reference: opts.reference ?? null,
          evidence: opts.evidence ?? null,
          notes: opts.notes ?? null,
          status: "PENDING",
        },
      });

      await tx.deal.update({
        where: { id: dealId },
        data: {
          status: "PAYMENT_REPORTED",
          paymentReportedAt: new Date(),
          paymentReportedBy: buyerUserId,
          ...(opts.reference ? { paymentReference: opts.reference } : {}),
          ...(opts.evidence ? { paymentEvidence: opts.evidence } : {}),
          ...(opts.notes ? { paymentNotes: opts.notes } : {}),
        },
      });

      await tx.escrowAuditLog.create({
        data: {
          dealId, action: "PAYMENT_REPORTED", userId: buyerUserId,
          amount: d.amount, currency: d.currency ?? d.asset,
          reference: opts.reference ?? null, notes: opts.notes ?? null,
        },
      });

      logger.info({ dealId, buyerUserId }, "Payment reported (awaiting escrower verification)");
      return report;
    });
  },

  /**
   * Escrower/admin rejects the payment report. Deal -> AWAITING_PAYMENT so the
   * buyer can re-report. The report stays as a REJECTED audit record.
   */
  async rejectPayment(dealId: string, adminUserId: string, reason: string) {
    return prisma.$transaction(async (tx) => {
      const d = await this._lockDeal(tx, dealId);
      const t = canTransition(d.status, "AWAITING_PAYMENT", "ADMIN");
      if (!t) throw new Error(`Cannot reject payment from ${d.status}`);

      const report = await tx.paymentReport.findFirst({
        where: { dealId, status: "PENDING" },
        orderBy: { createdAt: "desc" },
      });
      if (report) {
        await tx.paymentReport.update({
          where: { id: report.id },
          data: { status: "REJECTED", rejectedAt: new Date(), rejectionReason: reason },
        });
      }

      await tx.deal.update({
        where: { id: dealId },
        data: { status: "AWAITING_PAYMENT", paymentVerifiedAt: null, paymentVerifiedBy: null },
      });

      await tx.escrowAuditLog.create({
        data: { dealId, action: "PAYMENT_REJECTED", userId: adminUserId, notes: reason },
      });

      logger.warn({ dealId, adminUserId, reason }, "Payment report rejected");
    });
  },

  /**
   * Escrower/admin MANUALLY verifies the payment OUTSIDE the bot and marks the
   * deal FUNDED. This is the ONLY way a deal becomes FUNDED — the bot never
   * infers payment from blockchain events, screenshots, "I paid" or hashes.
   * Fees are computed and recorded as FEE_RECORDED audit entries; no balance
   * or ledger mutation happens (the bot has no custody).
   */
  async verifyPayment(dealId: string, adminUserId: string, reference?: string) {
    return prisma.$transaction(async (tx) => {
      const d = await this._lockDeal(tx, dealId);
      const t = canTransition(d.status, "FUNDED", "ADMIN");
      if (!t) throw new Error(`Cannot verify payment from ${d.status} (deal must be PAYMENT_REPORTED)`);

      const dealAmount = new Prisma.Decimal(d.amount);
      const buyerFee = dealAmount.mul(new Prisma.Decimal(d.buyer_fee_bps)).div(new Prisma.Decimal(10000));
      const totalPaid = dealAmount.add(buyerFee);

      const report = await tx.paymentReport.findFirst({
        where: { dealId, status: "PENDING" },
        orderBy: { createdAt: "desc" },
      });
      if (report) {
        await tx.paymentReport.update({
          where: { id: report.id },
          data: { status: "VERIFIED", verifiedBy: adminUserId, verifiedAt: new Date() },
        });
      }

      await tx.deal.update({
        where: { id: dealId },
        data: {
          status: "FUNDED",
          buyerFeeAmount: buyerFee,
          paymentVerifiedAt: new Date(),
          paymentVerifiedBy: adminUserId,
          ...(reference ? { paymentReference: reference } : {}),
        },
      });

      await tx.escrowAuditLog.create({
        data: {
          dealId, action: "PAYMENT_VERIFIED", userId: adminUserId,
          amount: dealAmount, currency: d.currency ?? d.asset,
          reference: reference ?? null, notes: "Escrower manually verified payment outside the bot",
        },
      });
      await tx.escrowAuditLog.create({
        data: {
          dealId, action: "FEE_RECORDED", userId: d.buyer_id,
          amount: buyerFee, currency: d.currency ?? d.asset,
          notes: `Buyer fee ${d.buyer_fee_bps} bps (${buyerFee.toString()})`,
        },
      });

      // Internal payment-history record only (no custody, no balance change).
      await tx.transaction.create({
        data: {
          userId: d.buyer_id, type: "ESCROW_LOCK", asset: d.asset,
          amount: totalPaid.toString(), status: "CONFIRMED", dealId,
        },
      });

      logger.info({ dealId, adminUserId, buyerFee: buyerFee.toString() }, "Payment manually verified -> FUNDED");
      return { dealId, buyerFee: buyerFee.toString(), totalPaid: totalPaid.toString() };
    });
  },

  /**
   * Buyer accepts delivery -> RELEASE_REQUESTED. The escrower then pays the
   * seller manually and confirms the release (confirmManualRelease).
   */
  async requestRelease(dealId: string, buyerUserId: string) {
    return prisma.$transaction(async (tx) => {
      const d = await this._lockDeal(tx, dealId);
      if (d.buyer_id !== buyerUserId) throw new Error("Only the buyer can accept delivery");
      const t = canTransition(d.status, "RELEASE_REQUESTED", "BUYER");
      if (!t) throw new Error(`Cannot request release from ${d.status}`);

      await tx.deal.update({
        where: { id: dealId },
        data: { status: "RELEASE_REQUESTED", releaseRequestedAt: new Date() },
      });

      await tx.escrowAuditLog.create({
        data: {
          dealId, action: "RELEASE_REQUESTED", userId: buyerUserId,
          amount: d.amount, currency: d.currency ?? d.asset,
          notes: "Buyer accepted delivery; escrower must pay seller manually",
        },
      });

      logger.info({ dealId, buyerUserId }, "Release requested (awaiting manual escrower payout)");
    });
  },

  /**
   * Escrower/admin confirms they manually paid the seller OUTSIDE the bot.
   * Deal -> COMPLETED. Records payout details + FEE_RECORDED. No ledger move.
   */
  async confirmManualRelease(dealId: string, adminUserId: string, reference?: string) {
    return prisma.$transaction(async (tx) => {
      const d = await this._lockDeal(tx, dealId);
      const t = canTransition(d.status, "COMPLETED", "ADMIN");
      if (!t) throw new Error(`Cannot mark released from ${d.status} (deal must be RELEASE_REQUESTED)`);

      const dealAmount = new Prisma.Decimal(d.amount);
      const sellerFee = dealAmount.mul(new Prisma.Decimal(d.seller_fee_bps)).div(new Prisma.Decimal(10000));
      const sellerPayout = dealAmount.sub(sellerFee);
      const buyerFee = new Prisma.Decimal(d.buyer_fee_amount ?? "0");
      const escrowFee = buyerFee.add(sellerFee);

      await tx.deal.update({
        where: { id: dealId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          releasedAt: new Date(),
          releasedBy: adminUserId,
          sellerFeeAmount: sellerFee,
          sellerPayoutAmount: sellerPayout,
          escrowFeeAmount: escrowFee,
          payoutMethod: d.payment_method as string,
          ...(reference ? { payoutReference: reference } : {}),
        },
      });

      await tx.escrowAuditLog.create({
        data: {
          dealId, action: "MANUAL_RELEASE_CONFIRMED", userId: adminUserId,
          amount: sellerPayout, currency: d.currency ?? d.asset,
          reference: reference ?? null,
          notes: "Escrower manually paid the seller outside the bot",
        },
      });
      await tx.escrowAuditLog.create({
        data: {
          dealId, action: "FEE_RECORDED", userId: d.seller_id ?? undefined,
          amount: sellerFee, currency: d.currency ?? d.asset,
          notes: `Seller fee ${d.seller_fee_bps} bps (${sellerFee.toString()})`,
        },
      });

      if (d.seller_id) {
        await tx.transaction.create({
          data: {
            userId: d.seller_id, type: "ESCROW_RELEASE", asset: d.asset,
            amount: sellerPayout.toString(), status: "CONFIRMED", dealId,
          },
        });
      }

      logger.info({ dealId, adminUserId, sellerPayout: sellerPayout.toString() }, "Manual release confirmed -> COMPLETED");
      return { dealId, sellerPayout: sellerPayout.toString(), sellerFee: sellerFee.toString(), escrowFee: escrowFee.toString() };
    });
  },

  /**
   * Admin resolves a dispute with a MANUAL REFUND (escrower refunds the buyer
   * outside the bot). Deal -> REFUNDED. Audit + history records only.
   */
  async manualRefund(dealId: string, adminUserId: string, reason: string, reference?: string) {
    return prisma.$transaction(async (tx) => {
      const d = await this._lockDeal(tx, dealId);
      const t = canTransition(d.status, "REFUNDED", "ADMIN");
      if (!t) throw new Error(`Cannot refund from ${d.status} (deal must be UNDER_REVIEW)`);

      await tx.deal.update({
        where: { id: dealId },
        data: {
          status: "REFUNDED",
          completedAt: new Date(),
          refundedAt: new Date(),
          refundedBy: adminUserId,
          ...(reference ? { refundReference: reference } : {}),
        },
      });

      await tx.escrowAuditLog.create({
        data: {
          dealId, action: "MANUAL_REFUND_CONFIRMED", userId: adminUserId,
          amount: d.amount, currency: d.currency ?? d.asset,
          reference: reference ?? null, notes: reason,
        },
      });

      await tx.transaction.create({
        data: {
          userId: d.buyer_id, type: "REFUND", asset: d.asset,
          amount: d.amount.toString(), status: "CONFIRMED", dealId,
        },
      });

      const dispute = await tx.dispute.findUnique({ where: { dealId } });
      if (dispute) {
        await tx.dispute.update({
          where: { id: dispute.id },
          data: { status: "RESOLVED", resolution: "REFUND_BUYER", assignedAdmin: adminUserId, resolvedAt: new Date() },
        });
      }
      await tx.adminAction.create({
        data: { adminId: adminUserId, actionType: "DISPUTE_RESOLVE_REFUND", dealId, reason },
      });

      logger.info({ dealId, adminUserId }, "Manual refund confirmed -> REFUNDED");
    });
  },

  /**
   * Admin resolves a dispute with a MANUAL RELEASE (escrower paid the seller
   * outside the bot). Deal -> RELEASED. Audit + history records only.
   */
  async manualReleaseForDispute(dealId: string, adminUserId: string, reason: string, reference?: string) {
    return prisma.$transaction(async (tx) => {
      const d = await this._lockDeal(tx, dealId);
      const t = canTransition(d.status, "RELEASED", "ADMIN");
      if (!t) throw new Error(`Cannot release from ${d.status} (deal must be UNDER_REVIEW)`);

      const dealAmount = new Prisma.Decimal(d.amount);
      const sellerFee = dealAmount.mul(new Prisma.Decimal(d.seller_fee_bps)).div(new Prisma.Decimal(10000));
      const sellerPayout = dealAmount.sub(sellerFee);
      const buyerFee = new Prisma.Decimal(d.buyer_fee_amount ?? "0");

      await tx.deal.update({
        where: { id: dealId },
        data: {
          status: "RELEASED",
          completedAt: new Date(),
          releasedAt: new Date(),
          releasedBy: adminUserId,
          sellerFeeAmount: sellerFee,
          sellerPayoutAmount: sellerPayout,
          escrowFeeAmount: buyerFee.add(sellerFee),
          payoutMethod: d.payment_method as string,
          ...(reference ? { payoutReference: reference } : {}),
        },
      });

      await tx.escrowAuditLog.create({
        data: {
          dealId, action: "MANUAL_RELEASE_CONFIRMED", userId: adminUserId,
          amount: sellerPayout, currency: d.currency ?? d.asset,
          reference: reference ?? null, notes: reason,
        },
      });
      await tx.escrowAuditLog.create({
        data: {
          dealId, action: "FEE_RECORDED", userId: d.seller_id ?? undefined,
          amount: sellerFee, currency: d.currency ?? d.asset,
          notes: `Seller fee ${d.seller_fee_bps} bps (${sellerFee.toString()})`,
        },
      });

      if (d.seller_id) {
        await tx.transaction.create({
          data: {
            userId: d.seller_id, type: "ESCROW_RELEASE", asset: d.asset,
            amount: sellerPayout.toString(), status: "CONFIRMED", dealId,
          },
        });
      }

      const dispute = await tx.dispute.findUnique({ where: { dealId } });
      if (dispute) {
        await tx.dispute.update({
          where: { id: dispute.id },
          data: { status: "RESOLVED", resolution: "RELEASE_TO_SELLER", assignedAdmin: adminUserId, resolvedAt: new Date() },
        });
      }
      await tx.adminAction.create({
        data: { adminId: adminUserId, actionType: "DISPUTE_RESOLVE_RELEASE", dealId, reason },
      });

      logger.info({ dealId, adminUserId }, "Manual dispute release confirmed -> RELEASED");
    });
  },

  // ── Transition State (central gate, row-locked) ────────────────
  async transition(
    dealId: string,
    targetStatus: DealStatus,
    triggeredBy: "BUYER" | "SELLER" | "SYSTEM" | "ADMIN"
  ) {
    // SELECT ... FOR UPDATE to serialize concurrent access
    const result = await prisma.$queryRaw<Array<{ id: string; status: DealStatus }>>(
      Prisma.sql`SELECT id, status FROM deals WHERE id = ${dealId}::uuid FOR UPDATE`
    );

    if (!result[0]) throw new Error("Deal not found");
    const current = result[0].status;

    const t = canTransition(current, targetStatus, triggeredBy);
    if (!t) {
      throw new Error(
        `Invalid transition: ${current} -> ${targetStatus} by ${triggeredBy}`
      );
    }

    const completedAt = TERMINAL_STATES.has(targetStatus)
      ? new Date()
      : undefined;

    const updated = await prisma.deal.update({
      where: { id: dealId },
      data: { status: targetStatus, ...(completedAt ? { completedAt } : {}) },
    });

    logger.info(
      { dealId, from: current, to: targetStatus, triggeredBy },
      "Deal state transitioned"
    );
    return updated;
  },

  // ── Fund Deal (atomic: lock + buyer fee + state transition) ─────
  /**
   * Buyer funds deal from AVAILABLE balance.
   * This is ATOMIC: ledger mutation + state transition in one DB transaction.
   * Buyer pays: deal_amount + buyer_fee (both debited from available).
   * deal_amount goes to locked. buyer_fee goes to platform.
   */
  async fund(dealId: string) {
    // Single DB transaction: read deal, execute ledger, update state
    return prisma.$transaction(async (tx) => {
      // 1. Lock and read deal
      const dealRows = await tx.$queryRaw<Array<{
        id: string; status: DealStatus; buyer_id: string;
        seller_id: string | null; amount: string; asset: string;
        buyer_fee_bps: number;
      }>>(
        Prisma.sql`SELECT id, status, buyer_id, seller_id, amount, asset, buyer_fee_bps
          FROM deals WHERE id = ${dealId}::uuid FOR UPDATE`
      );

      if (!dealRows[0]) throw new Error("Deal not found");
      const d = dealRows[0];
      if (d.status !== "AWAITING_FUNDING") {
        throw new Error(`Deal not in AWAITING_FUNDING: ${d.status}`);
      }

      // 2. Calculate fees
      const dealAmount = new Prisma.Decimal(d.amount);
      const buyerFeeBps = d.buyer_fee_bps;
      const buyerFee = dealAmount.mul(new Prisma.Decimal(buyerFeeBps)).div(new Prisma.Decimal(10000));
      const totalRequired = dealAmount.add(buyerFee);

      // 3. Read buyer balance with lock
      const balRows = await tx.$queryRaw<Array<{
        userId: string; asset: string; available: string; locked: string;
      }>>(
        Prisma.sql`SELECT user_id as "userId", asset, available, locked
          FROM balances WHERE user_id = ${d.buyer_id}::uuid AND asset = ${d.asset} FOR UPDATE`
      );

      const available = balRows.length > 0 ? new Prisma.Decimal(balRows[0].available) : new Prisma.Decimal(0);
      const locked = balRows.length > 0 ? new Prisma.Decimal(balRows[0].locked) : new Prisma.Decimal(0);

      if (available.lt(totalRequired)) {
        throw new Error(
          `INSUFFICIENT_BALANCE: need ${totalRequired} (amount ${dealAmount} + fee ${buyerFee}), have ${available} available`
        );
      }

      // 4. Mutate balances
      const newAvailable = available.sub(totalRequired);
      const newLocked = locked.add(dealAmount);

      await tx.balance.upsert({
        where: { userId_asset: { userId: d.buyer_id, asset: d.asset } },
        create: { userId: d.buyer_id, asset: d.asset, available: newAvailable, locked: newLocked },
        update: { available: newAvailable, locked: newLocked },
      });

      // Ensure house account has a balance row
      await tx.balance.upsert({
        where: { userId_asset: { userId: HOUSE_USER_ID, asset: d.asset } },
        create: { userId: HOUSE_USER_ID, asset: d.asset, available: new Prisma.Decimal(0), locked: new Prisma.Decimal(0) },
        update: {},
      });

      // Credit buyer fee to house
      await tx.balance.update({
        where: { userId_asset: { userId: HOUSE_USER_ID, asset: d.asset } },
        data: { available: { increment: buyerFee } },
      });

      // 5. Create LedgerTransaction
      const idempotencyKey = `fund:${dealId}`;
      const ledgerTx = await tx.ledgerTransaction.create({
        data: {
          type: "ESCROW_FUND",
          asset: d.asset,
          amount: d.amount,
          idempotencyKey,
          dealId: d.id,
          referenceType: "DEAL",
          referenceId: d.id,
        },
      });

      // Calculate balanceAfter for each entry
      const buyerBalAfter1 = newAvailable.add(newLocked); // after debit
      const buyerBalAfter2 = newAvailable.add(newLocked); // after credit to locked (same total)

      await tx.ledgerEntry.create({
        data: {
          ledgerTxId: ledgerTx.id, userId: d.buyer_id, dealId: d.id,
          type: "ESCROW_LOCK", amount: `-${totalRequired.toString()}`,
          asset: d.asset, balanceAfter: buyerBalAfter1.toString(),
          referenceType: "DEAL", referenceId: d.id,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          ledgerTxId: ledgerTx.id, userId: d.buyer_id, dealId: d.id,
          type: "ESCROW_LOCK", amount: dealAmount.toString(),
          asset: d.asset, balanceAfter: buyerBalAfter2.toString(),
          referenceType: "DEAL", referenceId: d.id,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          ledgerTxId: ledgerTx.id, userId: HOUSE_USER_ID,
          type: "FEE", amount: buyerFee.toString(),
          asset: d.asset,
          balanceAfter: buyerFee.toString(), // house only has this
          referenceType: "DEAL", referenceId: d.id,
        },
      });

      // 6. Update deal state ATOMICALLY
      await tx.deal.update({
        where: { id: dealId },
        data: {
          status: "FUNDED",
          buyerFeeAmount: buyerFee,
        },
      });

      // 7. User-facing transaction record
      await tx.transaction.create({
        data: {
          userId: d.buyer_id, type: "ESCROW_LOCK", asset: d.asset,
          amount: totalRequired.toString(), status: "CONFIRMED", dealId: d.id,
        },
      });

      logger.info(
        { dealId, buyerId: d.buyer_id, amount: d.amount, buyerFee: buyerFee.toString() },
        "Deal funded atomically (balance locked + fee collected)"
      );

      return { dealId, ledgerTxId: ledgerTx.id };
    });
  },

  // ── Release Funds (atomic: release + seller fee + state transition) ──
  /**
   * Buyer confirms release. ATOMIC: ledger + state in one DB transaction.
   *
   * Buyer's locked amount is debited.
   * Seller receives (amount - sellerFee).
   * Platform receives sellerFee.
   * Deal transitions RELEASE_PENDING -> COMPLETED.
   */
  async release(dealId: string) {
    return prisma.$transaction(async (tx) => {
      // 1. Lock and read deal
      const dealRows = await tx.$queryRaw<Array<{
        id: string; status: DealStatus;
        buyer_id: string; seller_id: string | null;
        amount: string; asset: string;
        seller_fee_bps: number;
      }>>(
        Prisma.sql`SELECT id, status, buyer_id, seller_id, amount, asset, seller_fee_bps
          FROM deals WHERE id = ${dealId}::uuid FOR UPDATE`
      );

      if (!dealRows[0]) throw new Error("Deal not found");
      const d = dealRows[0];
      if (!d.seller_id) throw new Error("Deal has no seller");
      if (d.status !== "DELIVERED") {
        throw new Error(`Cannot release from ${d.status}: must be DELIVERED`);
      }

      // Check idempotency
      const existingLedger = await tx.ledgerTransaction.findUnique({
        where: { idempotencyKey: `release:${dealId}` },
      });
      if (existingLedger) {
        throw new Error(`IDEMPOTENT_DUPLICATE:release:${dealId}`);
      }

      // 2. Calculate seller fee
      const dealAmount = new Prisma.Decimal(d.amount);
      const sellerFeeBps = d.seller_fee_bps;
      const sellerFee = dealAmount.mul(new Prisma.Decimal(sellerFeeBps)).div(new Prisma.Decimal(10000));
      const sellerReceives = dealAmount.sub(sellerFee);

      // 3. Read and lock balances for buyer and seller
      const userIds = [d.buyer_id, d.seller_id, HOUSE_USER_ID];
      const balRows = await tx.$queryRaw<Array<{
        userId: string; asset: string; available: string; locked: string;
      }>>(
        Prisma.sql`SELECT user_id as "userId", asset, available, locked
          FROM balances
          WHERE user_id = ANY(${userIds}::uuid[]) AND asset = ${d.asset}
          FOR UPDATE`
      );

      const balMap = new Map<string, { available: Prisma.Decimal; locked: Prisma.Decimal }>();
      for (const row of balRows) {
        balMap.set(row.userId, { available: new Prisma.Decimal(row.available), locked: new Prisma.Decimal(row.locked) });
      }

      const buyerBal = balMap.get(d.buyer_id) ?? { available: new Prisma.Decimal(0), locked: new Prisma.Decimal(0) };
      const sellerBal = balMap.get(d.seller_id) ?? { available: new Prisma.Decimal(0), locked: new Prisma.Decimal(0) };
      let houseBal = balMap.get(HOUSE_USER_ID) ?? { available: new Prisma.Decimal(0), locked: new Prisma.Decimal(0) };

      // 4. Validate buyer has enough locked
      if (buyerBal.locked.lt(dealAmount)) {
        throw new Error(`INSUFFICIENT_LOCKED: buyer has ${buyerBal.locked}, need ${dealAmount}`);
      }

      // 5. Mutate balances
      const newBuyerLocked = buyerBal.locked.sub(dealAmount);
      const newSellerAvailable = sellerBal.available.add(sellerReceives);
      const newHouseAvailable = houseBal.available.add(sellerFee);

      await tx.balance.upsert({
        where: { userId_asset: { userId: d.buyer_id, asset: d.asset } },
        create: { userId: d.buyer_id, asset: d.asset, available: buyerBal.available, locked: newBuyerLocked },
        update: { locked: newBuyerLocked },
      });
      await tx.balance.upsert({
        where: { userId_asset: { userId: d.seller_id, asset: d.asset } },
        create: { userId: d.seller_id, asset: d.asset, available: newSellerAvailable, locked: new Prisma.Decimal(0) },
        update: { available: newSellerAvailable },
      });
      await tx.balance.upsert({
        where: { userId_asset: { userId: HOUSE_USER_ID, asset: d.asset } },
        create: { userId: HOUSE_USER_ID, asset: d.asset, available: newHouseAvailable, locked: new Prisma.Decimal(0) },
        update: { available: newHouseAvailable },
      });

      // 6. Create LedgerTransaction
      const idempotencyKey = `release:${dealId}`;
      const ledgerTx = await tx.ledgerTransaction.create({
        data: {
          type: "ESCROW_RELEASE", asset: d.asset, amount: d.amount,
          idempotencyKey, dealId: d.id, referenceType: "DEAL", referenceId: d.id,
        },
      });

      const buyerBalAfter = buyerBal.available.add(newBuyerLocked);
      const sellerBalAfter = newSellerAvailable;
      const houseBalAfter = newHouseAvailable;

      await tx.ledgerEntry.create({
        data: {
          ledgerTxId: ledgerTx.id, userId: d.buyer_id, dealId: d.id,
          type: "ESCROW_RELEASE", amount: `-${d.amount}`,
          asset: d.asset, balanceAfter: buyerBalAfter.toString(),
          referenceType: "DEAL", referenceId: d.id,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          ledgerTxId: ledgerTx.id, userId: d.seller_id, dealId: d.id,
          type: "ESCROW_RELEASE", amount: sellerReceives.toString(),
          asset: d.asset, balanceAfter: sellerBalAfter.toString(),
          referenceType: "DEAL", referenceId: d.id,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          ledgerTxId: ledgerTx.id, userId: HOUSE_USER_ID,
          type: "FEE", amount: sellerFee.toString(),
          asset: d.asset, balanceAfter: houseBalAfter.toString(),
          referenceType: "DEAL", referenceId: d.id,
        },
      });

      // 7. Update deal state + seller fee
      await tx.deal.update({
        where: { id: dealId },
        data: {
          status: "COMPLETED",
          sellerFeeAmount: sellerFee,
          completedAt: new Date(),
        },
      });

      // 8. User-facing transaction records
      await tx.transaction.create({
        data: { userId: d.buyer_id, type: "ESCROW_RELEASE", asset: d.asset, amount: `-${d.amount}`, status: "CONFIRMED", dealId: d.id },
      });
      await tx.transaction.create({
        data: { userId: d.seller_id, type: "ESCROW_RELEASE", asset: d.asset, amount: sellerReceives.toString(), status: "CONFIRMED", dealId: d.id },
      });

      logger.info(
        { dealId, sellerReceives: sellerReceives.toString(), sellerFee: sellerFee.toString() },
        "Deal released atomically"
      );

      return { dealId, ledgerTxId: ledgerTx.id, sellerReceives: sellerReceives.toString(), sellerFee: sellerFee.toString() };
    });
  },

  // ── Dispute ──────────────────────────────────────────────────────
  async openDispute(dealId: string, openedByUserId: string, reason: string) {
    const deal = await prisma.$queryRaw<Array<{
      id: string; status: DealStatus; buyer_id: string;
    }>>(
      Prisma.sql`SELECT id, status, buyer_id FROM deals WHERE id = ${dealId}::uuid FOR UPDATE`
    );

    if (!deal[0]) throw new Error("Deal not found");
    const d = deal[0];
    if (!DISPUTABLE_STATES.has(d.status)) {
      throw new Error(`Cannot dispute deal in ${d.status} state`);
    }

    const role = openedByUserId === d.buyer_id ? "BUYER" : "SELLER";

    // Transition state
    await prisma.deal.update({
      where: { id: dealId },
      data: { status: "DISPUTED" },
    });

    return prisma.dispute.create({
      data: { dealId, openedBy: openedByUserId, reason },
    });
  },

  // ── Admin: Resolve Dispute (atomic) ────────────────────────────
  /**
   * Admin resolves a dispute. ATOMIC: ledger + state + dispute update.
   */
  async resolveDispute(
    dealId: string,
    adminUserId: string,
    resolution: "RELEASE_TO_SELLER" | "REFUND_BUYER",
    reason: string
  ) {
    return prisma.$transaction(async (tx) => {
      // 1. Lock and read deal
      const dealRows = await tx.$queryRaw<Array<{
        id: string; status: DealStatus;
        buyer_id: string; seller_id: string | null;
        amount: string; asset: string;
        buyer_fee_bps: number; seller_fee_bps: number;
        buyer_fee_amount: string;
      }>>(
        Prisma.sql`SELECT id, status, buyer_id, seller_id, amount, asset,
          buyer_fee_bps, seller_fee_bps, buyer_fee_amount
          FROM deals WHERE id = ${dealId}::uuid FOR UPDATE`
      );

      if (!dealRows[0]) throw new Error("Deal not found");
      const d = dealRows[0];
      if (d.status !== "UNDER_REVIEW") throw new Error(`Deal not under review: ${d.status}`);

      const dealAmount = new Prisma.Decimal(d.amount);
      const buyerFeeAmount = new Prisma.Decimal(d.buyer_fee_amount);

      if (resolution === "REFUND_BUYER") {
        // ── REFUND ──
        // Return escrow principal to buyer's available.
        // Optionally return buyer fee based on config.
        const refundBuyerFee = config.buyerFeeRefundOnRefund;

        // Check idempotency
        const existingLedger = await tx.ledgerTransaction.findUnique({
          where: { idempotencyKey: `refund:${dealId}` },
        });
        if (existingLedger) {
          throw new Error(`IDEMPOTENT_DUPLICATE:refund:${dealId}`);
        }

        // Read buyer balance with lock
        const balRows = await tx.$queryRaw<Array<{
          userId: string; asset: string; available: string; locked: string;
        }>>(
          Prisma.sql`SELECT user_id as "userId", asset, available, locked
            FROM balances
            WHERE (user_id = ${d.buyer_id}::uuid OR user_id = ${HOUSE_USER_ID}::uuid)
              AND asset = ${d.asset}
            FOR UPDATE`
        );

        const balMap = new Map<string, { available: Prisma.Decimal; locked: Prisma.Decimal }>();
        for (const row of balRows) {
          balMap.set(row.userId, { available: new Prisma.Decimal(row.available), locked: new Prisma.Decimal(row.locked) });
        }

        const buyerBal = balMap.get(d.buyer_id) ?? { available: new Prisma.Decimal(0), locked: new Prisma.Decimal(0) };
        let houseBal = balMap.get(HOUSE_USER_ID) ?? { available: new Prisma.Decimal(0), locked: new Prisma.Decimal(0) };

        if (buyerBal.locked.lt(dealAmount)) {
          throw new Error(`INSUFFICIENT_LOCKED: buyer has ${buyerBal.locked}, need ${dealAmount}`);
        }

        let newBuyerAvailable = buyerBal.available.add(dealAmount);
        const newBuyerLocked = buyerBal.locked.sub(dealAmount);
        let newHouseAvailable = houseBal.available;

        // Create ledger entries
        const idempotencyKey = `refund:${dealId}`;
        const ledgerTx = await tx.ledgerTransaction.create({
          data: {
            type: "REFUND", asset: d.asset, amount: d.amount,
            idempotencyKey, dealId: d.id, referenceType: "DEAL", referenceId: d.id,
          },
        });

        let buyerBalAfter = newBuyerAvailable.add(newBuyerLocked);

        // Debit locked, credit available
        await tx.ledgerEntry.create({
          data: {
            ledgerTxId: ledgerTx.id, userId: d.buyer_id, dealId: d.id,
            type: "REFUND", amount: `-${d.amount}`,
            asset: d.asset, balanceAfter: newBuyerLocked.add(buyerBal.available).toString(),
            referenceType: "DEAL", referenceId: d.id,
          },
        });
        await tx.ledgerEntry.create({
          data: {
            ledgerTxId: ledgerTx.id, userId: d.buyer_id, dealId: d.id,
            type: "REFUND", amount: d.amount,
            asset: d.asset, balanceAfter: buyerBalAfter.toString(),
            referenceType: "DEAL", referenceId: d.id,
          },
        });

        // If refunding buyer fee: debit from house, credit to buyer
        if (refundBuyerFee && buyerFeeAmount.gt(new Prisma.Decimal(0))) {
          if (houseBal.available.lt(buyerFeeAmount)) {
            logger.error({ houseAvailable: houseBal.available, buyerFee: buyerFeeAmount },
              "House account insufficient for fee refund — skipping fee refund");
          } else {
            newHouseAvailable = houseBal.available.sub(buyerFeeAmount);
            newBuyerAvailable = newBuyerAvailable.add(buyerFeeAmount);

            await tx.ledgerEntry.create({
              data: {
                ledgerTxId: ledgerTx.id, userId: HOUSE_USER_ID,
                type: "FEE", amount: `-${buyerFeeAmount.toString()}`,
                asset: d.asset, balanceAfter: newHouseAvailable.toString(),
                referenceType: "DEAL", referenceId: d.id,
              },
            });
            await tx.ledgerEntry.create({
              data: {
                ledgerTxId: ledgerTx.id, userId: d.buyer_id, dealId: d.id,
                type: "REFUND", amount: buyerFeeAmount.toString(),
                asset: d.asset, balanceAfter: newBuyerAvailable.add(newBuyerLocked).toString(),
                referenceType: "DEAL", referenceId: d.id,
              },
            });

            await tx.balance.update({
              where: { userId_asset: { userId: HOUSE_USER_ID, asset: d.asset } },
              data: { available: newHouseAvailable },
            });
          }
        }

        // Update buyer balance
        await tx.balance.upsert({
          where: { userId_asset: { userId: d.buyer_id, asset: d.asset } },
          create: { userId: d.buyer_id, asset: d.asset, available: newBuyerAvailable, locked: newBuyerLocked },
          update: { available: newBuyerAvailable, locked: newBuyerLocked },
        });

        // Transition deal state
        await tx.deal.update({
          where: { id: dealId },
          data: { status: "REFUNDED", completedAt: new Date() },
        });

        // Update dispute
        const dispute = await tx.dispute.findUnique({ where: { dealId } });
        if (dispute) {
          await tx.dispute.update({
            where: { id: dispute.id },
            data: { status: "RESOLVED", resolution: "REFUND_BUYER", assignedAdmin: adminUserId, resolvedAt: new Date() },
          });
        }

        // User-facing transaction
        await tx.transaction.create({
          data: { userId: d.buyer_id, type: "REFUND", asset: d.asset, amount: d.amount, status: "CONFIRMED", dealId: d.id },
        });

      } else {
        // ── RELEASE TO SELLER (admin forced) ──
        if (!d.seller_id) throw new Error("Deal has no seller");

        const sellerFeeBps = d.seller_fee_bps;
        const sellerFee = dealAmount.mul(new Prisma.Decimal(sellerFeeBps)).div(new Prisma.Decimal(10000));
        const sellerReceives = dealAmount.sub(sellerFee);

        // Check idempotency
        const existingLedger = await tx.ledgerTransaction.findUnique({
          where: { idempotencyKey: `release:${dealId}` },
        });
        if (existingLedger) {
          throw new Error(`IDEMPOTENT_DUPLICATE:release:${dealId}`);
        }

        // Read and lock balances
        const userIds = [d.buyer_id, d.seller_id, HOUSE_USER_ID];
        const balRows = await tx.$queryRaw<Array<{
          userId: string; asset: string; available: string; locked: string;
        }>>(
          Prisma.sql`SELECT user_id as "userId", asset, available, locked
            FROM balances
            WHERE user_id = ANY(${userIds}::uuid[]) AND asset = ${d.asset}
            FOR UPDATE`
        );

        const balMap = new Map<string, { available: Prisma.Decimal; locked: Prisma.Decimal }>();
        for (const row of balRows) {
          balMap.set(row.userId, { available: new Prisma.Decimal(row.available), locked: new Prisma.Decimal(row.locked) });
        }

        const buyerBal = balMap.get(d.buyer_id) ?? { available: new Prisma.Decimal(0), locked: new Prisma.Decimal(0) };
        const sellerBal = balMap.get(d.seller_id) ?? { available: new Prisma.Decimal(0), locked: new Prisma.Decimal(0) };
        const houseBal = balMap.get(HOUSE_USER_ID) ?? { available: new Prisma.Decimal(0), locked: new Prisma.Decimal(0) };

        if (buyerBal.locked.lt(dealAmount)) {
          throw new Error(`INSUFFICIENT_LOCKED: buyer has ${buyerBal.locked}, need ${dealAmount}`);
        }

        const newBuyerLocked = buyerBal.locked.sub(dealAmount);
        const newSellerAvailable = sellerBal.available.add(sellerReceives);
        const newHouseAvailable = houseBal.available.add(sellerFee);

        await tx.balance.upsert({
          where: { userId_asset: { userId: d.buyer_id, asset: d.asset } },
          create: { userId: d.buyer_id, asset: d.asset, available: buyerBal.available, locked: newBuyerLocked },
          update: { locked: newBuyerLocked },
        });
        await tx.balance.upsert({
          where: { userId_asset: { userId: d.seller_id, asset: d.asset } },
          create: { userId: d.seller_id, asset: d.asset, available: newSellerAvailable, locked: new Prisma.Decimal(0) },
          update: { available: newSellerAvailable },
        });
        await tx.balance.upsert({
          where: { userId_asset: { userId: HOUSE_USER_ID, asset: d.asset } },
          create: { userId: HOUSE_USER_ID, asset: d.asset, available: newHouseAvailable, locked: new Prisma.Decimal(0) },
          update: { available: newHouseAvailable },
        });

        const idempotencyKey = `release:${dealId}`;
        const ledgerTx = await tx.ledgerTransaction.create({
          data: {
            type: "ESCROW_RELEASE", asset: d.asset, amount: d.amount,
            idempotencyKey, dealId: d.id, referenceType: "DEAL", referenceId: d.id,
          },
        });

        await tx.ledgerEntry.create({
          data: {
            ledgerTxId: ledgerTx.id, userId: d.buyer_id, dealId: d.id,
            type: "ESCROW_RELEASE", amount: `-${d.amount}`,
            asset: d.asset, balanceAfter: buyerBal.available.add(newBuyerLocked).toString(),
            referenceType: "DEAL", referenceId: d.id,
          },
        });
        await tx.ledgerEntry.create({
          data: {
            ledgerTxId: ledgerTx.id, userId: d.seller_id, dealId: d.id,
            type: "ESCROW_RELEASE", amount: sellerReceives.toString(),
            asset: d.asset, balanceAfter: newSellerAvailable.toString(),
            referenceType: "DEAL", referenceId: d.id,
          },
        });
        await tx.ledgerEntry.create({
          data: {
            ledgerTxId: ledgerTx.id, userId: HOUSE_USER_ID,
            type: "FEE", amount: sellerFee.toString(),
            asset: d.asset, balanceAfter: newHouseAvailable.toString(),
            referenceType: "DEAL", referenceId: d.id,
          },
        });

        // Transition deal state to RELEASED (admin resolution)
        await tx.deal.update({
          where: { id: dealId },
          data: { status: "RELEASED", sellerFeeAmount: sellerFee, completedAt: new Date() },
        });

        const dispute = await tx.dispute.findUnique({ where: { dealId } });
        if (dispute) {
          await tx.dispute.update({
            where: { id: dispute.id },
            data: { status: "RESOLVED", resolution: "RELEASE_TO_SELLER", assignedAdmin: adminUserId, resolvedAt: new Date() },
          });
        }

        await tx.transaction.create({
          data: { userId: d.buyer_id, type: "ESCROW_RELEASE", asset: d.asset, amount: `-${d.amount}`, status: "CONFIRMED", dealId: d.id },
        });
        await tx.transaction.create({
          data: { userId: d.seller_id, type: "ESCROW_RELEASE", asset: d.asset, amount: sellerReceives.toString(), status: "CONFIRMED", dealId: d.id },
        });
      }

      // Audit trail
      await tx.adminAction.create({
        data: {
          adminId: adminUserId,
          actionType: resolution === "REFUND_BUYER" ? "DISPUTE_RESOLVE_REFUND" : "DISPUTE_RESOLVE_RELEASE",
          dealId, reason,
        },
      });

      logger.info({ dealId, resolution, adminUserId }, "Dispute resolved atomically");
    });
  },

  // ── Cancel Deal (pre-funded only — no ledger touch) ──────────────
  async cancel(dealId: string, cancelledBy: string) {
    const deal = await prisma.$queryRaw<Array<{
      id: string; status: DealStatus; buyer_id: string;
    }>>(
      Prisma.sql`SELECT id, status, buyer_id as "buyerId" FROM deals WHERE id = ${dealId}::uuid FOR UPDATE`
    );
    if (!deal[0]) throw new Error("Deal not found");
    const d = deal[0];
    const role = cancelledBy === (d as any).buyerId ? "BUYER" : "SELLER";

    const t = canTransition(d.status, "CANCELLED", role);
    if (!t) throw new Error(`Cannot cancel deal in ${d.status} state`);

    await prisma.deal.update({
      where: { id: dealId },
      data: { status: "CANCELLED", completedAt: new Date() },
    });

    logger.info({ dealId, cancelledBy }, "Deal cancelled");
  },

  // ── Expire Deals ────────────────────────────────────────────────
  /**
   * Find and expire deals that have passed their expiresAt.
   * Called by a periodic worker.
   */
  async expireDeals() {
    const now = new Date();
    const expiredDeals = await prisma.deal.findMany({
      where: {
        status: { in: ["CREATED", "JOINED", "AWAITING_PAYMENT", "AWAITING_FUNDING"] },
        expiresAt: { lt: now },
      },
    });

    for (const deal of expiredDeals) {
      try {
        await prisma.deal.update({
          where: { id: deal.id },
          data: { status: "EXPIRED", completedAt: now },
        });
        logger.info({ dealId: deal.id, oldStatus: deal.status }, "Deal expired");
      } catch (e) {
        logger.error({ dealId: deal.id, err: e }, "Failed to expire deal");
      }
    }

    return expiredDeals.length;
  },

  // ── Queries ──────────────────────────────────────────────────────
  async findByInviteCode(code: string) {
    return prisma.deal.findUnique({ where: { inviteCode: code } });
  },

  async findWithParties(dealId: string) {
    return prisma.deal.findUnique({
      where: { id: dealId },
      include: { buyer: true, seller: true, dispute: true },
    });
  },

  async getActiveDealsForUser(userId: string) {
    return prisma.deal.findMany({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        status: { in: [...ACTIVE_STATES] },
      },
      include: { buyer: true, seller: true },
      orderBy: { createdAt: "desc" },
    });
  },

  async getCompletedDealsForUser(userId: string) {
    return prisma.deal.findMany({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        status: { in: ["COMPLETED", "REFUNDED", "RELEASED", "CANCELLED", "EXPIRED"] },
      },
      include: { buyer: true, seller: true },
      orderBy: { completedAt: "desc" },
      take: 50,
    });
  },
};
