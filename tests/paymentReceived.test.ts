import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { dealService } from "../src/services/dealService.js";
import { canTransition, TERMINAL_STATES, ACTIVE_STATES } from "../src/lib/stateMachine.js";

const prisma = new PrismaClient();

const BUYER_ID = "44444444-4444-4444-4444-444444444444";
const SELLER_ID = "55555555-5555-5555-5555-555555555555";
const ADMIN_A = "66666666-6666-6666-6666-666666666666";
const ADMIN_B = "77777777-7777-7777-7777-777777777777";

async function cleanAll() {
  await prisma.adminAction.deleteMany();
  await prisma.adminSetting.deleteMany();
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
    create: { id, telegramId: BigInt(telegramId), username, firstName: "PaymentReceivedTest", status: "ACTIVE" },
    update: {},
  });
}

/** Full path to AWAITING_PAYMENT with both parties agreed + admin A accepted. */
async function acceptedDeal(method: "INR" | "CRYPTO" = "INR", amount = "10000") {
  const isInr = method === "INR";
  const deal = await dealService.create({
    buyerUserId: BUYER_ID,
    sellerUserId: SELLER_ID,
    sellerUsername: "seller_user",
    amount,
    asset: isInr ? "INR" : "USDT",
    network: isInr ? "UPI" : "BEP20",
    paymentMethod: method,
    currency: isInr ? "INR" : "USDT",
    cryptoPayer: method === "CRYPTO" ? "BUYER" : undefined,
    description: "Assigned admin test deal",
    category: "FREELANCE_SERVICES",
  });
  await dealService.agreeToDeal(deal.id, BUYER_ID);
  await dealService.agreeToDeal(deal.id, SELLER_ID);
  await dealService.adminAccept(deal.id, ADMIN_A);
  return deal;
}

beforeAll(async () => {
  await cleanAll();
  await createUser(BUYER_ID, "buyer_user", "440000000000000001");
  await createUser(SELLER_ID, "seller_user", "550000000000000001");
  await createUser(ADMIN_A, "admin_a", "660000000000000001");
  await createUser(ADMIN_B, "admin_b", "770000000000000001");
});

afterAll(async () => {
  await cleanAll();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await cleanAll();
  await createUser(BUYER_ID, "buyer_user", "440000000000000001");
  await createUser(SELLER_ID, "seller_user", "550000000000000001");
  await createUser(ADMIN_A, "admin_a", "660000000000000001");
  await createUser(ADMIN_B, "admin_b", "770000000000000001");
});

// ═══════════════════════════════════════════════════════════════════
// ASSIGNED-ADMIN PAYMENT VERIFICATION (acceptedBy is the ONLY verifier)
// ═══════════════════════════════════════════════════════════════════

