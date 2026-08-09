import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient, Prisma } from "@prisma/client";
import { treasuryService, HOUSE_USER_ID } from "../src/services/treasuryService.js";
import { dealService } from "../src/services/dealService.js";
import { canTransition, DISPUTABLE_STATES, TERMINAL_STATES, ACTIVE_STATES } from "../src/lib/stateMachine.js";
import { reconciliationService } from "../src/services/reconciliationService.js";

const prisma = new PrismaClient();

const BUYER_ID = "11111111-1111-1111-1111-111111111111";
const SELLER_ID = "22222222-2222-2222-2222-222222222222";
const DEAL_ID = "33333333-3333-3333-3333-333333333333";
const ASSET = "USDT";

// ─── Helpers ────────────────────────────────────────────────────────
async function cleanAll() {
  await prisma.adminAction.deleteMany();
  await prisma.disputeEvidence.deleteMany();
  await prisma.dispute.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.ledgerTransaction.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.withdrawalRequest.deleteMany();
  await prisma.blockchainDeposit.deleteMany();
  await prisma.balance.deleteMany();
  await prisma.deal.deleteMany();
}

async function createTestUser(id: string) {
  await prisma.user.upsert({
    where: { id },
    create: {
      id,
      telegramId: BigInt(id.replace(/-/g, "0").slice(0, 18)),
      firstName: id.startsWith("111") ? "TestBuyer" : id.startsWith("222") ? "TestSeller" : "House",
      status: "ACTIVE",
    },
    update: {},
  });
}

async function createTestDeal(overrides?: { buyerFeeBps?: number; sellerFeeBps?: number; status?: string }) {
  return prisma.deal.create({
    data: {
      id: DEAL_ID,
      inviteCode: "TESTDEAL",
      buyerId: BUYER_ID,
      sellerId: SELLER_ID,
      asset: ASSET,
      network: "TRC20",
      amount: "100",
      buyerFeeBps: overrides?.buyerFeeBps ?? 100,
      sellerFeeBps: overrides?.sellerFeeBps ?? 100,
      description: "Test deal",
      category: "FREELANCE_SERVICES",
      status: (overrides?.status as any) ?? "AWAITING_FUNDING",
    },
  });
}

async function creditBuyer(amount: string, txHash: string) {
  await treasuryService.creditDeposit({
    userId: BUYER_ID, amount, asset: ASSET,
    txHash, network: "TRC20", logIndex: 0,
  });
}

// ═══════════════════════════════════════════════════════════════════
// STATE MACHINE TESTS (no DB)
// ═══════════════════════════════════════════════════════════════════

