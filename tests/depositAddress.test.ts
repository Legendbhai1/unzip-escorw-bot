import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { HDNodeWallet } from "ethers";
import {
  getUserDepositAddress,
  getMonitoredAddresses,
  getUserIdForAddress,
  isValidDepositAddress,
  deriveDepositAddress,
  userAddressIndex,
} from "../src/services/depositAddressService.js";
import { blockchainMonitor } from "../src/services/blockchainMonitor.js";
import { treasuryService } from "../src/services/treasuryService.js";

const prisma = new PrismaClient();

// Public, well-known BIP-39 test mnemonic (ethers docs) — NOT a real secret.
const MNEMONIC = "test test test test test test test test test test test junk";

const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const USER_C = "cccccccc-cccc-cccc-cccc-cccccccccccc"; // reserved for mnemonic-missing tests

async function cleanAll() {
  await prisma.depositAddress.deleteMany();
  await prisma.blockchainDeposit.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.ledgerTransaction.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.balance.deleteMany();
  await prisma.withdrawalRequest.deleteMany();
  await prisma.disputeEvidence.deleteMany();
  await prisma.dispute.deleteMany();
  await prisma.adminAction.deleteMany();
  await prisma.deal.deleteMany();
  await prisma.user.deleteMany();
}

const TELEGRAM_IDS: Record<string, string> = {
  [USER_A]: "990000000000000001",
  [USER_B]: "990000000000000002",
  [USER_C]: "990000000000000003",
};

async function createUser(id: string) {
  await prisma.user.upsert({
    where: { id },
    create: {
      id,
      telegramId: BigInt(TELEGRAM_IDS[id] ?? "990000000000000099"),
      firstName: "Test User",
      status: "ACTIVE",
    },
    update: {},
  });
}

// ═══════════════════════════════════════════════════════════════════
// PURE DERIVATION TESTS (no DB needed)
// ═══════════════════════════════════════════════════════════════════

