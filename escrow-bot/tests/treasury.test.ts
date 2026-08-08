import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { treasuryService, HOUSE_USER_ID } from "../src/services/treasuryService.js";
import { canTransition, DISPUTABLE_STATES, TERMINAL_STATES } from "../src/lib/stateMachine.js";

const prisma = new PrismaClient();

const BUYER_ID = "11111111-1111-1111-1111-111111111111";
const SELLER_ID = "22222222-2222-2222-2222-222222222222";
const DEAL_ID = "33333333-3333-3333-3333-333333333333";
const ASSET = "USDT";

// ─── Helpers ────────────────────────────────────────────────────────
async function cleanAll() {
  await prisma.ledgerEntry.deleteMany();
  await prisma.ledgerTransaction.deleteMany();
  await prisma.transaction.deleteMany();
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

async function createTestDeal() {
  return prisma.deal.create({
    data: {
      id: DEAL_ID,
      inviteCode: "TESTDEAL",
      buyerId: BUYER_ID,
      sellerId: SELLER_ID,
      asset: ASSET,
      network: "TRC20",
      amount: "100",
      description: "Test deal",
      category: "FREELANCE_SERVICES",
      status: "FUNDED",
    },
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("TreasuryService", () => {
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

  describe("creditDeposit", () => {
    it("should credit deposit to user available balance", async () => {
      await treasuryService.creditDeposit({
        userId: BUYER_ID,
        amount: "100",
        asset: ASSET,
        txHash: "0xabc123_deposit_1",
        network: "TRC20",
      });

      const bal = await treasuryService.getBalance(BUYER_ID, ASSET);
      expect(parseFloat(bal.available)).toBe(100);
      expect(parseFloat(bal.locked)).toBe(0);
    });

    it("should reject duplicate deposit (idempotency)", async () => {
      await treasuryService.creditDeposit({
        userId: BUYER_ID,
        amount: "100",
        asset: ASSET,
        txHash: "0xabc123_dup_test",
        network: "TRC20",
      });

      await expect(
        treasuryService.creditDeposit({
          userId: BUYER_ID,
          amount: "100",
          asset: ASSET,
          txHash: "0xabc123_dup_test",
          network: "TRC20",
        })
      ).rejects.toThrow("IDEMPOTENT_DUPLICATE");

      const bal = await treasuryService.getBalance(BUYER_ID, ASSET);
      expect(parseFloat(bal.available)).toBe(100); // not 200
    });
  });

  describe("escrowLock", () => {
    it("should move available -> locked", async () => {
      // Credit first
      await treasuryService.creditDeposit({
        userId: BUYER_ID, amount: "100", asset: ASSET,
        txHash: "0x_lock_test_1", network: "TRC20",
      });

      await createTestDeal();
      await treasuryService.escrowLock({
        userId: BUYER_ID, dealId: DEAL_ID, amount: "100", asset: ASSET,
      });

      const bal = await treasuryService.getBalance(BUYER_ID, ASSET);
      expect(parseFloat(bal.available)).toBe(0);
      expect(parseFloat(bal.locked)).toBe(100);
    });

    it("should reject lock with insufficient balance", async () => {
      await treasuryService.creditDeposit({
        userId: BUYER_ID, amount: "50", asset: ASSET,
        txHash: "0x_lock_test_2", network: "TRC20",
      });

      await createTestDeal();
      await expect(
        treasuryService.escrowLock({
          userId: BUYER_ID, dealId: DEAL_ID, amount: "100", asset: ASSET,
        })
      ).rejects.toThrow("INSUFFICIENT_AVAILABLE");
    });

    it("should reject duplicate lock (idempotency)", async () => {
      await treasuryService.creditDeposit({
        userId: BUYER_ID, amount: "200", asset: ASSET,
        txHash: "0x_lock_dup_1", network: "TRC20",
      });
      await createTestDeal();

      await treasuryService.escrowLock({
        userId: BUYER_ID, dealId: DEAL_ID, amount: "100", asset: ASSET,
      });

      await expect(
        treasuryService.escrowLock({
          userId: BUYER_ID, dealId: DEAL_ID, amount: "100", asset: ASSET,
        })
      ).rejects.toThrow("IDEMPOTENT_DUPLICATE");
    });
  });

  describe("escrowRelease with fee", () => {
    it("should transfer locked -> seller available + house fee", async () => {
      // Setup: buyer has 100 locked
      await treasuryService.creditDeposit({
        userId: BUYER_ID, amount: "100", asset: ASSET,
        txHash: "0x_release_test_1", network: "TRC20",
      });
      await createTestDeal();
      await treasuryService.escrowLock({
        userId: BUYER_ID, dealId: DEAL_ID, amount: "100", asset: ASSET,
      });

      // Release with 1% fee
      await treasuryService.escrowRelease({
        buyerId: BUYER_ID,
        sellerId: SELLER_ID,
        dealId: DEAL_ID,
        amount: "100",
        asset: ASSET,
        feeRate: 0.01,
      });

      const buyerBal = await treasuryService.getBalance(BUYER_ID, ASSET);
      const sellerBal = await treasuryService.getBalance(SELLER_ID, ASSET);
      const houseBal = await treasuryService.getBalance(HOUSE_USER_ID, ASSET);

      expect(parseFloat(buyerBal.available)).toBe(0);
      expect(parseFloat(buyerBal.locked)).toBe(0);
      expect(parseFloat(sellerBal.available)).toBe(99); // 100 - 1% fee
      expect(parseFloat(sellerBal.locked)).toBe(0);
      expect(parseFloat(houseBal.available)).toBe(1); // 1% fee
    });

    it("should reject duplicate release (idempotency)", async () => {
      await treasuryService.creditDeposit({
        userId: BUYER_ID, amount: "100", asset: ASSET,
        txHash: "0x_release_dup_1", network: "TRC20",
      });
      await createTestDeal();
      await treasuryService.escrowLock({
        userId: BUYER_ID, dealId: DEAL_ID, amount: "100", asset: ASSET,
      });
      await treasuryService.escrowRelease({
        buyerId: BUYER_ID, sellerId: SELLER_ID, dealId: DEAL_ID,
        amount: "100", asset: ASSET, feeRate: 0.01,
      });

      await expect(
        treasuryService.escrowRelease({
          buyerId: BUYER_ID, sellerId: SELLER_ID, dealId: DEAL_ID,
          amount: "100", asset: ASSET, feeRate: 0.01,
        })
      ).rejects.toThrow("IDEMPOTENT_DUPLICATE");
    });
  });

  describe("refund", () => {
    it("should move locked -> available", async () => {
      await treasuryService.creditDeposit({
        userId: BUYER_ID, amount: "100", asset: ASSET,
        txHash: "0x_refund_test_1", network: "TRC20",
      });
      await createTestDeal();
      await treasuryService.escrowLock({
        userId: BUYER_ID, dealId: DEAL_ID, amount: "100", asset: ASSET,
      });

      await treasuryService.refund({
        userId: BUYER_ID, dealId: DEAL_ID, amount: "100", asset: ASSET,
      });

      const bal = await treasuryService.getBalance(BUYER_ID, ASSET);
      expect(parseFloat(bal.available)).toBe(100);
      expect(parseFloat(bal.locked)).toBe(0);
    });

    it("should reject duplicate refund (idempotency)", async () => {
      await treasuryService.creditDeposit({
        userId: BUYER_ID, amount: "100", asset: ASSET,
        txHash: "0x_refund_dup_1", network: "TRC20",
      });
      await createTestDeal();
      await treasuryService.escrowLock({
        userId: BUYER_ID, dealId: DEAL_ID, amount: "100", asset: ASSET,
      });
      await treasuryService.refund({
        userId: BUYER_ID, dealId: DEAL_ID, amount: "100", asset: ASSET,
      });

      await expect(
        treasuryService.refund({
          userId: BUYER_ID, dealId: DEAL_ID, amount: "100", asset: ASSET,
        })
      ).rejects.toThrow("IDEMPOTENT_DUPLICATE");
    });
  });

  describe("Net-zero validation", () => {
    it("all ledger transactions should net to zero", async () => {
      await treasuryService.creditDeposit({
        userId: BUYER_ID, amount: "100", asset: ASSET,
        txHash: "0x_nz_test_1", network: "TRC20",
      });
      await createTestDeal();
      await treasuryService.escrowLock({
        userId: BUYER_ID, dealId: DEAL_ID, amount: "100", asset: ASSET,
      });
      await treasuryService.escrowRelease({
        buyerId: BUYER_ID, sellerId: SELLER_ID, dealId: DEAL_ID,
        amount: "100", asset: ASSET, feeRate: 0.01,
      });

      // Verify all ledger TXs net to zero
      const allTx = await prisma.ledgerTransaction.findMany();
      for (const tx of allTx) {
        const result = await treasuryService.validateLedgerTx(tx.id);
        expect(result.valid).toBe(true);
      }
    });
  });

  describe("balanceAfter accuracy", () => {
    it("should calculate correct running balanceAfter for each entry", async () => {
      await treasuryService.creditDeposit({
        userId: BUYER_ID, amount: "100", asset: ASSET,
        txHash: "0x_ba_test_1", network: "TRC20",
      });

      const entries = await prisma.ledgerEntry.findMany({
        where: { userId: BUYER_ID },
        orderBy: { id: "asc" },
      });
      expect(entries.length).toBeGreaterThanOrEqual(1);

      // The deposit entry should have balanceAfter = 100
      const depositEntry = entries.find((e) => e.type === "DEPOSIT");
      expect(depositEntry).toBeDefined();
      expect(parseFloat(depositEntry!.balanceAfter.toString())).toBe(100);
    });
  });
});

describe("State Machine", () => {
  it("dispute allowed from FUNDED, IN_PROGRESS, DELIVERED, RELEASE_PENDING", () => {
    for (const state of ["FUNDED", "IN_PROGRESS", "DELIVERED", "RELEASE_PENDING"] as const) {
      expect(DISPUTABLE_STATES.has(state)).toBe(true);
    }
    expect(DISPUTABLE_STATES.has("CREATED")).toBe(false);
    expect(DISPUTABLE_STATES.has("AWAITING_DEPOSIT")).toBe(false);
    expect(DISPUTABLE_STATES.has("COMPLETED")).toBe(false);
  });

  it("CANCELLED is not disputable", () => {
    expect(DISPUTABLE_STATES.has("CANCELLED")).toBe(false);
  });

  it("terminal states block all transitions", () => {
    for (const state of TERMINAL_STATES) {
      expect(canTransition(state, "FUNDED", "BUYER")).toBeNull();
      expect(canTransition(state, "DISPUTED", "SELLER")).toBeNull();
    }
  });

  it("valid happy path transitions", () => {
    expect(canTransition("CREATED", "JOINED", "SELLER")).not.toBeNull();
    expect(canTransition("JOINED", "AWAITING_DEPOSIT", "SYSTEM")).not.toBeNull();
    expect(canTransition("AWAITING_DEPOSIT", "FUNDED", "SYSTEM")).not.toBeNull();
    expect(canTransition("FUNDED", "IN_PROGRESS", "SYSTEM")).not.toBeNull();
    expect(canTransition("IN_PROGRESS", "DELIVERED", "SELLER")).not.toBeNull();
    expect(canTransition("DELIVERED", "RELEASE_PENDING", "BUYER")).not.toBeNull();
    expect(canTransition("RELEASE_PENDING", "RELEASED", "SYSTEM")).not.toBeNull();
    expect(canTransition("RELEASED", "COMPLETED", "SYSTEM")).not.toBeNull();
  });

  it("cannot dispute from AWAITING_DEPOSIT", () => {
    expect(canTransition("AWAITING_DEPOSIT", "DISPUTED", "BUYER")).toBeNull();
  });

  it("REFUNDED can transition to COMPLETED", () => {
    expect(canTransition("REFUNDED", "COMPLETED", "SYSTEM")).not.toBeNull();
  });

  it("cannot cancel after FUNDED", () => {
    expect(canTransition("FUNDED", "CANCELLED", "BUYER")).toBeNull();
    expect(canTransition("FUNDED", "CANCELLED", "SELLER")).toBeNull();
  });
});
