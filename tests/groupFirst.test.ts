import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { groupService } from "../src/services/groupService.js";
import { dealService } from "../src/services/dealService.js";
import { setAdminSetting, SETTING_KEYS, GLOBAL_GROUP_ID } from "../src/lib/paymentInstructions.js";
import { startDealForm, createDealFromForm } from "../src/bot/scenes/dealForm.js";
import { handleDispute } from "../src/bot/scenes/depositDeliveryRelease.js";
import { resolveDealFromContext } from "../src/bot/index.js";

// The group-first tests exercise the bot handlers, which notify parties via
// notificationService -> real Telegram API. Stub it so tests stay offline.
vi.mock("../src/services/notificationService.js", () => ({
  notificationService: {
    notifyDealCreated: vi.fn().mockResolvedValue(undefined),
    notifyAdmins: vi.fn().mockResolvedValue(undefined),
  },
}));

const prisma = new PrismaClient();

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const BUYER_ID = "44444444-4444-4444-4444-444444444444";
const SELLER_ID = "55555555-5555-5555-5555-555555555555";
const ADMIN_ID = "66666666-6666-6666-6666-666666666666";

const GROUP_A = "-1001111111111";
const GROUP_B = "-1002222222222";

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
    create: { id, telegramId: BigInt(telegramId), username, firstName: "GroupFirstTest", status: "ACTIVE" },
    update: {},
  });
}

async function createGroupDeal(groupId: string, messageId = 42) {
  const deal = await dealService.create({
    buyerUserId: BUYER_ID,
    sellerUserId: SELLER_ID,
    sellerUsername: "seller_user",
    amount: "10000",
    asset: "INR",
    network: "UPI",
    paymentMethod: "INR",
    currency: "INR",
    description: "Group-first test deal",
    category: "FREELANCE_SERVICES",
    dealDuration: "7 days",
    releaseCondition: "After the buyer approves.",
    refundCondition: "If the seller does not deliver.",
  });
  await prisma.deal.update({
    where: { id: deal.id },
    data: { groupChatId: groupId, groupMessageId: messageId },
  });
  return deal.id;
}

/** Minimal grammY-like ctx for the form handlers (only what they touch). */
function makeFormCtx(chatType: string, chatId: string, session: Record<string, unknown> = {}) {
  const replies: string[] = [];
  return {
    chat: { id: chatId, type: chatType },
    from: { id: 6600000001, is_bot: false },
    session,
    reply: async (text: string) => { replies.push(text); return { message_id: 1 }; },
    api: {},
    answerCallbackQuery: async () => {},
    _replies: replies,
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
  await createUser(ADMIN_ID, "admin_user", "6666666661");
});

// ═══════════════════════════════════════════════════════════════════
// 1. /form and "form" in the authorized group + deal posted there
// ═══════════════════════════════════════════════════════════════════

