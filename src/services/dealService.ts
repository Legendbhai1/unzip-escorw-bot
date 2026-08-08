import { prisma, Prisma } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { canTransition, DISPUTABLE_STATES } from "../lib/stateMachine.js";
import { treasuryService } from "./treasuryService.js";
import type { DealStatus, DealCategory } from "@prisma/client";
import { randomUUID } from "node:crypto";

function generateInviteCode(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
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
        description: input.description,
        category: input.category,
        status: "CREATED",
      },
    });
  },

  // ── Join Deal (seller accepts) ────────────────────────────────
  async join(dealId: string, sellerUserId: string) {
    const deal = await prisma.deal.findUnique({ where: { id: dealId } });
    if (!deal) throw new Error("Deal not found");
    if (deal.status !== "CREATED") throw new Error(`Cannot join deal in ${deal.status} state`);
    if (deal.sellerId && deal.sellerId !== sellerUserId) {
      throw new Error("Deal already has a seller");
    }

    await prisma.deal.update({
      where: { id: dealId },
      data: { sellerId: sellerUserId, status: "JOINED" },
    });

    // Auto-advance to AWAITING_DEPOSIT
    await prisma.deal.update({
      where: { id: dealId },
      data: { status: "AWAITING_DEPOSIT" },
    });

    logger.info({ dealId, sellerUserId }, "Deal joined -> AWAITING_DEPOSIT");
  },

  // ── Transition State (central gate, row-locked) ────────────────
  async transition(
    dealId: string,
    targetStatus: DealStatus,
    triggeredBy: "BUYER" | "SELLER" | "SYSTEM" | "ADMIN"
  ) {
    // SELECT ... FOR UPDATE to serialize concurrent access
    const result = await prisma.$queryRaw<Array<{ id: string; status: DealStatus }>>(
      Prisma.sql`SELECT id, status FROM deals WHERE id = ${dealId} FOR UPDATE`
    );

    if (!result[0]) throw new Error("Deal not found");
    const current = result[0].status;

    const t = canTransition(current, targetStatus, triggeredBy);
    if (!t) {
      throw new Error(
        `Invalid transition: ${current} -> ${targetStatus} by ${triggeredBy}`
      );
    }

    const completedAt =
      targetStatus === "COMPLETED" || targetStatus === "REFUNDED" || targetStatus === "CANCELLED"
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

  // ── Fund Deal ──────────────────────────────────────────────────
  // Buyer must have sufficient available balance.
  // Locks funds via TreasuryService (double-entry).
  async fund(dealId: string) {
    const deal = await prisma.$queryRaw<Array<{
      id: string; status: DealStatus; buyer_id: string;
      amount: string; asset: string;
    }>>(
      Prisma.sql`SELECT id, status, buyer_id, amount, asset FROM deals WHERE id = ${dealId} FOR UPDATE`
    );

    if (!deal[0]) throw new Error("Deal not found");
    const d = deal[0];
    if (d.status !== "AWAITING_DEPOSIT") {
      throw new Error(`Deal not in AWAITING_DEPOSIT: ${d.status}`);
    }

    // Lock buyer's available -> locked via TreasuryService
    await treasuryService.escrowLock({
      userId: d.buyer_id,
      dealId: d.id,
      amount: d.amount,
      asset: d.asset,
    });

    // Transition: AWAITING_DEPOSIT -> FUNDED
    await prisma.deal.update({
      where: { id: dealId },
      data: { status: "FUNDED" },
    });

    logger.info({ dealId }, "Deal funded (balance locked via TreasuryService)");
  },

  // ── Release Funds (buyer confirms) ──────────────────────────────
  // Concurrency-safe: double-entry via TreasuryService with idempotency.
  async release(dealId: string) {
    const deal = await prisma.$queryRaw<Array<{
      id: string; status: DealStatus;
      buyer_id: string; seller_id: string | null;
      amount: string; asset: string; fee_rate: number;
    }>>(
      Prisma.sql`SELECT id, status, buyer_id, seller_id,
        amount, asset, fee_rate
        FROM deals WHERE id = ${dealId} FOR UPDATE`
    );

    if (!deal[0]) throw new Error("Deal not found");
    const d = deal[0];
    if (!d.seller_id) throw new Error("Deal has no seller");

    // State transitions
    await this.transition(dealId, "RELEASE_PENDING", "BUYER");

    // Release via TreasuryService (handles fee, double-entry, idempotency)
    await treasuryService.escrowRelease({
      buyerId: d.buyer_id,
      sellerId: d.seller_id,
      dealId: d.id,
      amount: d.amount,
      asset: d.asset,
      feeRate: Number(d.fee_rate),
    });

    await this.transition(dealId, "RELEASED", "SYSTEM");
    await this.transition(dealId, "COMPLETED", "SYSTEM");
  },

  // ── Dispute ──────────────────────────────────────────────────────
  async openDispute(dealId: string, openedByUserId: string, reason: string) {
    const deal = await prisma.deal.findUnique({ where: { id: dealId } });
    if (!deal) throw new Error("Deal not found");
    if (!DISPUTABLE_STATES.has(deal.status)) {
      throw new Error(`Cannot dispute deal in ${deal.status} state`);
    }

    const role = openedByUserId === deal.buyerId ? "BUYER" : "SELLER";
    await this.transition(dealId, "DISPUTED", role);

    return prisma.dispute.create({
      data: { dealId, openedBy: openedByUserId, reason },
    });
  },

  // ── Admin: Resolve Dispute ────────────────────────────────────
  async resolveDispute(
    dealId: string,
    adminUserId: string,
    resolution: "RELEASE_TO_SELLER" | "REFUND_BUYER",
    reason: string
  ) {
    const deal = await prisma.$queryRaw<Array<{
      id: string; status: DealStatus;
      buyer_id: string; seller_id: string | null;
      amount: string; asset: string; fee_rate: number;
    }>>(
      Prisma.sql`SELECT id, status, buyer_id, seller_id,
        amount, asset, fee_rate
        FROM deals WHERE id = ${dealId} FOR UPDATE`
    );

    if (!deal[0]) throw new Error("Deal not found");
    const d = deal[0];
    if (d.status !== "UNDER_REVIEW") throw new Error("Deal not under review");

    await this.transition(dealId, "UNDER_REVIEW", "ADMIN"); // no-op reconfirm

    if (resolution === "REFUND_BUYER") {
      await treasuryService.refund({
        userId: d.buyer_id,
        dealId: d.id,
        amount: d.amount,
        asset: d.asset,
      });
      await prisma.deal.update({
        where: { id: dealId },
        data: { status: "REFUNDED", completedAt: new Date() },
      });
    } else {
      if (!d.seller_id) throw new Error("Deal has no seller");
      await treasuryService.escrowRelease({
        buyerId: d.buyer_id,
        sellerId: d.seller_id,
        dealId: d.id,
        amount: d.amount,
        asset: d.asset,
        feeRate: Number(d.fee_rate),
      });
      await prisma.deal.update({
        where: { id: dealId },
        data: { status: "RELEASED", completedAt: new Date() },
      });
      await prisma.deal.update({
        where: { id: dealId },
        data: { status: "COMPLETED" },
      });
    }

    // Update dispute
    const dispute = await prisma.dispute.findUnique({ where: { dealId } });
    if (dispute) {
      await prisma.dispute.update({
        where: { id: dispute.id },
        data: {
          status: "RESOLVED",
          resolution,
          assignedAdmin: adminUserId,
          resolvedAt: new Date(),
        },
      });
    }

    await prisma.adminAction.create({
      data: {
        adminId: adminUserId,
        actionType: resolution === "REFUND_BUYER"
          ? "DISPUTE_RESOLVE_REFUND"
          : "DISPUTE_RESOLVE_RELEASE",
        dealId,
        reason,
      },
    });

    logger.info({ dealId, resolution, adminUserId }, "Dispute resolved");
  },

  // ── Cancel Deal (pre-funded only — no ledger touch) ──────────────
  async cancel(dealId: string, cancelledBy: string) {
    const deal = await prisma.$queryRaw<Array<{ id: string; status: DealStatus; buyer_id: string }>>(
      Prisma.sql`SELECT id, status, buyer_id as "buyerId" FROM deals WHERE id = ${dealId} FOR UPDATE`
    );
    if (!deal[0]) throw new Error("Deal not found");
    const d = deal[0];
    const role = cancelledBy === d.buyer_id ? "BUYER" : "SELLER";
    await this.transition(dealId, "CANCELLED", role);
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
        status: { in: ["CREATED", "JOINED", "AWAITING_DEPOSIT", "FUNDED", "IN_PROGRESS", "DELIVERED", "RELEASE_PENDING", "DISPUTED", "UNDER_REVIEW"] },
      },
      include: { buyer: true, seller: true },
      orderBy: { createdAt: "desc" },
    });
  },

  async getCompletedDealsForUser(userId: string) {
    return prisma.deal.findMany({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        status: { in: ["COMPLETED", "REFUNDED", "CANCELLED"] },
      },
      include: { buyer: true, seller: true },
      orderBy: { completedAt: "desc" },
      take: 50,
    });
  },
};