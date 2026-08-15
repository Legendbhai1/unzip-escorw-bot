import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { dealService } from "../src/services/dealService.js";
import { groupService } from "../src/services/groupService.js";
import {
  setAdminSetting,
  getAdminSetting,
  getPaymentInstructionsText,
  hasPaymentInstructions,
  SETTING_KEYS,
  GLOBAL_GROUP_ID,
  UNAVAILABLE_MESSAGE,
} from "../src/lib/paymentInstructions.js";
import { postPaymentInstructionsToGroupCard } from "../src/bot/scenes/dealForm.js";
import { config } from "../src/config/index.js";

// dealForm imports notificationService for other flows; stub it so this file
// stays offline (postPaymentInstructionsToGroupCard never calls it).
vi.mock("../src/services/notificationService.js", () => ({
  notificationService: {
    notifyAdmins: vi.fn().mockResolvedValue(undefined),
    notifyAssignedAdmin: vi.fn().mockResolvedValue(undefined),
  },
}));

const prisma = new PrismaClient();

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const BUYER_ID = "44444444-4444-4444-4444-444444444444";
const SELLER_ID = "55555555-5555-5555-5555-555555555555";
const ADMIN_A = "66666666-6666-6666-6666-666666666666";

const GROUP_A = "-1001111111111";
const GROUP_B = "-1002222222222";

const UPI_A = "upi_a@bank";
const UPI_NAME_A = "Escrow A";
const UPI_B = "upi_b@bank";
const UPI_NAME_B = "Escrow B";
const USDT_A = "0xAddressGroupA00000000000000000000000001";
const USDT_B = "0xAddressGroupB00000000000000000000000002";

async function cleanAll() {
  await prisma.groupAdmin.deleteMany();
  await prisma.groupAuthorization.deleteMany();
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
    create: { id, telegramId: BigInt(telegramId), username, firstName: "SettingsTest", status: "ACTIVE" },
    update: {},
  });
}

async function setGroupUpi(groupId: string, upiId: string, upiName: string) {
  await setAdminSetting(SETTING_KEYS.upiId, upiId, ADMIN_A, groupId);
  await setAdminSetting(SETTING_KEYS.upiName, upiName, ADMIN_A, groupId);
}

async function setGroupUsdt(groupId: string, address: string) {
  await setAdminSetting(SETTING_KEYS.usdtBep20Address, address, ADMIN_A, groupId);
}

/** Create a deal and pin it to a group card (like postDealCardToGroup does). */
async function createDealInGroup(
  method: "INR" | "CRYPTO",
  amount: string,
  groupId: string,
  messageId = 7
) {
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
    description: "Per-group settings test deal",
    category: "FREELANCE_SERVICES",
  });
  await prisma.deal.update({
    where: { id: deal.id },
    data: { groupChatId: groupId, groupMessageId: messageId },
  });
  return deal.id;
}

/** Minimal grammY-like ctx capturing editMessageText (group card edits). */
function makeCardCtx() {
  const edits: Array<{ chatId: string; messageId: number; text: string; opts: any }> = [];
  return {
    api: {
      editMessageText: async (chatId: string, messageId: number, text: string, opts?: any) => {
        edits.push({ chatId: String(chatId), messageId, text, opts });
        return { ok: true };
      },
    },
    _edits: edits,
  };
}

beforeAll(async () => {
  await cleanAll();
});

afterAll(async () => {
  await cleanAll();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await cleanAll();
  await createUser(OWNER_ID, "bot_owner", "1111111111");
  await createUser(BUYER_ID, "buyer_user", "4444444441");
  await createUser(SELLER_ID, "seller_user", "5555555551");
  await createUser(ADMIN_A, "admin_a", "6666666661");
});

// ═══════════════════════════════════════════════════════════════════
// PER-GROUP PAYMENT SETTINGS ISOLATION
// Group A can never display Group B's payment details (and vice versa).
// ═══════════════════════════════════════════════════════════════════