describe("deal form group-first behavior", () => {
  it("refuses to start the form in an unauthorized group (no steps wasted)", async () => {
    // GROUP_B is never approved.
    const session: Record<string, unknown> = {};
    const ctx = makeFormCtx("supergroup", GROUP_B, session);
    await startDealForm(ctx as any);
    expect(ctx._replies.join("\n")).toContain("not authorized");
    expect(session.createDealStep).toBeUndefined();
    expect(session.createDealTargetGroupId).toBeUndefined();
  });

  it("starts the form in an approved group and remembers it as the posting target", async () => {
    await groupService.approveGroup(GROUP_A, "Escrow Group A", OWNER_ID);
    const session: Record<string, unknown> = {};
    const ctx = makeFormCtx("supergroup", GROUP_A, session);
    await startDealForm(ctx as any);
    expect(session.createDealStep).toBe("payment_method");
    expect(session.createDealTargetGroupId).toBe(GROUP_A);
  });

  it("leaves the posting target unset for DM-started forms (falls back to configured group)", async () => {
    const session: Record<string, unknown> = {};
    const ctx = makeFormCtx("private", "7700000001", session);
    await startDealForm(ctx as any);
    expect(session.createDealStep).toBe("payment_method");
    expect(session.createDealTargetGroupId).toBeUndefined();
  });

  it("posts the deal card to the group where the form ran — even when escrow_group_id points elsewhere", async () => {
    await groupService.approveGroup(GROUP_A, "Escrow Group A", OWNER_ID);
    // Admin-configured escrow group is GROUP_B — the form's own group must win.
    await setAdminSetting(SETTING_KEYS.escrowGroupId, GROUP_B, ADMIN_ID, GLOBAL_GROUP_ID);

    const sent: string[] = [];
    const ctx = makeFormCtx("supergroup", GROUP_A, {
      userId: BUYER_ID,
      username: "buyer_user",
      createDealStep: "preview",
      createDealPaymentMethod: "INR",
      createDealRole: "buyer",
      createDealCounterpartyUsername: "seller_user",
      createDealCounterpartyUserId: SELLER_ID,
      createDealAmount: "10000",
      createDealAsset: "INR",
      createDealNetwork: "UPI",
      createDealDescription: "Test deal",
      createDealCategory: "FREELANCE_SERVICES",
      createDealDuration: "7 days",
      createDealReleaseCondition: "After approval",
      createDealRefundCondition: "If not delivered",
      createDealTargetGroupId: GROUP_A,
      flowToken: "tok123456",
      flowChatId: GROUP_A,
      flowExpiresAt: Date.now() + 60_000,
    });
    ctx.api = {
      sendMessage: async (chatId: string) => {
        sent.push(String(chatId));
        return { chat: { id: chatId }, message_id: 7 };
      },
    };

    await createDealFromForm(ctx as any);

    expect(sent).toContain(GROUP_A);
    expect(sent).not.toContain(GROUP_B);
    const deal = await prisma.deal.findFirst({ orderBy: { createdAt: "desc" } });
    expect(deal).not.toBeNull();
    expect(deal!.groupChatId).toBe(GROUP_A);
    expect(deal!.groupMessageId).toBe(7);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. /release & /refund resolve the deal from the CURRENT group only
// ═══════════════════════════════════════════════════════════════════

describe("resolveDealFromContext (group-first release/refund context)", () => {
  it("resolves the deal by replying to its card in the same group", async () => {
    const dealId = await createGroupDeal(GROUP_A, 42);
    const ctx = {
      chat: { id: GROUP_A, type: "supergroup" },
      session: { lastDealId: undefined },
      message: { reply_to_message: { message_id: 42, from: { is_bot: true } } },
    };
    const deal = await resolveDealFromContext(ctx as any);
    expect(deal?.id).toBe(dealId);
  });

  it("never resolves a Group B deal from Group A via lastDealId", async () => {
    const dealId = await createGroupDeal(GROUP_A);
    const ctx = {
      chat: { id: GROUP_B, type: "supergroup" },
      session: { lastDealId: dealId },
      message: { reply_to_message: undefined },
    };
    expect(await resolveDealFromContext(ctx as any)).toBeNull();
  });

  it("never resolves a Group B deal from Group A via a deal-code argument", async () => {
    const deal = await dealService.create({
      buyerUserId: BUYER_ID,
      sellerUserId: SELLER_ID,
      sellerUsername: "seller_user",
      amount: "10000",
      asset: "INR",
      network: "UPI",
      paymentMethod: "INR",
      currency: "INR",
      description: "Code-arg deal",
      category: "FREELANCE_SERVICES",
    });
    await prisma.deal.update({
      where: { id: deal.id },
      data: { groupChatId: GROUP_B, groupMessageId: 1 },
    });
    const ctx = {
      chat: { id: GROUP_A, type: "supergroup" },
      session: { lastDealId: undefined },
      message: { reply_to_message: undefined },
    };
    expect(await resolveDealFromContext(ctx as any, deal.inviteCode)).toBeNull();
  });

  it("resolves lastDealId in DM (documented convenience)", async () => {
    const dealId = await createGroupDeal(GROUP_A);
    const ctx = {
      chat: { id: "7700000001", type: "private" },
      session: { lastDealId: dealId },
      message: { reply_to_message: undefined },
    };
    const deal = await resolveDealFromContext(ctx as any);
    expect(deal?.id).toBe(dealId);
  });

  it("resolves lastDealId inside the deal's own group", async () => {
    const dealId = await createGroupDeal(GROUP_A);
    const ctx = {
      chat: { id: GROUP_A, type: "supergroup" },
      session: { lastDealId: dealId },
      message: { reply_to_message: undefined },
    };
    const deal = await resolveDealFromContext(ctx as any);
    expect(deal?.id).toBe(dealId);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Dispute capture is chat-bound (stale question cannot eat a later
//    message typed in another chat)
// ═══════════════════════════════════════════════════════════════════

describe("dispute capture chat binding", () => {
  it("binds the dispute-reason capture to the chat where the prompt was sent", async () => {
    const session: Record<string, unknown> = {};
    const ctx = {
      session,
      chat: { id: GROUP_A, type: "supergroup" },
      reply: async () => ({ message_id: 1 }),
    };
    await handleDispute(ctx as any, "deal-123");
    expect(session.pendingDisputeDealId).toBe("deal-123");
    expect(session.pendingFlowChatId).toBe(GROUP_A);
  });
});