describe("Assigned-admin payment verification (acceptedBy only)", () => {
  it("Admin B cannot verify a deal accepted by Admin A", async () => {
    const deal = await acceptedDeal("INR", "10000");
    await dealService.reportPayment(deal.id, BUYER_ID, { reference: "REF-1" });
    expect((await prisma.deal.findUnique({ where: { id: deal.id } }))?.status).toBe("PAYMENT_REPORTED");

    await expect(dealService.verifyPayment(deal.id, ADMIN_B)).rejects.toThrow(/not the admin assigned to this deal/);

    // Deal is untouched by the unauthorized attempt.
    const after = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(after?.status).toBe("PAYMENT_REPORTED");
    expect(after?.paymentVerifiedAt).toBeNull();
  });

  it("Admin B cannot reject or request evidence for Admin A's deal", async () => {
    const deal = await acceptedDeal("INR", "10000");
    await dealService.reportPayment(deal.id, BUYER_ID, { reference: "REF-2" });

    await expect(dealService.rejectPayment(deal.id, ADMIN_B, "nope")).rejects.toThrow(/not the admin assigned/);
    expect((await prisma.deal.findUnique({ where: { id: deal.id } }))?.status).toBe("PAYMENT_REPORTED");
  });

  it("Admin A (the assigned verifier) can verify -> PAYMENT_RECEIVED (terminal)", async () => {
    const deal = await acceptedDeal("INR", "10000");
    await dealService.reportPayment(deal.id, BUYER_ID, { reference: "REF-3" });

    const result = await dealService.verifyPayment(deal.id, ADMIN_A, "TXN-ABC");
    expect(parseFloat(result.buyerFee)).toBe(100); // 1% of 10,000
    expect(parseFloat(result.totalPaid)).toBe(10100);

    const updated = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(updated?.status).toBe("PAYMENT_RECEIVED");
    expect(updated?.paymentVerifiedBy).toBe(ADMIN_A);
    expect(updated?.paymentVerifiedAt).not.toBeNull();
    expect(updated?.paymentReference).toBe("TXN-ABC");
    expect(updated?.completedAt).not.toBeNull();

    // Audit trail: PAYMENT_RECEIVED + FEE_RECORDED.
    const audit = await prisma.escrowAuditLog.findFirst({ where: { dealId: deal.id, action: "PAYMENT_RECEIVED" } });
    expect(audit).not.toBeNull();
    const feeAudit = await prisma.escrowAuditLog.findFirst({ where: { dealId: deal.id, action: "FEE_RECORDED" } });
    expect(feeAudit).not.toBeNull();

    // No custody: no balance row is ever created.
    expect(await prisma.balance.findFirst({ where: { userId: BUYER_ID } })).toBeNull();
  });

  it("PAYMENT_RECEIVED is terminal: no further transitions exist", async () => {
    expect(TERMINAL_STATES.has("PAYMENT_RECEIVED")).toBe(true);
    expect(ACTIVE_STATES.has("PAYMENT_RECEIVED")).toBe(false);
    // No legal exit from PAYMENT_RECEIVED for any actor.
    for (const by of ["BUYER", "SELLER", "ADMIN", "SYSTEM"] as const) {
      expect(canTransition("PAYMENT_RECEIVED", "COMPLETED", by)).toBeNull();
      expect(canTransition("PAYMENT_RECEIVED", "DISPUTED", by)).toBeNull();
      expect(canTransition("PAYMENT_RECEIVED", "RELEASE_REQUESTED", by)).toBeNull();
      expect(canTransition("PAYMENT_RECEIVED", "REFUND_REQUESTED", by)).toBeNull();
    }
  });

  it("a deal without an acceptedBy (legacy) can be verified by any authorized admin", async () => {
    // Legacy path: deal joined via the old join flow (no group admin accept).
    const deal = await dealService.create({
      buyerUserId: BUYER_ID,
      sellerUserId: SELLER_ID,
      sellerUsername: "seller_user",
      amount: "5000",
      asset: "INR",
      network: "UPI",
      paymentMethod: "INR",
      currency: "INR",
      description: "Legacy no-acceptedBy deal",
      category: "FREELANCE_SERVICES",
    });
    await dealService.join(deal.id, SELLER_ID); // -> AWAITING_PAYMENT, acceptedBy stays null
    await dealService.reportPayment(deal.id, BUYER_ID, { reference: "REF-4" });

    const updated = await dealService.verifyPayment(deal.id, ADMIN_B);
    expect(updated).toBeDefined();
    expect((await prisma.deal.findUnique({ where: { id: deal.id } }))?.status).toBe("PAYMENT_RECEIVED");
  });

  it("crypto payer (seller) reports, assigned admin verifies the same way", async () => {
    const deal = await acceptedDeal("CRYPTO", "100");
    // Seller is the crypto payer on this deal — flip it at creation for realism.
    await prisma.deal.update({ where: { id: deal.id }, data: { cryptoPayer: "SELLER" } });

    // Buyer cannot report on a seller-pays deal.
    await expect(dealService.reportPayment(deal.id, BUYER_ID, {})).rejects.toThrow(/payer/);
    await dealService.reportPayment(deal.id, SELLER_ID, { reference: "TX-1" });

    await dealService.verifyPayment(deal.id, ADMIN_A, "TX-VERIFIED");
    const updated = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(updated?.status).toBe("PAYMENT_RECEIVED");
    expect(updated?.paymentVerifiedBy).toBe(ADMIN_A);
    expect(updated?.paymentReference).toBe("TX-VERIFIED");
  });

  it("verifyPayment requires PAYMENT_REPORTED (cannot skip the report)", async () => {
    const deal = await acceptedDeal("INR", "10000");
    // No payment report yet — still AWAITING_PAYMENT.
    await expect(dealService.verifyPayment(deal.id, ADMIN_A)).rejects.toThrow(/PAYMENT_REPORTED/);
  });

  it("duplicate verification is rejected (idempotent terminal state)", async () => {
    const deal = await acceptedDeal("INR", "10000");
    await dealService.reportPayment(deal.id, BUYER_ID, { reference: "REF-5" });
    await dealService.verifyPayment(deal.id, ADMIN_A);

    // Second verification attempt fails — already PAYMENT_RECEIVED.
    await expect(dealService.verifyPayment(deal.id, ADMIN_A)).rejects.toThrow();
    expect((await prisma.deal.findUnique({ where: { id: deal.id } }))?.status).toBe("PAYMENT_RECEIVED");
  });
});
