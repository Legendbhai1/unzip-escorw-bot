import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient, Prisma } from "@prisma/client";
import { dealService } from "../src/services/dealService.js";
import { userService } from "../src/services/userService.js";
import { canTransition, DISPUTABLE_STATES, TERMINAL_STATES, ACTIVE_STATES } from "../src/lib/stateMachine.js";
import { getPaymentInstructionsText } from "../src/lib/paymentInstructions.js";
import { config } from "../src/config/index.js";

const prisma = new PrismaClient();

const BUYER_ID = "44444444-4444-4444-4444-444444444444";
const SELLER_ID = "55555555-5555-5555-5555-555555555555";
const ADMIN_ID = "66666666-6666-6666-6666-666666666666";

async function cleanAll() {
  await prisma.adminAction.deleteMany();
  await prisma.disputeEvidence.deleteMany();
  await prisma.dispute.deleteMany();
  await prisma.escrowAuditLog.deleteMany();
  await prisma.paymentReport.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.ledgerTransaction.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.withdrawalRequest.deleteMany();
  await prisma.blockchainDeposit.deleteMany();
  await prisma.depositAddress.deleteMany();
  await prisma.balance.deleteMany();
  await prisma.deal.deleteMany();
  await prisma.user.deleteMany();
}

async function createUser(id: string, username: string, telegramId: string) {
  await prisma.user.upsert({
    where: { id },
    create: { id, telegramId: BigInt(telegramId), username, firstName: "ManualTest", status: "ACTIVE" },
    update: {},
  });
}

/** Create a deal via the real dealService (the canonical path). */
async function createDeal(method: "INR" | "CRYPTO", amount = "10000") {
  const isInr = method === "INR";
  return dealService.create({
    buyerUserId: BUYER_ID,
    sellerUserId: null,
    sellerUsername: "seller_user",
    amount,
    asset: isInr ? "INR" : "USDT",
    network: isInr ? "UPI" : "TRC20",
    paymentMethod: method,
    currency: isInr ? "INR" : "USDT",
    description: "Manual escrow test deal",
    category: "FREELANCE_SERVICES",
  });
}

async function toAwaitingPayment(dealId: string) {
  await dealService.join(dealId, SELLER_ID);
}

beforeAll(async () => {
  await cleanAll();
  await createUser(BUYER_ID, "buyer_user", "440000000000000001");
  await createUser(SELLER_ID, "seller_user", "550000000000000001");
  await createUser(ADMIN_ID, "admin_user", "660000000000000001");
});

afterAll(async () => {
  await cleanAll();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await cleanAll();
  await createUser(BUYER_ID, "buyer_user", "440000000000000001");
  await createUser(SELLER_ID, "seller_user", "550000000000000001");
  await createUser(ADMIN_ID, "admin_user", "660000000000000001");
});

// ═══════════════════════════════════════════════════════════════════
// DEAL CREATION
// ═══════════════════════════════════════════════════════════════════