describe("Deposit address derivation (pure)", () => {
  const saved = process.env.DEPOSIT_HD_MNEMONIC;

  beforeAll(() => {
    process.env.DEPOSIT_HD_MNEMONIC = MNEMONIC;
  });

  afterAll(() => {
    process.env.DEPOSIT_HD_MNEMONIC = saved;
  });

  it("is deterministic: same user+network always yields the same address", () => {
    const a1 = deriveDepositAddress("BEP20", USER_A);
    const a2 = deriveDepositAddress("BEP20", USER_A);
    expect(a1).not.toBeNull();
    expect(a1).toBe(a2);
  });

  it("yields different addresses for different users", () => {
    const a = deriveDepositAddress("BEP20", USER_A);
    const b = deriveDepositAddress("BEP20", USER_B);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("BEP20 address is a valid EVM address and matches the BIP-44 path m/44'/60'/0'/0/{i}", () => {
    const addr = deriveDepositAddress("BEP20", USER_A)!;
    expect(addr).toMatch(/^0x[a-f0-9]{40}$/);
    const expected = HDNodeWallet.fromPhrase(
      MNEMONIC, undefined, `m/44'/60'/0'/0/${userAddressIndex(USER_A)}`
    ).address.toLowerCase();
    expect(addr).toBe(expected);
  });

  it("TRC20 address is a valid TRON address (base58, 0x41 prefix, checksum)", () => {
    const addr = deriveDepositAddress("TRC20", USER_A)!;
    expect(addr).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(addr.length).toBe(34);
    expect(isValidDepositAddress("TRC20", addr)).toBe(true);
    expect(addr).not.toBe(deriveDepositAddress("BEP20", USER_A));
  });

  it("isValidDepositAddress rejects junk", () => {
    expect(isValidDepositAddress("TRC20", "T" + "1".repeat(33))).toBe(false);
    expect(isValidDepositAddress("BEP20", "0xzzz")).toBe(false);
    expect(isValidDepositAddress("BEP20", "0x" + "f".repeat(40))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MISSING / INVALID MNEMONIC
// ═══════════════════════════════════════════════════════════════════

describe("Missing / invalid DEPOSIT_HD_MNEMONIC", () => {
  const saved = process.env.DEPOSIT_HD_MNEMONIC;

  beforeAll(async () => {
    await cleanAll();
    await createUser(USER_C);
    delete process.env.DEPOSIT_HD_MNEMONIC;
  });

  afterAll(async () => {
    process.env.DEPOSIT_HD_MNEMONIC = saved;
    await cleanAll();
  });

  it("getUserDepositAddress returns null (never a fabricated address)", async () => {
    expect(await getUserDepositAddress(USER_C, "TRC20", "USDT")).toBeNull();
    expect(await getUserDepositAddress(USER_C, "BEP20", "USDT")).toBeNull();
  });

  it("getMonitoredAddresses returns an empty list", async () => {
    expect(await getMonitoredAddresses("TRC20", "USDT")).toEqual([]);
  });

  it("getUserIdForAddress returns null for any address", async () => {
    expect(await getUserIdForAddress("TUnknownAddress", "TRC20", "USDT")).toBeNull();
  });

  it("an invalid mnemonic also yields null", async () => {
    process.env.DEPOSIT_HD_MNEMONIC = "this is definitely not a valid bip39 mnemonic phrase";
    expect(await getUserDepositAddress(USER_C, "TRC20", "USDT")).toBeNull();
    process.env.DEPOSIT_HD_MNEMONIC = undefined as unknown as string;
  });
});

// ═══════════════════════════════════════════════════════════════════
// DB-BACKED: PERSISTENCE, REUSE, ATTRIBUTION, CONFIRMATIONS, DEDUP
// ═══════════════════════════════════════════════════════════════════

describe("Deposit address persistence & monitor attribution", () => {
  beforeAll(async () => {
    await cleanAll();
    await createUser(USER_A);
    await createUser(USER_B);
    process.env.DEPOSIT_HD_MNEMONIC = MNEMONIC;
  });

  afterAll(async () => {
    await cleanAll();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanAll();
    await createUser(USER_A);
    await createUser(USER_B);
  });

  it("persists and reuses the same address for a user/network", async () => {
    const first = await getUserDepositAddress(USER_A, "TRC20", "USDT");
    const second = await getUserDepositAddress(USER_A, "TRC20", "USDT");
    expect(first).not.toBeNull();
    expect(second).toBe(first);

    const rows = await prisma.depositAddress.findMany({ where: { userId: USER_A } });
    expect(rows.length).toBe(1);
    expect(rows[0].network).toBe("TRC20");
    expect(rows[0].asset).toBe("USDT");
    expect(rows[0].address).toBe(first);
  });

  it("different users get different persisted addresses; BEP20 stored lowercase", async () => {
    const a = await getUserDepositAddress(USER_A, "BEP20", "USDT");
    const b = await getUserDepositAddress(USER_B, "BEP20", "USDT");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^0x[a-f0-9]{40}$/);
    expect(b).toMatch(/^0x[a-f0-9]{40}$/);
  });

  it("attributes (network, asset, address) -> userId", async () => {
    const addr = await getUserDepositAddress(USER_A, "BEP20", "USDT");
    expect(await getUserIdForAddress(addr!, "BEP20", "USDT")).toBe(USER_A);
    // Case-insensitive for EVM addresses
    expect(await getUserIdForAddress(addr!.toUpperCase(), "BEP20", "USDT")).toBe(USER_A);
    expect(await getUserIdForAddress("0x0000000000000000000000000000000000000000", "BEP20", "USDT")).toBeNull();
  });

  it("getMonitoredAddresses returns the persisted addresses", async () => {
    const a = await getUserDepositAddress(USER_A, "TRC20", "USDT");
    const b = await getUserDepositAddress(USER_B, "TRC20", "USDT");
    const monitored = await getMonitoredAddresses("TRC20", "USDT");
    expect(monitored).toContain(a);
    expect(monitored).toContain(b);
    expect(monitored).toHaveLength(2);
  });

  it("waits for the required confirmations before crediting, then credits exactly once", async () => {
    const addr = await getUserDepositAddress(USER_A, "TRC20", "USDT");
    const txHash = `0xmonitor_conf_${Date.now()}`;

    // 1. Low confirmations -> PENDING, no credit.
    const r1 = await blockchainMonitor.processDeposit({
      txHash, fromAddress: "TFROM", toAddress: addr!, token: "USDT",
      amount: "50", blockNumber: 1, confirmations: 0, network: "TRC20",
    });
    expect(r1).toBeNull();
    let bal = await treasuryService.getBalance(USER_A, "USDT");
    expect(parseFloat(bal.available)).toBe(0);

    const pending = await prisma.blockchainDeposit.findFirst({ where: { txHash } });
    expect(pending?.status).toBe("PENDING");

    // 2. Enough confirmations -> credited once.
    const r2 = await blockchainMonitor.processDeposit({
      txHash, fromAddress: "TFROM", toAddress: addr!, token: "USDT",
      amount: "50", blockNumber: 1, confirmations: 100, network: "TRC20",
    });
    expect(r2).not.toBeNull();
    bal = await treasuryService.getBalance(USER_A, "USDT");
    expect(parseFloat(bal.available)).toBe(50);

    const confirmed = await prisma.blockchainDeposit.findFirst({ where: { txHash } });
    expect(confirmed?.status).toBe("CONFIRMED");

    // 3. Re-processing the same on-chain event must NOT double-credit.
    const r3 = await blockchainMonitor.processDeposit({
      txHash, fromAddress: "TFROM", toAddress: addr!, token: "USDT",
      amount: "50", blockNumber: 1, confirmations: 100, network: "TRC20",
    });
    expect(r3).toBeNull();
    bal = await treasuryService.getBalance(USER_A, "USDT");
    expect(parseFloat(bal.available)).toBe(50); // not 100
  });

  it("credits an already-confirmed deposit directly (single pass, no double credit)", async () => {
    const addr = await getUserDepositAddress(USER_A, "BEP20", "USDT");
    const txHash = `0xmonitor_confirmed_${Date.now()}`;

    const r = await blockchainMonitor.processDeposit({
      txHash, fromAddress: "0xfrom", toAddress: addr!, token: "USDT",
      amount: "25", blockNumber: 5, confirmations: 500, network: "BEP20", logIndex: 3,
    });
    expect(r).not.toBeNull();

    let bal = await treasuryService.getBalance(USER_A, "USDT");
    expect(parseFloat(bal.available)).toBe(25);

    // Duplicate event (same tx + logIndex) -> ignored.
    await blockchainMonitor.processDeposit({
      txHash, fromAddress: "0xfrom", toAddress: addr!, token: "USDT",
      amount: "25", blockNumber: 5, confirmations: 500, network: "BEP20", logIndex: 3,
    });
    bal = await treasuryService.getBalance(USER_A, "USDT");
    expect(parseFloat(bal.available)).toBe(25);
  });
});
