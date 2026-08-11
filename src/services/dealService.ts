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
import { parseDurationDeadline } from "../lib/dealTerms.js";

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
    cryptoPayer?: "BUYER" | "SELLER";
    description: string;
    category: DealCategory;
    // Deal terms (asked during creation; immutable once posted to the group)
    dealDuration?: string;
    dealDeadlineAt?: Date;
    releaseCondition?: string;
    refundCondition?: string;
  }) {
    const deal = await prisma.deal.create({
      data: {
        inviteCode: generateInviteCode(),
        buyerId: input.buyerUserId,
        sellerId: input.sellerUserId,
        asset: input.asset,
        network: input.network,
        amount: input.amount,
        paymentMethod: input.paymentMethod as PaymentMethod,
        cryptoPayer: input.cryptoPayer ?? (input.paymentMethod === "CRYPTO" ? "BUYER" : null),
        currency: input.currency ?? input.asset,
        buyerFeeBps: config.buyerFeeBps,
        sellerFeeBps: config.sellerFeeBps,
        description: input.description,
        category: input.category,
        status: "CREATED",
        remainingAmount: input.amount,
        dealDuration: input.dealDuration ?? null,
        // Informational deadline derived from the free-text duration when not
        // explicitly provided. Never auto-refunds/releases when it passes.
        dealDeadlineAt:
          input.dealDeadlineAt ??
          (input.dealDuration ? parseDurationDeadline(input.dealDuration) : null),
        releaseCondition: input.releaseCondition ?? null,
        refundCondition: input.refundCondition ?? null,
      },
    });

    try {
      await prisma.escrowAuditLog.create({
        data: {
          dealId: deal.id, action: "DEAL_CREATED", userId: input.buyerUserId,
          amount: input.amount, currency: input.currency ?? input.asset,
          notes: `Deal created (${input.paymentMethod}${input.cryptoPayer ? `, crypto payer ${input.cryptoPayer}` : ""})`,
        },
      });
    } catch (e) {
      logger.warn({ dealId: deal.id, err: e }, "Failed to record DEAL_CREATED audit");
    }

    return deal;
  },

  /**
   * The party who must pay the escrower: INR deals are always paid by the
   * buyer; USDT deals are paid by the configured crypto payer (cryptoPayer).
   * Handles both Prisma rows (camelCase) and raw rows (snake_case).
   */
  getPayerId(d: any): string {
    const buyerId = d.buyerId ?? d.buyer_id;
    const sellerId = d.sellerId ?? d.seller_id;
    const method = String(d.paymentMethod ?? d.payment_method ?? "").toUpperCase();
    const payer = String(d.cryptoPayer ?? d.crypto_payer ?? "").toUpperCase();
    if (method !== "INR" && payer === "SELLER") return sellerId ?? buyerId;
    return buyerId;
  },

  /**
   * Escrow admin accepts a created deal from the group card.
   * Deal -> AWAITING_PAYMENT. Records acceptedBy/acceptedAt and rejects
   * duplicate acceptance.
   */
  async adminAccept(dealId: string, adminUserId: string) {
    return prisma.$transaction(async (tx) => {
      const d = await this._lockDeal(tx, dealId);
      if (d.accepted_at) throw new Error("This deal has already been accepted");
      // Both parties must have agreed to the posted deal card before any admin
      // can accept it. Enforced here (server-side, row-locked), not just in UI.
      if (!d.buyer_agreed_at || !d.seller_agreed_at) {
        throw new Error("Both parties must agree to the deal before it can be accepted");
      }
      const t = canTransition(d.status, "AWAITING_PAYMENT", "ADMIN");
      if (!t) throw new Error(`Cannot accept deal from ${d.status}`);

      const expiryMs = config.dealFundingExpiryMs;
      await tx.deal.update({
        where: { id: dealId },
        data: {
          status: "AWAITING_PAYMENT",
          acceptedBy: adminUserId,
          acceptedAt: new Date(),
          expiresAt: new Date(Date.now() + expiryMs),
        },
      });

      await tx.escrowAuditLog.create({
        data: { dealId, action: "ADMIN_ACCEPTED", userId: adminUserId, notes: "Escrow admin accepted the deal from the group card" },
      });

      logger.info({ dealId, adminUserId }, "Deal accepted by admin -> AWAITING_PAYMENT");
      return { dealId };
    });
  },

  /**
   * A party agrees to the posted deal terms in the escrow group. The bot
   * identifies WHO clicked and records the agreement for that party only —
   * nobody can agree on someone else's behalf. Terms are immutable once
   * posted; if they ever changed, both parties would need to agree again.
   * Returns { agreedBy, bothAgreed }.
   */
  async agreeToDeal(dealId: string, userId: string) {
    return prisma.$transaction(async (tx) => {
      const d = await this._lockDeal(tx, dealId);
      if (d.status !== "CREATED") throw new Error(`Cannot agree to a deal in ${d.status} state`);
      if (!d.buyer_id || !d.seller_id) throw new Error("Deal is missing a party");

      const isBuyer = d.buyer_id === userId;
      const isSeller = d.seller_id === userId;
      if (!isBuyer && !isSeller) throw new Error("Only the buyer or seller can agree to this deal");

      if (isBuyer) {
        if (d.buyer_agreed_at) throw new Error("You have already agreed to this deal");
      } else if (d.seller_agreed_at) {
        throw new Error("You have already agreed to this deal");
      }

      await tx.deal.update({
        where: { id: dealId },
        data: isBuyer ? { buyerAgreedAt: new Date() } : { sellerAgreedAt: new Date() },
      });

      await tx.escrowAuditLog.create({
        data: {
          dealId,
          action: "DEAL_AGREED",
          userId,
          amount: d.amount,
          currency: d.currency ?? d.asset,
          notes: `${isBuyer ? "Buyer" : "Seller"} agreed to the posted deal terms`,
        },
      });

      const bothAgreed = Boolean(d.buyer_agreed_at || isBuyer) && Boolean(d.seller_agreed_at || isSeller);
      logger.info({ dealId, userId, bothAgreed }, "Party agreed to deal terms");
      return { agreedBy: isBuyer ? "BUYER" : "SELLER", bothAgreed };
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
        currency, payment_method, crypto_payer, buyer_fee_bps, seller_fee_bps,
        buyer_fee_amount, seller_fee_amount, accepted_at,
        buyer_agreed_at, seller_agreed_at,
        released_amount, refunded_amount, remaining_amount,
        release_requested_by, release_requested_amount, release_requested_from,
        release_agreed_by, release_agreed_at,
        refund_requested_by, refund_requested_amount, refund_requested_from,
        refund_agreed_by, refund_agreed_at
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
      // Only the party who must pay the escrower can report payment
      // (INR: buyer; USDT: the configured crypto payer).
      const payerId = this.getPayerId(d);
      if (payerId !== buyerUserId) throw new Error("Only the payer can report payment");
      const payerRole = payerId === d.buyer_id ? "BUYER" : "SELLER";
      const t = canTransition(d.status, "PAYMENT_REPORTED", payerRole);
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
   * A participant requests a release of the escrow (partial or full). The
   * counterparty must agree (agreeRelease) before the escrower can act.
   * Never releases anything automatically — the escrower pays manually.
   *
   * amount: optional partial amount ("50"). Omitted = the full remaining.
   */
  async requestRelease(dealId: string, userId: string, amount?: string) {
    return prisma.$transaction(async (tx) => {
      const d = await this._lockDeal(tx, dealId);
      if (d.buyer_id !== userId && d.seller_id !== userId) throw new Error("Only a participant can request release");
      const role = d.buyer_id === userId ? "BUYER" : "SELLER";
      const t = canTransition(d.status, "RELEASE_REQUESTED", role);
      if (!t) throw new Error(`Cannot request release from ${d.status}`);

      const dealAmount = new Prisma.Decimal(d.amount);
      const released = new Prisma.Decimal(d.released_amount ?? "0");
      const refunded = new Prisma.Decimal(d.refunded_amount ?? "0");
      const remaining = dealAmount.sub(released).sub(refunded);
      if (remaining.lte(0)) throw new Error("Nothing left to release");

      const reqAmount = amount ? new Prisma.Decimal(amount) : remaining;
      if (reqAmount.lte(0)) throw new Error("Release amount must be positive");
      if (reqAmount.gt(remaining)) throw new Error(`Release amount exceeds the remaining amount (${remaining.toString()})`);

      await tx.deal.update({
        where: { id: dealId },
        data: {
          status: "RELEASE_REQUESTED",
          releaseRequestedAt: new Date(),
          releaseRequestedBy: userId,
          releaseRequestedAmount: reqAmount,
          releaseRequestedFrom: d.status,
          releaseAgreedBy: null,
          releaseAgreedAt: null,
        },
      });

      await tx.escrowAuditLog.create({
        data: {
          dealId, action: "RELEASE_REQUESTED", userId,
          amount: reqAmount, currency: d.currency ?? d.asset,
          notes: amount
            ? `Release request (${reqAmount.toString()}) — awaiting counterparty agreement`
            : `Release request (all, ${reqAmount.toString()}) — awaiting counterparty agreement`,
        },
      });

      logger.info({ dealId, userId, amount: reqAmount.toString() }, "Release requested — awaiting counterparty agreement");
      return { requestedAmount: reqAmount.toString(), remaining: remaining.toString() };
    });
  },

  /**
   * The counterparty agrees to (or rejects) a pending release request.
   * Only after agreement is the escrower notified and able to complete it.
   */
  async agreeRelease(dealId: string, userId: string, agree: boolean) {
    return prisma.$transaction(async (tx) => {
      const d = await this._lockDeal(tx, dealId);
      if (d.status !== "RELEASE_REQUESTED") throw new Error(`Cannot respond from ${d.status}`);
      if (d.release_requested_by === userId) throw new Error("You cannot respond to your own release request");
      if (d.buyer_id !== userId && d.seller_id !== userId) throw new Error("Only a participant can respond");

      if (!agree) {
        const backTo = d.release_requested_from === "FUNDED" ? "FUNDED" : "DELIVERED";
        const t = canTransition("RELEASE_REQUESTED", backTo, "ADMIN");
        if (!t) throw new Error("Cannot reject this release request");
        await tx.deal.update({
          where: { id: dealId },
          data: {
            status: backTo,
            releaseRequestedBy: null,
            releaseRequestedAt: null,
            releaseRequestedAmount: null,
            releaseRequestedFrom: null,
            releaseAgreedBy: null,
            releaseAgreedAt: null,
          },
        });
        await tx.escrowAuditLog.create({
          data: { dealId, action: "RELEASE_REQUESTED", userId, notes: "Release request rejected by counterparty — deal continues" },
        });
        logger.info({ dealId, userId }, "Release request rejected");
        return { agreed: false };
      }

      await tx.deal.update({
        where: { id: dealId },
        data: { releaseAgreedBy: userId, releaseAgreedAt: new Date() },
      });
      await tx.escrowAuditLog.create({
        data: {
          dealId, action: "RELEASE_AGREED", userId,
          amount: d.release_requested_amount ?? d.amount,
          currency: d.currency ?? d.asset,
          notes: "Counterparty agreed to the release request",
        },
      });
      logger.info({ dealId, userId }, "Release request agreed");
      return { agreed: true };
    });
  },

  /**
   * Escrower/admin confirms they manually paid the seller OUTSIDE the bot.
   * Requires the counterparty's agreement. Supports partial releases: when
   * the remaining amount is not fully released the deal returns to its
   * previous state instead of completing.
   */
  async confirmManualRelease(dealId: string, adminUserId: string, reference?: string) {
    return prisma.$transaction(async (tx) => {
      const d = await this._lockDeal(tx, dealId);
      if (d.status !== "RELEASE_REQUESTED") throw new Error(`Cannot mark released from ${d.status} (deal must be RELEASE_REQUESTED)`);
      if (!d.release_agreed_at) throw new Error("The counterparty has not agreed to this release request yet");

      const dealAmount = new Prisma.Decimal(d.amount);
      const released = new Prisma.Decimal(d.released_amount ?? "0");
      const remaining = dealAmount.sub(released);
      const reqAmount = d.release_requested_amount ? new Prisma.Decimal(d.release_requested_amount) : remaining;
      if (reqAmount.lte(0) || reqAmount.gt(remaining)) {
        throw new Error(`Invalid release amount ${reqAmount.toString()} (remaining ${remaining.toString()})`);
      }

      const sellerFee = reqAmount.mul(new Prisma.Decimal(d.seller_fee_bps)).div(new Prisma.Decimal(10000));
      const sellerPayout = reqAmount.sub(sellerFee);
      const newReleased = released.add(reqAmount);
      const newRemaining = dealAmount.sub(newReleased);
      const buyerFee = new Prisma.Decimal(d.buyer_fee_amount ?? "0");
      const prevSellerFee = new Prisma.Decimal(d.seller_fee_amount ?? "0");
      const newSellerFee = prevSellerFee.add(sellerFee);

      const complete = newRemaining.lte(0);
      const nextStatus: DealStatus = complete ? "COMPLETED" : (d.release_requested_from === "FUNDED" ? "FUNDED" : "DELIVERED");
      const t = canTransition("RELEASE_REQUESTED", nextStatus, "ADMIN");
      if (!t) throw new Error(`Cannot complete release to ${nextStatus}`);

      await tx.deal.update({
        where: { id: dealId },
        data: {
          status: nextStatus,
          ...(complete ? { completedAt: new Date() } : {}),
          releasedAt: new Date(),
          releasedBy: adminUserId,
          releasedAmount: newReleased,
          remainingAmount: newRemaining,
          sellerFeeAmount: newSellerFee,
          sellerPayoutAmount: newReleased.sub(newSellerFee),
          escrowFeeAmount: buyerFee.add(newSellerFee),
          payoutMethod: d.payment_method as string,
          ...(reference ? { payoutReference: reference } : {}),
          releaseRequestedAt: null,
          releaseRequestedBy: null,
          releaseRequestedAmount: null,
          releaseRequestedFrom: null,
          releaseAgreedBy: null,
          releaseAgreedAt: null,
        },
      });

      await tx.escrowAuditLog.create({
        data: {
          dealId, action: "MANUAL_RELEASE_CONFIRMED", userId: adminUserId,
          amount: reqAmount, currency: d.currency ?? d.asset,
          reference: reference ?? null,
          notes: `Escrower manually paid the seller outside the bot (${reqAmount.toString()})`,
        },
      });
      await tx.escrowAuditLog.create({
        data: {
          dealId, action: "FEE_RECORDED", userId: d.seller_id ?? undefined,
          amount: sellerFee, currency: d.currency ?? d.asset,
          notes: `Seller fee ${d.seller_fee_bps} bps on released ${reqAmount.toString()} (${sellerFee.toString()})`,
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

      logger.info({ dealId, adminUserId, sellerPayout: sellerPayout.toString(), complete }, "Manual release confirmed");
      return {
        dealId,
        sellerPayout: sellerPayout.toString(),
        sellerFee: sellerFee.toString(),
        escrowFee: buyerFee.add(newSellerFee).toString(),
      };
    });
  },

  /**
   * A participant requests a refund (partial or full). The counterparty must
   * agree (agreeRefund) before the escrower refunds the buyer manually.
   */
  async requestRefund(dealId: string, userId: string, amount?: string) {
    return prisma.$transaction(async (tx) => {
      const d = await this._lockDeal(tx, dealId);
      if (d.buyer_id !== userId && d.seller_id !== userId) throw new Error("Only a participant can request a refund");
      const role = d.buyer_id === userId ? "BUYER" : "SELLER";
      const t = canTransition(d.status, "REFUND_REQUESTED", role);
      if (!t) throw new Error(`Cannot request refund from ${d.status}`);

      const dealAmount = new Prisma.Decimal(d.amount);
      const released = new Prisma.Decimal(d.released_amount ?? "0");
      const refunded = new Prisma.Decimal(d.refunded_amount ?? "0");
      const remaining = dealAmount.sub(released).sub(refunded);
      if (remaining.lte(0)) throw new Error("Nothing left to refund");

      const reqAmount = amount ? new Prisma.Decimal(amount) : remaining;
      if (reqAmount.lte(0)) throw new Error("Refund amount must be positive");
      if (reqAmount.gt(remaining)) throw new Error(`Refund amount exceeds the remaining amount (${remaining.toString()})`);

      await tx.deal.update({
        where: { id: dealId },
        data: {
          status: "REFUND_REQUESTED",
          refundRequestedAt: new Date(),
          refundRequestedBy: userId,
          refundRequestedAmount: reqAmount,
          refundRequestedFrom: d.status,
          refundAgreedBy: null,
          refundAgreedAt: null,
        },
      });

      await tx.escrowAuditLog.create({
        data: {
          dealId, action: "REFUND_REQUESTED", userId,
          amount: reqAmount, currency: d.currency ?? d.asset,
          notes: amount
            ? `Refund request (${reqAmount.toString()}) — awaiting counterparty agreement`
            : `Refund request (all, ${reqAmount.toString()}) — awaiting counterparty agreement`,
        },
      });

      logger.info({ dealId, userId, amount: reqAmount.toString() }, "Refund requested — awaiting counterparty agreement");
      return { requestedAmount: reqAmount.toString(), remaining: remaining.toString() };
    });
  },

  /**
   * The counterparty agrees to (or rejects) a pending refund request.
   */
  async agreeRefund(dealId: string, userId: string, agree: boolean) {
    return prisma.$transaction(async (tx) => {
      const d = await this._lockDeal(tx, dealId);
      if (d.status !== "REFUND_REQUESTED") throw new Error(`Cannot respond from ${d.status}`);
      if (d.refund_requested_by === userId) throw new Error("You cannot respond to your own refund request");
      if (d.buyer_id !== userId && d.seller_id !== userId) throw new Error("Only a participant can respond");

      if (!agree) {
        const backTo = d.refund_requested_from === "DELIVERED" ? "DELIVERED" : "FUNDED";
        const t = canTransition("REFUND_REQUESTED", backTo, "ADMIN");
        if (!t) throw new Error("Cannot reject this refund request");
        await tx.deal.update({
          where: { id: dealId },
          data: {
            status: backTo,
            refundRequestedBy: null,
            refundRequestedAt: null,
            refundRequestedAmount: null,
            refundRequestedFrom: null,
            refundAgreedBy: null,
            refundAgreedAt: null,
          },
        });
        await tx.escrowAuditLog.create({
          data: { dealId, action: "REFUND_REQUESTED", userId, notes: "Refund request rejected by counterparty — deal continues" },
        });
        logger.info({ dealId, userId }, "Refund request rejected");
        return { agreed: false };
      }

      await tx.deal.update({
        where: { id: dealId },
        data: { refundAgreedBy: userId, refundAgreedAt: new Date() },
      });
      await tx.escrowAuditLog.create({
        data: {
          dealId, action: "REFUND_AGREED", userId,
          amount: d.refund_requested_amount ?? d.amount,
          currency: d.currency ?? d.asset,
          notes: "Counterparty agreed to the refund request",
        },
      });
      logger.info({ dealId, userId }, "Refund request agreed");
      return { agreed: true };
    });
  },

  /**
   * Escrower/admin confirms they manually refunded the buyer OUTSIDE the bot.
   * Requires the counterparty's agreement. Supports partial refunds: the deal
   * returns to its previous state while the remaining amount is > 0.
   */
  async completeManualRefund(dealId: string, adminUserId: string, reference?: string) {
    return prisma.$transaction(async (tx) => {
      const d = await this._lockDeal(tx, dealId);
      if (d.status !== "REFUND_REQUESTED") throw new Error(`Cannot mark refunded from ${d.status} (deal must be REFUND_REQUESTED)`);
      if (!d.refund_agreed_at) throw new Error("The counterparty has not agreed to this refund request yet");

      const dealAmount = new Prisma.Decimal(d.amount);
      const released = new Prisma.Decimal(d.released_amount ?? "0");
      const refunded = new Prisma.Decimal(d.refunded_amount ?? "0");
      const remaining = dealAmount.sub(released).sub(refunded);
      const reqAmount = d.refund_requested_amount ? new Prisma.Decimal(d.refund_requested_amount) : remaining;
      if (reqAmount.lte(0) || reqAmount.gt(remaining)) {
        throw new Error(`Invalid refund amount ${reqAmount.toString()} (remaining ${remaining.toString()})`);
      }

      const newRefunded = refunded.add(reqAmount);
      const newRemaining = dealAmount.sub(released).sub(newRefunded);
      const complete = newRemaining.lte(0);
      const nextStatus: DealStatus = complete ? "REFUNDED" : (d.refund_requested_from === "DELIVERED" ? "DELIVERED" : "FUNDED");
      const t = canTransition("REFUND_REQUESTED", nextStatus, "ADMIN");
      if (!t) throw new Error(`Cannot complete refund to ${nextStatus}`);

      await tx.deal.update({
        where: { id: dealId },
        data: {
          status: nextStatus,
          ...(complete ? { completedAt: new Date() } : {}),
          refundedAt: new Date(),
          refundedBy: adminUserId,
          refundedAmount: newRefunded,
          remainingAmount: newRemaining,
          ...(reference ? { refundReference: reference } : {}),
          refundRequestedAt: null,
          refundRequestedBy: null,
          refundRequestedAmount: null,
          refundRequestedFrom: null,
          refundAgreedBy: null,
          refundAgreedAt: null,
        },
      });

      await tx.escrowAuditLog.create({
        data: {
          dealId, action: "MANUAL_REFUND_CONFIRMED", userId: adminUserId,
          amount: reqAmount, currency: d.currency ?? d.asset,
          reference: reference ?? null,
          notes: `Escrower manually refunded the buyer outside the bot (${reqAmount.toString()})`,
        },
      });
      await tx.transaction.create({
        data: {
          userId: d.buyer_id, type: "REFUND", asset: d.asset,
          amount: reqAmount.toString(), status: "CONFIRMED", dealId,
        },
      });

      logger.info({ dealId, adminUserId, amount: reqAmount.toString(), complete }, "Manual refund confirmed");
      return { dealId, refundAmount: reqAmount.toString(), complete };
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
      id: string; status: DealStatus; buyer_id: string; seller_id: string | null;
    }>>(
      Prisma.sql`SELECT id, status, buyer_id as "buyerId", seller_id as "sellerId" FROM deals WHERE id = ${dealId}::uuid FOR UPDATE`
    );
    if (!deal[0]) throw new Error("Deal not found");
    const d = deal[0] as any;
    const role = cancelledBy === d.buyerId ? "BUYER" : cancelledBy === d.sellerId ? "SELLER" : "ADMIN";

    const t = canTransition(d.status, "CANCELLED", role);
    if (!t) throw new Error(`Cannot cancel deal in ${d.status} state`);

    await prisma.deal.update({
      where: { id: dealId },
      data: { status: "CANCELLED", completedAt: new Date() },
    });

    logger.info({ dealId, cancelledBy, role }, "Deal cancelled");
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