describe("Manual deal creation", () => {
  it("creates an INR deal (paymentMethod=INR, currency=INR, asset=INR, network=UPI)", async () => {
    const deal = await createDeal("INR");
    expect(deal.paymentMethod).toBe("INR");
    expect(deal.currency).toBe("INR");
    expect(deal.asset).toBe("INR");
    expect(deal.network).toBe("UPI");
    expect(deal.status).toBe("CREATED");
    expect(deal.buyerFeeBps).toBe(100);
    expect(deal.sellerFeeBps).toBe(100);
  });

  it("creates a crypto deal (paymentMethod=CRYPTO, USDT/TRC20 denomination)", async () => {
    const deal = await createDeal("CRYPTO", "100");
    expect(deal.paymentMethod).toBe("CRYPTO");
    expect(deal.currency).toBe("USDT");
    expect(deal.asset).toBe("USDT");
    expect(deal.network).toBe("TRC20");
  });

  it("counterparty lookup normalizes @ + case-insensitive", async () => {
    const a = await userService.findByUsername("@SELLER_USER");
    expect(a?.id).toBe(SELLER_ID);
    const b = await userService.findByUsername("  seller_user ");
    expect(b?.id).toBe(SELLER_ID);
    const c = await userService.findByUsername("no_such_user_xyz");
    expect(c).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// PAYMENT INSTRUCTIONS (config-backed, never generated)
// ═══════════════════════════════════════════════════════════════════

describe("Payment instructions", () => {
  it("returns configured UPI details for INR deals", () => {
    const text = getPaymentInstructionsText({ asset: "INR", network: "UPI", paymentMethod: "INR" });
    if (config.escrow.upiId) {
      expect(text).toContain("UPI ID");
      expect(text).not.toContain("unavailable");
    } else {
      expect(text).toContain("unavailable");
    }
  });

  it("returns configured escrower crypto address for USDT_TRC20", () => {
    const text = getPaymentInstructionsText({ asset: "USDT", network: "TRC20", paymentMethod: "CRYPTO" });
    if (config.escrow.cryptoAddresses["USDT_TRC20"]) {
      expect(text).toContain(config.escrow.cryptoAddresses["USDT_TRC20"]);
    } else {
      expect(text).toContain("unavailable");
    }
  });

  it("never fabricates an address: unknown denomination -> unavailable", () => {
    const text = getPaymentInstructionsText({ asset: "BTC", network: "LIGHTNING", paymentMethod: "CRYPTO" });
    expect(text).toBe("Payment instructions are currently unavailable. Please contact the escrower.");
  });

  it("INR with unconfigured UPI -> unavailable (no fabricated data)", () => {
    const saved = (config as any).escrow;
    (config as any).escrow = { upiId: "", upiName: "", cryptoAddresses: {} };
    try {
      const text = getPaymentInstructionsText({ asset: "INR", network: "UPI", paymentMethod: "INR" });
      expect(text).toBe("Payment instructions are currently unavailable. Please contact the escrower.");
    } finally {
      (config as any).escrow = saved;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// FULL MANUAL FLOW
// ═══════════════════════════════════════════════════════════════════

describe("Manual escrow full flow (INR)", () => {
  it("accept -> AWAITING_PAYMENT; I've Paid -> PAYMENT_REPORTED (NOT funded)", async () => {
    const deal = await createDeal("INR", "10000");
    await toAwaitingPayment(deal.id);
    expect((await prisma.deal.findUnique({ where: { id: deal.id } }))?.status).toBe("AWAITING_PAYMENT");

    await dealService.reportPayment(deal.id, BUYER_ID, { reference: "UPI-REF-123", notes: "paid via GPay" });

    const updated = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(updated?.status).toBe("PAYMENT_REPORTED"); // NOT FUNDED
    expect(updated?.paymentReportedBy).toBe(BUYER_ID);
    expect(updated?.paymentReference).toBe("UPI-REF-123");
    expect(updated?.paymentVerifiedAt).toBeNull();

    const report = await prisma.paymentReport.findFirst({ where: { dealId: deal.id } });
    expect(report?.status).toBe("PENDING");
    expect(report?.reportedBy).toBe(BUYER_ID);
    expect(report?.paymentMethod).toBe("INR");
    expect(report?.reference).toBe("UPI-REF-123");

    const audit = await prisma.escrowAuditLog.findFirst({ where: { dealId: deal.id, action: "PAYMENT_REPORTED" } });
    expect(audit).not.toBeNull();
    expect(parseFloat(audit!.amount!.toString())).toBe(10000);
    expect(audit!.currency).toBe("INR");
  });

  it("only the ADMIN can verify payment -> FUNDED (buyer cannot)", async () => {
    const deal = await createDeal("INR", "10000");
    await toAwaitingPayment(deal.id);
    await dealService.reportPayment(deal.id, BUYER_ID, { reference: "REF-X" });

    // Buyer / seller cannot trigger verification.
    expect(canTransition("PAYMENT_REPORTED", "FUNDED", "BUYER")).toBeNull();
    expect(canTransition("PAYMENT_REPORTED", "FUNDED", "SELLER")).toBeNull();
    expect(canTransition("PAYMENT_REPORTED", "FUNDED", "ADMIN")).not.toBeNull();

    const result = await dealService.verifyPayment(deal.id, ADMIN_ID);

    const updated = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(updated?.status).toBe("FUNDED");
    expect(updated?.paymentVerifiedBy).toBe(ADMIN_ID);
    expect(updated?.paymentVerifiedAt).not.toBeNull();
    expect(parseFloat(updated!.buyerFeeAmount.toString())).toBe(100); // 1% of 10,000 INR

    // Buyer total paid = 10,000 + 100 = 10,100
    expect(parseFloat(result.totalPaid)).toBe(10100);

    const report = await prisma.paymentReport.findFirst({ where: { dealId: deal.id } });
    expect(report?.status).toBe("VERIFIED");
    expect(report?.verifiedBy).toBe(ADMIN_ID);

    const feeAudit = await prisma.escrowAuditLog.findFirst({ where: { dealId: deal.id, action: "FEE_RECORDED" } });
    expect(feeAudit).not.toBeNull();
    expect(parseFloat(feeAudit!.amount!.toString())).toBe(100);

    // No custody: no Balance row should exist for the buyer.
    const bal = await prisma.balance.findFirst({ where: { userId: BUYER_ID } });
    expect(bal).toBeNull();
  });

  it("rejecting a payment returns the deal to AWAITING_PAYMENT and marks the report REJECTED", async () => {
    const deal = await createDeal("INR", "5000");
    await toAwaitingPayment(deal.id);
    await dealService.reportPayment(deal.id, BUYER_ID, { reference: "REF-Y" });

    await dealService.rejectPayment(deal.id, ADMIN_ID, "Payment not received");

    const updated = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(updated?.status).toBe("AWAITING_PAYMENT");

    const report = await prisma.paymentReport.findFirst({ where: { dealId: deal.id } });
    expect(report?.status).toBe("REJECTED");
    expect(report?.rejectionReason).toBe("Payment not received");

    const audit = await prisma.escrowAuditLog.findFirst({ where: { dealId: deal.id, action: "PAYMENT_REJECTED" } });
    expect(audit).not.toBeNull();

    // Buyer can re-report after rejection.
    await dealService.reportPayment(deal.id, BUYER_ID, { reference: "REF-Y2" });
    expect((await prisma.deal.findUnique({ where: { id: deal.id } }))?.status).toBe("PAYMENT_REPORTED");
  });

  it("deliver -> accept -> RELEASE_REQUESTED -> admin manual release -> COMPLETED", async () => {
    const deal = await createDeal("INR", "10000");
    await toAwaitingPayment(deal.id);
    await dealService.reportPayment(deal.id, BUYER_ID, { reference: "REF-Z" });
    await dealService.verifyPayment(deal.id, ADMIN_ID);

    await dealService.transition(deal.id, "DELIVERED", "SELLER");
    expect((await prisma.deal.findUnique({ where: { id: deal.id } }))?.status).toBe("DELIVERED");

    await dealService.requestRelease(deal.id, BUYER_ID);
    const afterAccept = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(afterAccept?.status).toBe("RELEASE_REQUESTED"); // NOT completed/paid automatically
    expect(afterAccept?.releaseRequestedAt).not.toBeNull();

    const releaseAudit = await prisma.escrowAuditLog.findFirst({ where: { dealId: deal.id, action: "RELEASE_REQUESTED" } });
    expect(releaseAudit).not.toBeNull();

    const result = await dealService.confirmManualRelease(deal.id, ADMIN_ID, "PAYOUT-999");
    const done = await prisma.deal.findUnique({ where: { id: deal.id } });

    expect(done?.status).toBe("COMPLETED");
    expect(done?.releasedBy).toBe(ADMIN_ID);
    expect(done?.releasedAt).not.toBeNull();
    expect(done?.payoutReference).toBe("PAYOUT-999");
    // 10,000 - 1% seller fee = 9,900
    expect(parseFloat(done!.sellerPayoutAmount!.toString())).toBe(9900);
    expect(parseFloat(done!.sellerFeeAmount.toString())).toBe(100);
    // buyer fee 100 + seller fee 100 = 200 escrow fee
    expect(parseFloat(done!.escrowFeeAmount!.toString())).toBe(200);

    expect(parseFloat(result.sellerPayout)).toBe(9900);
    expect(parseFloat(result.sellerFee)).toBe(100);
    expect(parseFloat(result.escrowFee)).toBe(200);

    const releaseAudits = await prisma.escrowAuditLog.findMany({
      where: { dealId: deal.id, action: { in: ["MANUAL_RELEASE_CONFIRMED", "FEE_RECORDED"] } },
    });
    expect(releaseAudits.length).toBeGreaterThanOrEqual(2);

    const sellerTx = await prisma.transaction.findFirst({ where: { userId: SELLER_ID, type: "ESCROW_RELEASE" } });
    expect(sellerTx).not.toBeNull();
    expect(parseFloat(sellerTx!.amount.toString())).toBe(9900);

    // No custody: still no balances.
    expect(await prisma.balance.findFirst({ where: { userId: SELLER_ID } })).toBeNull();
  });

  it("dispute after verification -> manual refund -> REFUNDED", async () => {
    const deal = await createDeal("CRYPTO", "100");
    await toAwaitingPayment(deal.id);
    await dealService.reportPayment(deal.id, BUYER_ID, {});
    await dealService.verifyPayment(deal.id, ADMIN_ID);

    await dealService.openDispute(deal.id, BUYER_ID, "Item never delivered");
    expect((await prisma.deal.findUnique({ where: { id: deal.id } }))?.status).toBe("DISPUTED");

    await dealService.transition(deal.id, "UNDER_REVIEW", "ADMIN");
    await dealService.manualRefund(deal.id, ADMIN_ID, "Refunded after review");

    const refunded = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(refunded?.status).toBe("REFUNDED");
    expect(refunded?.refundedBy).toBe(ADMIN_ID);

    const audit = await prisma.escrowAuditLog.findFirst({ where: { dealId: deal.id, action: "MANUAL_REFUND_CONFIRMED" } });
    expect(audit).not.toBeNull();

    const buyerTx = await prisma.transaction.findFirst({ where: { userId: BUYER_ID, type: "REFUND" } });
    expect(buyerTx).not.toBeNull();

    const dispute = await prisma.dispute.findUnique({ where: { dealId: deal.id } });
    expect(dispute?.status).toBe("RESOLVED");
    expect(dispute?.resolution).toBe("REFUND_BUYER");
  });

  it("dispute -> manual release to seller -> RELEASED", async () => {
    const deal = await createDeal("CRYPTO", "100");
    await toAwaitingPayment(deal.id);
    await dealService.reportPayment(deal.id, BUYER_ID, {});
    await dealService.verifyPayment(deal.id, ADMIN_ID);

    await dealService.openDispute(deal.id, SELLER_ID, "Buyer refusing to accept");
    await dealService.transition(deal.id, "UNDER_REVIEW", "ADMIN");
    await dealService.manualReleaseForDispute(deal.id, ADMIN_ID, "Release after review");

    const released = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(released?.status).toBe("RELEASED");
    expect(parseFloat(released!.sellerPayoutAmount!.toString())).toBe(99); // 100 - 1%
    expect(parseFloat(released!.sellerFeeAmount.toString())).toBe(1);
  });

  it("rejects unauthorized actors (non-buyer report, non-admin verify/reject/refund)", async () => {
    const deal = await createDeal("INR", "1000");
    await toAwaitingPayment(deal.id);

    // Only the buyer can report payment.
    await expect(dealService.reportPayment(deal.id, SELLER_ID, {})).rejects.toThrow();

    await dealService.reportPayment(deal.id, BUYER_ID, {});

    // Verify/reject are ADMIN-only transitions.
    expect(canTransition("PAYMENT_REPORTED", "FUNDED", "BUYER")).toBeNull();
    expect(canTransition("PAYMENT_REPORTED", "AWAITING_PAYMENT", "BUYER")).toBeNull();

    // Only the buyer can request release.
    await dealService.verifyPayment(deal.id, ADMIN_ID);
    await dealService.transition(deal.id, "DELIVERED", "SELLER");
    await expect(dealService.requestRelease(deal.id, SELLER_ID)).rejects.toThrow();

    // Manual refund requires an UNDER_REVIEW deal + ADMIN.
    await expect(dealService.manualRefund(deal.id, ADMIN_ID, "nope")).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════
// FEE CALCULATION (explicit, 1% + 1%)
// ═══════════════════════════════════════════════════════════════════

describe("Fee calculation (INR example from spec)", () => {
  it("₹10,000 deal -> buyer pays ₹10,100, seller receives ₹9,900, escrower earns ₹200", async () => {
    const deal = await createDeal("INR", "10000");
    await toAwaitingPayment(deal.id);
    await dealService.reportPayment(deal.id, BUYER_ID, {});
    const verify = await dealService.verifyPayment(deal.id, ADMIN_ID);

    expect(parseFloat(verify.totalPaid)).toBe(10100); // buyer total
    expect(parseFloat(verify.buyerFee)).toBe(100);

    await dealService.transition(deal.id, "DELIVERED", "SELLER");
    await dealService.requestRelease(deal.id, BUYER_ID);
    const release = await dealService.confirmManualRelease(deal.id, ADMIN_ID);

    expect(parseFloat(release.sellerPayout)).toBe(9900); // seller receives
    expect(parseFloat(release.escrowFee)).toBe(200); // escrower earns
  });

  it("state machine exposes the manual happy path", () => {
    const happy: Array<[any, any, any]> = [
      ["CREATED", "JOINED", "SELLER"],
      ["JOINED", "AWAITING_PAYMENT", "SYSTEM"],
      ["AWAITING_PAYMENT", "PAYMENT_REPORTED", "BUYER"],
      ["PAYMENT_REPORTED", "FUNDED", "ADMIN"],
      ["FUNDED", "DELIVERED", "SELLER"],
      ["DELIVERED", "RELEASE_REQUESTED", "BUYER"],
      ["RELEASE_REQUESTED", "COMPLETED", "ADMIN"],
    ];
    for (const [from, to, by] of happy) {
      expect(canTransition(from, to, by), `${from}->${to} by ${by}`).not.toBeNull();
    }
  });

  it("disputes are only possible after payment is verified", () => {
    expect(DISPUTABLE_STATES.has("AWAITING_PAYMENT" as any)).toBe(false);
    expect(DISPUTABLE_STATES.has("PAYMENT_REPORTED" as any)).toBe(false);
    expect(DISPUTABLE_STATES.has("FUNDED")).toBe(true);
    expect(DISPUTABLE_STATES.has("DELIVERED")).toBe(true);
    expect(DISPUTABLE_STATES.has("RELEASE_REQUESTED")).toBe(true);
    expect(ACTIVE_STATES.has("AWAITING_PAYMENT")).toBe(true);
    expect(ACTIVE_STATES.has("PAYMENT_REPORTED")).toBe(true);
    expect(TERMINAL_STATES.has("COMPLETED")).toBe(true);
  });
});