describe("State Machine v2", () => {
  describe("dispute allowed states", () => {
    it("dispute allowed from FUNDED, IN_PROGRESS, DELIVERED, RELEASE_PENDING", () => {
      for (const state of ["FUNDED", "IN_PROGRESS", "DELIVERED", "RELEASE_PENDING"] as const) {
        expect(DISPUTABLE_STATES.has(state)).toBe(true);
      }
    });

    it("dispute NOT allowed from CREATED, JOINED, AWAITING_FUNDING, COMPLETED, CANCELLED, REFUNDED", () => {
      for (const state of ["CREATED", "JOINED", "AWAITING_FUNDING", "COMPLETED", "CANCELLED", "REFUNDED", "DISPUTED", "UNDER_REVIEW", "RELEASED", "EXPIRED"] as const) {
        expect(DISPUTABLE_STATES.has(state)).toBe(false);
      }
    });
  });

  describe("terminal states block all transitions", () => {
    for (const state of [...TERMINAL_STATES] as any[]) {
      it(`${state} should block all outgoing transitions`, () => {
        expect(canTransition(state, "FUNDED", "BUYER")).toBeNull();
        expect(canTransition(state, "DISPUTED", "SELLER")).toBeNull();
        expect(canTransition(state, "JOINED", "SELLER")).toBeNull();
        expect(canTransition(state, "CANCELLED", "BUYER")).toBeNull();
      });
    }
  });

  describe("happy path transitions", () => {
    const happyPath: Array<[any, any, "BUYER" | "SELLER" | "SYSTEM" | "ADMIN"]> = [
      ["CREATED", "JOINED", "SELLER"],
      ["JOINED", "AWAITING_FUNDING", "SYSTEM"],
      ["AWAITING_FUNDING", "FUNDED", "SYSTEM"],
      ["FUNDED", "IN_PROGRESS", "SYSTEM"],
      ["IN_PROGRESS", "DELIVERED", "SELLER"],
      ["DELIVERED", "RELEASE_PENDING", "BUYER"],
      ["RELEASE_PENDING", "COMPLETED", "SYSTEM"],
    ];

    for (const [from, to, by] of happyPath) {
      it(`${from} -> ${to} by ${by}`, () => {
        expect(canTransition(from, to, by)).not.toBeNull();
      });
    }
  });

  describe("invalid transitions are blocked", () => {
    const invalids: Array<[any, any, "BUYER" | "SELLER" | "SYSTEM" | "ADMIN"]> = [
      ["CREATED", "FUNDED", "SYSTEM"],
      ["JOINED", "DELIVERED", "SELLER"],
      ["AWAITING_FUNDING", "DISPUTED", "BUYER"],
      ["FUNDED", "CANCELLED", "BUYER"],
      ["FUNDED", "CANCELLED", "SELLER"],
      ["COMPLETED", "DISPUTED", "BUYER"],
      ["CANCELLED", "JOINED", "SELLER"],
      ["REFUNDED", "RELEASED", "ADMIN"],
    ];

    for (const [from, to, by] of invalids) {
      it(`${from} -> ${to} by ${by} should be blocked`, () => {
        expect(canTransition(from, to, by)).toBeNull();
      });
    }
  });

  describe("dispute transitions", () => {
    it("BUYER can dispute from FUNDED, IN_PROGRESS, DELIVERED, RELEASE_PENDING", () => {
      expect(canTransition("FUNDED", "DISPUTED", "BUYER")).not.toBeNull();
      expect(canTransition("IN_PROGRESS", "DISPUTED", "BUYER")).not.toBeNull();
      expect(canTransition("DELIVERED", "DISPUTED", "BUYER")).not.toBeNull();
      expect(canTransition("RELEASE_PENDING", "DISPUTED", "BUYER")).not.toBeNull();
    });

    it("SELLER can dispute from FUNDED, IN_PROGRESS, DELIVERED, RELEASE_PENDING", () => {
      expect(canTransition("FUNDED", "DISPUTED", "SELLER")).not.toBeNull();
      expect(canTransition("IN_PROGRESS", "DISPUTED", "SELLER")).not.toBeNull();
      expect(canTransition("DELIVERED", "DISPUTED", "SELLER")).not.toBeNull();
      expect(canTransition("RELEASE_PENDING", "DISPUTED", "SELLER")).not.toBeNull();
    });

    it("ADMIN resolves to UNDER_REVIEW -> RELEASED or REFUNDED", () => {
      expect(canTransition("DISPUTED", "UNDER_REVIEW", "ADMIN")).not.toBeNull();
      expect(canTransition("UNDER_REVIEW", "RELEASED", "ADMIN")).not.toBeNull();
      expect(canTransition("UNDER_REVIEW", "REFUNDED", "ADMIN")).not.toBeNull();
    });
  });

  describe("cancel transitions (pre-funded only)", () => {
    it("can cancel from CREATED, JOINED, AWAITING_FUNDING", () => {
      expect(canTransition("CREATED", "CANCELLED", "BUYER")).not.toBeNull();
      expect(canTransition("JOINED", "CANCELLED", "BUYER")).not.toBeNull();
      expect(canTransition("JOINED", "CANCELLED", "SELLER")).not.toBeNull();
      expect(canTransition("AWAITING_FUNDING", "CANCELLED", "BUYER")).not.toBeNull();
      expect(canTransition("AWAITING_FUNDING", "CANCELLED", "SELLER")).not.toBeNull();
    });

    it("cannot cancel from FUNDED onwards", () => {
      for (const state of ["FUNDED", "IN_PROGRESS", "DELIVERED", "RELEASE_PENDING", "DISPUTED", "UNDER_REVIEW", "RELEASED", "COMPLETED", "REFUNDED", "EXPIRED"] as const) {
        expect(canTransition(state, "CANCELLED", "BUYER")).toBeNull();
        expect(canTransition(state, "CANCELLED", "SELLER")).toBeNull();
      }
    });
  });

  describe("expiration transitions", () => {
    it("CREATED can expire by SYSTEM", () => {
      expect(canTransition("CREATED", "EXPIRED", "SYSTEM")).not.toBeNull();
    });
    it("AWAITING_FUNDING can expire by SYSTEM", () => {
      expect(canTransition("AWAITING_FUNDING", "EXPIRED", "SYSTEM")).not.toBeNull();
    });
    it("FUNDED cannot expire", () => {
      expect(canTransition("FUNDED", "EXPIRED", "SYSTEM")).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// DEPOSIT TESTS (require DB)
// ═══════════════════════════════════════════════════════════════════

describe("Deposit", () => {
  beforeAll(async () => {
    await cleanAll();
    await createTestUser(BUYER_ID);
  });

  afterAll(async () => {
    await cleanAll();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanAll();
    await createTestUser(BUYER_ID);
  });

  it("should credit deposit to user available balance", async () => {
    await creditBuyer("100", "0x_deposit_valid_1");
    const bal = await treasuryService.getBalance(BUYER_ID, ASSET);
    expect(parseFloat(bal.available)).toBe(100);
    expect(parseFloat(bal.locked)).toBe(0);
  });

  it("should reject duplicate deposit (idempotency)", async () => {
    await creditBuyer("100", "0x_deposit_dup_test");
    await expect(
      creditBuyer("100", "0x_deposit_dup_test")
    ).rejects.toThrow("IDEMPOTENT_DUPLICATE");

    const bal = await treasuryService.getBalance(BUYER_ID, ASSET);
    expect(parseFloat(bal.available)).toBe(100); // not 200
  });

  it("should track balanceAfter accurately", async () => {
    await creditBuyer("50", "0x_deposit_ba_1");
    await creditBuyer("30", "0x_deposit_ba_2");

    const entries = await prisma.ledgerEntry.findMany({
      where: { userId: BUYER_ID },
      orderBy: { id: "asc" },
    });
    expect(entries.length).toBe(2);
    expect(parseFloat(entries[0].balanceAfter.toString())).toBe(50);
    expect(parseFloat(entries[1].balanceAfter.toString())).toBe(80);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ESCROW FUNDING TESTS
// ═══════════════════════════════════════════════════════════════════

describe("Escrow Funding", () => {
  beforeAll(async () => {
    await cleanAll();
    await createTestUser(BUYER_ID);
    await createTestUser(SELLER_ID);
    await createTestUser(HOUSE_USER_ID);
  });

  afterAll(async () => {
    await cleanAll();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanAll();
    await createTestUser(BUYER_ID);
    await createTestUser(SELLER_ID);
    await createTestUser(HOUSE_USER_ID);
  });

  it("should lock deal amount + buyer fee (101 USDT for 100 USDT deal)", async () => {
    // Credit buyer with enough for amount + fee
    await creditBuyer("101", "0x_fund_exact_1");
    await createTestDeal();

    await dealService.fund(DEAL_ID);

    const buyerBal = await treasuryService.getBalance(BUYER_ID, ASSET);
    expect(parseFloat(buyerBal.available)).toBe(0);
    expect(parseFloat(buyerBal.locked)).toBe(100); // only principal locked

    // House should have the buyer fee
    const houseBal = await treasuryService.getBalance(HOUSE_USER_ID, ASSET);
    expect(parseFloat(houseBal.available)).toBe(1); // 1% buyer fee

    // Deal should be FUNDED
    const deal = await prisma.deal.findUnique({ where: { id: DEAL_ID } });
    expect(deal?.status).toBe("FUNDED");
    expect(deal?.buyerFeeAmount.toString()).toBe("1");
  });

  it("should reject funding with insufficient balance (needs 101, has 100)", async () => {
    await creditBuyer("100", "0x_fund_insuff_1");
    await createTestDeal();

    await expect(dealService.fund(DEAL_ID)).rejects.toThrow("INSUFFICIENT_BALANCE");

    const deal = await prisma.deal.findUnique({ where: { id: DEAL_ID } });
    expect(deal?.status).toBe("AWAITING_FUNDING"); // unchanged
  });

  it("should reject duplicate funding (idempotency)", async () => {
    await creditBuyer("200", "0x_fund_dup_1");
    await createTestDeal();

    await dealService.fund(DEAL_ID);
    await expect(dealService.fund(DEAL_ID)).rejects.toThrow();

    const buyerBal = await treasuryService.getBalance(BUYER_ID, ASSET);
    expect(parseFloat(buyerBal.available)).toBe(99); // 200 - 101 = 99
    expect(parseFloat(buyerBal.locked)).toBe(100);
  });

  it("should produce net-zero ledger transaction for funding", async () => {
    await creditBuyer("101", "0x_fund_nz_1");
    await createTestDeal();

    await dealService.fund(DEAL_ID);

    // Find the funding ledger tx
    const ledgerTx = await prisma.ledgerTransaction.findFirst({
      where: { type: "ESCROW_FUND", dealId: DEAL_ID },
      include: { entries: true },
    });
    expect(ledgerTx).not.toBeNull();

    let netSum = new Prisma.Decimal(0);
    for (const e of ledgerTx!.entries) {
      netSum = netSum.add(e.amount);
    }
    expect(Math.abs(parseFloat(netSum.toString()))).toBeLessThan(0.0001);
  });

  it("should handle different fee rates (2% = 200 bps)", async () => {
    await creditBuyer("102", "0x_fund_2pct_1");
    await createTestDeal({ buyerFeeBps: 200 }); // 2%

    await dealService.fund(DEAL_ID);

    const buyerBal = await treasuryService.getBalance(BUYER_ID, ASSET);
    expect(parseFloat(buyerBal.available)).toBe(0);
    expect(parseFloat(buyerBal.locked)).toBe(100);

    const houseBal = await treasuryService.getBalance(HOUSE_USER_ID, ASSET);
    expect(parseFloat(houseBal.available)).toBe(2); // 2% fee
  });
});

// ═══════════════════════════════════════════════════════════════════
// ESCROW RELEASE TESTS
// ═══════════════════════════════════════════════════════════════════

describe("Escrow Release", () => {
  beforeAll(async () => {
    await cleanAll();
    await createTestUser(BUYER_ID);
    await createTestUser(SELLER_ID);
    await createTestUser(HOUSE_USER_ID);
  });

  afterAll(async () => {
    await cleanAll();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanAll();
    await createTestUser(BUYER_ID);
    await createTestUser(SELLER_ID);
    await createTestUser(HOUSE_USER_ID);
  });

  async function setupFundedDeal(sellerFeeBps = 100) {
    await creditBuyer("101", `0x_release_setup_${Date.now()}`);
    await createTestDeal({ sellerFeeBps });
    await dealService.fund(DEAL_ID);
    // Manually set to DELIVERED for release
    await prisma.deal.update({ where: { id: DEAL_ID }, data: { status: "DELIVERED" } });
  }

  it("should release: buyer locked -100, seller available +99, house fee +1", async () => {
    await setupFundedDeal();

    await dealService.release(DEAL_ID);

    const buyerBal = await treasuryService.getBalance(BUYER_ID, ASSET);
    expect(parseFloat(buyerBal.available)).toBe(0);
    expect(parseFloat(buyerBal.locked)).toBe(0);

    const sellerBal = await treasuryService.getBalance(SELLER_ID, ASSET);
    expect(parseFloat(sellerBal.available)).toBe(99); // 100 - 1% seller fee

    const houseBal = await treasuryService.getBalance(HOUSE_USER_ID, ASSET);
    // House had 1 (buyer fee) + 1 (seller fee) = 2
    expect(parseFloat(houseBal.available)).toBe(2);

    const deal = await prisma.deal.findUnique({ where: { id: DEAL_ID } });
    expect(deal?.status).toBe("COMPLETED");
  });

  it("should reject duplicate release (idempotency)", async () => {
    await setupFundedDeal();
    await dealService.release(DEAL_ID);
    await expect(dealService.release(DEAL_ID)).rejects.toThrow();

    const sellerBal = await treasuryService.getBalance(SELLER_ID, ASSET);
    expect(parseFloat(sellerBal.available)).toBe(99); // still 99, not 198
  });

  it("should produce net-zero release ledger", async () => {
    await setupFundedDeal();
    await dealService.release(DEAL_ID);

    const ledgerTx = await prisma.ledgerTransaction.findFirst({
      where: { type: "ESCROW_RELEASE", dealId: DEAL_ID },
      include: { entries: true },
    });
    expect(ledgerTx).not.toBeNull();

    let netSum = new Prisma.Decimal(0);
    for (const e of ledgerTx!.entries) {
      netSum = netSum.add(e.amount);
    }
    expect(Math.abs(parseFloat(netSum.toString()))).toBeLessThan(0.0001);
  });

  it("should calculate seller fee from escrow amount, not total paid", async () => {
    // 100 USDT deal, 2% seller fee = 2 USDT
    await setupFundedDeal(200);

    await dealService.release(DEAL_ID);

    const sellerBal = await treasuryService.getBalance(SELLER_ID, ASSET);
    expect(parseFloat(sellerBal.available)).toBe(98); // 100 - 2

    const deal = await prisma.deal.findUnique({ where: { id: DEAL_ID } });
    expect(deal?.sellerFeeAmount.toString()).toBe("2");
  });
});

// ═══════════════════════════════════════════════════════════════════
// REFUND TESTS
// ═══════════════════════════════════════════════════════════════════

describe("Refund", () => {
  beforeAll(async () => {
    await cleanAll();
    await createTestUser(BUYER_ID);
    await createTestUser(SELLER_ID);
    await createTestUser(HOUSE_USER_ID);
  });

  afterAll(async () => {
    await cleanAll();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanAll();
    await createTestUser(BUYER_ID);
    await createTestUser(SELLER_ID);
    await createTestUser(HOUSE_USER_ID);
  });

  async function setupFundedForRefund() {
    await creditBuyer("101", `0x_refund_setup_${Date.now()}`);
    await createTestDeal();
    await dealService.fund(DEAL_ID);
  }

  it("should refund escrow principal to buyer (fee policy: keep buyer fee)", async () => {
    await setupFundedForRefund();

    // Simulate admin refund (buyerFeeRefundOnRefund = false is the test default)
    // We test via dealService.resolveDispute
    await prisma.deal.update({ where: { id: DEAL_ID }, data: { status: "UNDER_REVIEW" } });
    await prisma.dispute.create({
      data: { dealId: DEAL_ID, openedBy: BUYER_ID, reason: "test" },
    });

    await dealService.resolveDispute(DEAL_ID, HOUSE_USER_ID, "REFUND_BUYER", "test refund");

    const buyerBal = await treasuryService.getBalance(BUYER_ID, ASSET);
    expect(parseFloat(buyerBal.available)).toBe(100); // principal returned
    expect(parseFloat(buyerBal.locked)).toBe(0);

    // House should still have the 1 USDT buyer fee
    const houseBal = await treasuryService.getBalance(HOUSE_USER_ID, ASSET);
    expect(parseFloat(houseBal.available)).toBe(1);

    const deal = await prisma.deal.findUnique({ where: { id: DEAL_ID } });
    expect(deal?.status).toBe("REFUNDED");
  });

  it("should reject duplicate refund (idempotency)", async () => {
    await setupFundedForRefund();

    await prisma.deal.update({ where: { id: DEAL_ID }, data: { status: "UNDER_REVIEW" } });
    await prisma.dispute.create({
      data: { dealId: DEAL_ID, openedBy: BUYER_ID, reason: "test" },
    });

    await dealService.resolveDispute(DEAL_ID, HOUSE_USER_ID, "REFUND_BUYER", "first");
    await expect(
      dealService.resolveDispute(DEAL_ID, HOUSE_USER_ID, "REFUND_BUYER", "duplicate")
    ).rejects.toThrow();

    // Buyer should still have exactly 100
    const buyerBal = await treasuryService.getBalance(BUYER_ID, ASSET);
    expect(parseFloat(buyerBal.available)).toBe(100);
  });

  it("should produce net-zero refund ledger", async () => {
    await setupFundedForRefund();

    await prisma.deal.update({ where: { id: DEAL_ID }, data: { status: "UNDER_REVIEW" } });
    await prisma.dispute.create({
      data: { dealId: DEAL_ID, openedBy: BUYER_ID, reason: "test" },
    });

    await dealService.resolveDispute(DEAL_ID, HOUSE_USER_ID, "REFUND_BUYER", "test");

    const ledgerTx = await prisma.ledgerTransaction.findFirst({
      where: { type: "REFUND", dealId: DEAL_ID },
      include: { entries: true },
    });
    expect(ledgerTx).not.toBeNull();

    let netSum = new Prisma.Decimal(0);
    for (const e of ledgerTx!.entries) {
      netSum = netSum.add(e.amount);
    }
    expect(Math.abs(parseFloat(netSum.toString()))).toBeLessThan(0.0001);
  });
});

// ═══════════════════════════════════════════════════════════════════
// WITHDRAWAL TESTS
// ═══════════════════════════════════════════════════════════════════

describe("Withdrawal", () => {
  beforeAll(async () => {
    await cleanAll();
    await createTestUser(BUYER_ID);
  });

  afterAll(async () => {
    await cleanAll();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanAll();
    await createTestUser(BUYER_ID);
  });

  it("should reserve funds on withdrawal request", async () => {
    await creditBuyer("100", "0x_wd_reserve_1");

    const { requestWithdrawal } = await import("../src/workers/withdrawal.js");
    await requestWithdrawal({
      userId: BUYER_ID, asset: ASSET, amount: "50",
      toAddress: "TSomeAddress", network: "TRC20",
    });

    const bal = await treasuryService.getBalance(BUYER_ID, ASSET);
    expect(parseFloat(bal.available)).toBe(50); // 100 - 50

    const wdReq = await prisma.withdrawalRequest.findFirst({
      where: { userId: BUYER_ID },
    });
    expect(wdReq?.status).toBe("QUEUED");
  });

  it("should reject withdrawal with insufficient balance", async () => {
    await creditBuyer("30", "0x_wd_insuff_1");

    const { requestWithdrawal } = await import("../src/workers/withdrawal.js");
    await expect(
      requestWithdrawal({
        userId: BUYER_ID, asset: ASSET, amount: "50",
        toAddress: "TSomeAddress", network: "TRC20",
      })
    ).rejects.toThrow("Insufficient balance");
  });

  it("should reverse withdrawal on broadcast failure", async () => {
    await creditBuyer("100", "0x_wd_reverse_1");

    const { requestWithdrawal } = await import("../src/workers/withdrawal.js");
    const wdId = await requestWithdrawal({
      userId: BUYER_ID, asset: ASSET, amount: "50",
      toAddress: "TSomeAddress", network: "TRC20",
    });

    // Simulate broadcast failure by directly reversing
    await treasuryService.reverseWithdrawal({
      userId: BUYER_ID, asset: ASSET, amount: "50", withdrawalRequestId: wdId,
    });

    const bal = await treasuryService.getBalance(BUYER_ID, ASSET);
    expect(parseFloat(bal.available)).toBe(100); // fully restored
  });
});

// ═══════════════════════════════════════════════════════════════════
// RECONCILIATION TESTS
// ═══════════════════════════════════════════════════════════════════

describe("Reconciliation", () => {
  beforeAll(async () => {
    await cleanAll();
    await createTestUser(BUYER_ID);
    await createTestUser(SELLER_ID);
    await createTestUser(HOUSE_USER_ID);
  });

  afterAll(async () => {
    await cleanAll();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanAll();
    await createTestUser(BUYER_ID);
    await createTestUser(SELLER_ID);
    await createTestUser(HOUSE_USER_ID);
  });

  it("should pass reconciliation after deposit + fund + release cycle", async () => {
    // Deposit
    await creditBuyer("101", "0x_recon_full_1");
    // Fund
    await createTestDeal();
    await dealService.fund(DEAL_ID);
    // Release
    await prisma.deal.update({ where: { id: DEAL_ID }, data: { status: "DELIVERED" } });
    await dealService.release(DEAL_ID);

    const result = await reconciliationService.runFull();
    expect(result.ledgerViolations).toBe(0);
    expect(result.userBalanceDiscrepancies).toBe(0);
  });

  it("should pass reconciliation after deposit + fund + refund cycle", async () => {
    await creditBuyer("101", "0x_recon_refund_1");
    await createTestDeal();
    await dealService.fund(DEAL_ID);

    await prisma.deal.update({ where: { id: DEAL_ID }, data: { status: "UNDER_REVIEW" } });
    await prisma.dispute.create({ data: { dealId: DEAL_ID, openedBy: BUYER_ID, reason: "test" } });
    await dealService.resolveDispute(DEAL_ID, HOUSE_USER_ID, "REFUND_BUYER", "reconcile test");

    const result = await reconciliationService.runFull();
    expect(result.ledgerViolations).toBe(0);
    expect(result.userBalanceDiscrepancies).toBe(0);
  });

  it("should validate all internal ledger TXs net to zero", async () => {
    await creditBuyer("101", "0x_recon_nz_1");
    await createTestDeal();
    await dealService.fund(DEAL_ID);

    // Check only internal TXs (not DEPOSIT)
    const violations = await prisma.ledgerTransaction.findMany({
      where: { type: { not: "DEPOSIT" } },
      include: { entries: true },
    });

    for (const tx of violations) {
      let netSum = new Prisma.Decimal(0);
      for (const e of tx.entries) {
        netSum = netSum.add(e.amount);
      }
      expect(Math.abs(parseFloat(netSum.toString()))).toBeLessThan(0.0001);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// FEE ACCOUNTING VERIFICATION
// ═══════════════════════════════════════════════════════════════════

describe("Fee Accounting", () => {
  beforeAll(async () => {
    await cleanAll();
    await createTestUser(BUYER_ID);
    await createTestUser(SELLER_ID);
    await createTestUser(HOUSE_USER_ID);
  });

  afterAll(async () => {
    await cleanAll();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanAll();
    await createTestUser(BUYER_ID);
    await createTestUser(SELLER_ID);
    await createTestUser(HOUSE_USER_ID);
  });

  it("platform should collect 2 USDT total on 100 USDT deal (1% buyer + 1% seller)", async () => {
    await creditBuyer("101", "0x_fee_total_1");
    await createTestDeal();
    await dealService.fund(DEAL_ID);

    await prisma.deal.update({ where: { id: DEAL_ID }, data: { status: "DELIVERED" } });
    await dealService.release(DEAL_ID);

    const houseBal = await treasuryService.getBalance(HOUSE_USER_ID, ASSET);
    expect(parseFloat(houseBal.available)).toBe(2); // 1 (buyer) + 1 (seller)
  });

  it("platform should collect 4 USDT total on 100 USDT deal (2% + 2%)", async () => {
    await creditBuyer("102", "0x_fee_4pct_1");
    await createTestDeal({ buyerFeeBps: 200, sellerFeeBps: 200 });
    await dealService.fund(DEAL_ID);

    await prisma.deal.update({ where: { id: DEAL_ID }, data: { status: "DELIVERED" } });
    await dealService.release(DEAL_ID);

    const houseBal = await treasuryService.getBalance(HOUSE_USER_ID, ASSET);
    expect(parseFloat(houseBal.available)).toBe(4); // 2 + 2

    const sellerBal = await treasuryService.getBalance(SELLER_ID, ASSET);
    expect(parseFloat(sellerBal.available)).toBe(98); // 100 - 2
  });

  it("on refund, platform keeps buyer fee if policy says so", async () => {
    await creditBuyer("101", "0x_fee_refund_1");
    await createTestDeal();
    await dealService.fund(DEAL_ID);

    await prisma.deal.update({ where: { id: DEAL_ID }, data: { status: "UNDER_REVIEW" } });
    await prisma.dispute.create({ data: { dealId: DEAL_ID, openedBy: BUYER_ID, reason: "test" } });
    await dealService.resolveDispute(DEAL_ID, HOUSE_USER_ID, "REFUND_BUYER", "policy test");

    const houseBal = await treasuryService.getBalance(HOUSE_USER_ID, ASSET);
    expect(parseFloat(houseBal.available)).toBe(1); // kept buyer fee

    const buyerBal = await treasuryService.getBalance(BUYER_ID, ASSET);
    expect(parseFloat(buyerBal.available)).toBe(100); // principal returned, fee kept
  });
});

// ═══════════════════════════════════════════════════════════════════
// DISPUTED RELEASE_PENDING TESTS
// ═══════════════════════════════════════════════════════════════════

describe("RELEASE_PENDING disputes", () => {
  it("RELEASE_PENDING -> DISPUTED should be valid for BUYER", () => {
    expect(canTransition("RELEASE_PENDING", "DISPUTED", "BUYER")).not.toBeNull();
  });

  it("RELEASE_PENDING -> DISPUTED should be valid for SELLER", () => {
    expect(canTransition("RELEASE_PENDING", "DISPUTED", "SELLER")).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// COMPLETED DEAL IMMUNITY TESTS
// ═══════════════════════════════════════════════════════════════════

describe("Completed deal immunity", () => {
  it("COMPLETED cannot be disputed", () => {
    expect(canTransition("COMPLETED", "DISPUTED", "BUYER")).toBeNull();
    expect(canTransition("COMPLETED", "DISPUTED", "SELLER")).toBeNull();
  });

  it("COMPLETED cannot be refunded", () => {
    expect(canTransition("COMPLETED", "REFUNDED", "ADMIN")).toBeNull();
  });

  it("COMPLETED is a terminal state", () => {
    expect(TERMINAL_STATES.has("COMPLETED")).toBe(true);
  });
});