describe("per-group payment settings isolation", () => {
  it("Group A's deal shows Group A's UPI, never Group B's", async () => {
    await groupService.approveGroup(GROUP_A, "Escrow Group A", OWNER_ID);
    await groupService.approveGroup(GROUP_B, "Escrow Group B", OWNER_ID);
    await setGroupUpi(GROUP_A, UPI_A, UPI_NAME_A);
    await setGroupUpi(GROUP_B, UPI_B, UPI_NAME_B);

    const dealA = await dealService.findWithParties(await createDealInGroup("INR", "10000", GROUP_A));
    const dealB = await dealService.findWithParties(await createDealInGroup("INR", "5000", GROUP_B));

    const insA = await getPaymentInstructionsText(dealA!);
    expect(insA).toContain(UPI_A);
    expect(insA).toContain(UPI_NAME_A);
    expect(insA).not.toContain(UPI_B);

    const insB = await getPaymentInstructionsText(dealB!);
    expect(insB).toContain(UPI_B);
    expect(insB).toContain(UPI_NAME_B);
    expect(insB).not.toContain(UPI_A);

    // The settings rows themselves are scoped correctly.
    expect(await getAdminSetting(SETTING_KEYS.upiId, GROUP_A)).toBe(UPI_A);
    expect(await getAdminSetting(SETTING_KEYS.upiId, GROUP_B)).toBe(UPI_B);
  });

  it("Group A's crypto deal shows Group A's USDT BEP20 address, never Group B's", async () => {
    await groupService.approveGroup(GROUP_A, "Escrow Group A", OWNER_ID);
    await groupService.approveGroup(GROUP_B, "Escrow Group B", OWNER_ID);
    await setGroupUsdt(GROUP_A, USDT_A);
    await setGroupUsdt(GROUP_B, USDT_B);

    const dealA = await dealService.findWithParties(await createDealInGroup("CRYPTO", "100", GROUP_A));
    const dealB = await dealService.findWithParties(await createDealInGroup("CRYPTO", "200", GROUP_B));

    const insA = await getPaymentInstructionsText(dealA!);
    expect(insA).toContain(USDT_A);
    expect(insA).toContain("BEP20");
    expect(insA).not.toContain(USDT_B);

    const insB = await getPaymentInstructionsText(dealB!);
    expect(insB).toContain(USDT_B);
    expect(insB).not.toContain(USDT_A);
  });

  it("a group without USDT BEP20 configured reports the payment as unavailable", async () => {
    await groupService.approveGroup(GROUP_A, "Escrow Group A", OWNER_ID);
    await groupService.approveGroup(GROUP_B, "Escrow Group B", OWNER_ID);
    await setGroupUsdt(GROUP_A, USDT_A);
    // Group B has NO own USDT address — and no env fallback (nulled below).

    const savedEnv = config.escrow.cryptoAddresses["USDT_BEP20"];
    (config as any).escrow.cryptoAddresses["USDT_BEP20"] = "";
    try {
      const dealB = await dealService.findWithParties(await createDealInGroup("CRYPTO", "100", GROUP_B));
      expect(await hasPaymentInstructions(dealB!)).toBe(false);
      expect(await getPaymentInstructionsText(dealB!)).toBe(UNAVAILABLE_MESSAGE);
      expect(await getPaymentInstructionsText(dealB!)).not.toContain(USDT_A);
    } finally {
      (config as any).escrow.cryptoAddresses["USDT_BEP20"] = savedEnv;
    }
  });

  it("a group without UPI configured reports the payment as unavailable", async () => {
    await groupService.approveGroup(GROUP_A, "Escrow Group A", OWNER_ID);
    await groupService.approveGroup(GROUP_B, "Escrow Group B", OWNER_ID);
    await setGroupUpi(GROUP_B, UPI_B, UPI_NAME_B);

    const savedEnvId = config.escrow.upiId;
    const savedEnvName = config.escrow.upiName;
    (config as any).escrow.upiId = "";
    (config as any).escrow.upiName = "";
    try {
      const dealA = await dealService.findWithParties(await createDealInGroup("INR", "10000", GROUP_A));
      expect(await hasPaymentInstructions(dealA!)).toBe(false);
      expect(await getPaymentInstructionsText(dealA!)).toBe(UNAVAILABLE_MESSAGE);
      expect(await getPaymentInstructionsText(dealA!)).not.toContain(UPI_B);
    } finally {
      (config as any).escrow.upiId = savedEnvId;
      (config as any).escrow.upiName = savedEnvName;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// END-TO-END: /allowgroup → /settings → deal → agree ×2 → admin accept
// → the GROUP CARD shows that group's own payment instructions + [I've Paid]
// ═══════════════════════════════════════════════════════════════════

describe("group card payment instructions after admin acceptance (end-to-end)", () => {
  it("posting instructions to the card uses the deal's group settings and never leaks Group B's", async () => {
    // /allowgroup + group escrow admin for Group A.
    await groupService.approveGroup(GROUP_A, "Escrow Group A", OWNER_ID);
    await groupService.addGroupAdmin(GROUP_A, ADMIN_A, OWNER_ID);
    // Group B exists with DIFFERENT details — must never leak into A.
    await groupService.approveGroup(GROUP_B, "Escrow Group B", OWNER_ID);
    await setGroupUpi(GROUP_B, UPI_B, UPI_NAME_B);

    // /settings for Group A (only A's own details are entered).
    await setGroupUpi(GROUP_A, UPI_A, UPI_NAME_A);

    // /form → deal card posted to Group A.
    const dealId = await createDealInGroup("INR", "10000", GROUP_A, 42);

    // Both parties agree on the group card.
    await dealService.agreeToDeal(dealId, BUYER_ID);
    await dealService.agreeToDeal(dealId, SELLER_ID);

    // Group escrow admin A accepts the deal.
    await dealService.adminAccept(dealId, ADMIN_A);

    const deal = await dealService.findWithParties(dealId);
    expect(deal?.status).toBe("AWAITING_PAYMENT");
    expect(deal?.acceptedBy).toBe(ADMIN_A);

    const ctx = makeCardCtx();
    await postPaymentInstructionsToGroupCard(ctx as any, deal, "admin_a");

    expect(ctx._edits).toHaveLength(1);
    const { chatId, messageId, text, opts } = ctx._edits[0];
    expect(chatId).toBe(GROUP_A);
    expect(messageId).toBe(42);

    // The card itself is the payment instructions.
    expect(text).toContain("ESCROW DEAL #");
    expect(text).toContain("PAYMENT REQUIRED");
    expect(text).toContain("Accepted by: @admin_a");
    expect(text).toContain("INR / UPI");
    expect(text).toContain("₹10,100.00"); // amount + 1% buyer fee
    expect(text).toContain(UPI_A);        // Group A's own UPI ID
    expect(text).toContain(UPI_NAME_A);
    expect(text).not.toContain(UPI_B);    // never Group B's
    expect(text).not.toContain(UPI_NAME_B);

    // [I've Paid] is on the group card, wired to this exact deal.
    const kb = (opts?.reply_markup as any)?.inline_keyboard ?? [];
    const flat = kb.flat().map((b: any) => b.callback_data);
    expect(flat).toContain(`deal:paid:${dealId}`);
    expect(flat).toContain(`deal:status:${dealId}`);

    // Audit trail records the instructions were posted.
    const audit = await prisma.escrowAuditLog.findFirst({
      where: { dealId, action: "PAYMENT_INSTRUCTIONS_SENT" },
    });
    expect(audit).not.toBeNull();
  });

  it("a USDT deal posts the group's USDT BEP20 address on the card", async () => {
    await groupService.approveGroup(GROUP_A, "Escrow Group A", OWNER_ID);
    await groupService.approveGroup(GROUP_B, "Escrow Group B", OWNER_ID);
    await setGroupUsdt(GROUP_A, USDT_A);
    await setGroupUsdt(GROUP_B, USDT_B);

    const dealId = await createDealInGroup("CRYPTO", "100", GROUP_A, 43);
    await dealService.agreeToDeal(dealId, BUYER_ID);
    await dealService.agreeToDeal(dealId, SELLER_ID);
    await dealService.adminAccept(dealId, ADMIN_A);

    const deal = await dealService.findWithParties(dealId);
    const ctx = makeCardCtx();
    await postPaymentInstructionsToGroupCard(ctx as any, deal, "admin_a");

    const text = ctx._edits[0].text;
    expect(text).toContain("USDT BEP20");
    expect(text).toContain(USDT_A);
    expect(text).not.toContain(USDT_B);
    expect(text).toContain("100 USDT");
  });
});
