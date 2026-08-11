import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { groupService } from "../src/services/groupService.js";
import { dealService } from "../src/services/dealService.js";
import { config, isBotOwner } from "../src/config/index.js";

const prisma = new PrismaClient();

// ── Fixed IDs (mirror manualEscrow.test.ts conventions) ────────────────
const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const BUYER_ID = "44444444-4444-4444-4444-444444444444";
const SELLER_ID = "55555555-5555-5555-5555-555555555555";
const ADMIN_A_ID = "66666666-6666-6666-6666-666666666666";
const ADMIN_B_ID = "77777777-7777-7777-7777-777777777777";
const NORMAL_ID = "88888888-8888-8888-8888-888888888888";

const GROUP_A = "-1001111111111";
const GROUP_B = "-1002222222222";

// Telegram IDs are kept under 2^53 so Number↔BigInt round-trips are exact
// (real Telegram user IDs are ~9-10 digits, so this mirrors production).
const OWNER_TID = BigInt(config.botOwnerTelegramId);
const BUYER_TID = 4400000001n;
const SELLER_TID = 5500000001n;
const ADMIN_A_TID = 6600000001n;
const ADMIN_B_TID = 7700000001n;
const NORMAL_TID = 8800000001n;

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

async function createUser(id: string, username: string, telegramId: bigint) {
  await prisma.user.upsert({
    where: { id },
    create: { id, telegramId, username, firstName: "GroupTest", status: "ACTIVE" },
    update: {},
  });
}

async function createDeal(amount = "10000") {
  return dealService.create({
    buyerUserId: BUYER_ID,
    sellerUserId: SELLER_ID,
    sellerUsername: "seller_user",
    amount,
    asset: "INR",
    network: "UPI",
    paymentMethod: "INR",
    currency: "INR",
    description: "Group authorization test deal",
    category: "FREELANCE_SERVICES",
    dealDuration: "7 days",
    releaseCondition: "After the buyer receives and approves the work.",
    refundCondition: "If the seller does not deliver within 7 days.",
  });
}

/** Simulate the posted group card: attach groupChatId + groupMessageId. */
async function postCardToGroup(dealId: string, groupId: string, messageId = 42) {
  return prisma.deal.update({
    where: { id: dealId },
    data: { groupChatId: groupId, groupMessageId: messageId },
  });
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
  await createUser(OWNER_ID, "bot_owner", OWNER_TID);
  await createUser(BUYER_ID, "buyer_user", BUYER_TID);
  await createUser(SELLER_ID, "seller_user", SELLER_TID);
  await createUser(ADMIN_A_ID, "admin_a", ADMIN_A_TID);
  await createUser(ADMIN_B_ID, "admin_b", ADMIN_B_TID);
  await createUser(NORMAL_ID, "normal_user", NORMAL_TID);
});

// ═══════════════════════════════════════════════════════════════════
// GROUP AUTHORIZATION (/allowgroup, /disallowgroup)
// ═══════════════════════════════════════════════════════════════════

describe("Group authorization", () => {
  it("is not approved before /allowgroup and approved + persisted afterwards", async () => {
    expect(await groupService.isGroupApproved(GROUP_A)).toBe(false);

    await groupService.approveGroup(GROUP_A, "Escrow Group A", OWNER_ID);
    expect(await groupService.isGroupApproved(GROUP_A)).toBe(true);

    const row = await prisma.groupAuthorization.findUnique({ where: { groupId: GROUP_A } });
    expect(row?.status).toBe("APPROVED");
    expect(row?.allowedBy).toBe(OWNER_ID);
    expect(row?.allowedAt).not.toBeNull();
    expect(row?.groupTitle).toBe("Escrow Group A");
  });

  it("re-approving an approved group is idempotent", async () => {
    await groupService.approveGroup(GROUP_A, "A", OWNER_ID);
    await groupService.approveGroup(GROUP_A, "A", OWNER_ID);
    const rows = await prisma.groupAuthorization.count({ where: { groupId: GROUP_A } });
    expect(rows).toBe(1);
    expect(await groupService.isGroupApproved(GROUP_A)).toBe(true);
  });

  it("/disallowgroup disables escrow ops but keeps existing data intact", async () => {
    await groupService.approveGroup(GROUP_A, "Escrow Group A", OWNER_ID);
    const deal = await createDeal();
    await postCardToGroup(deal.id, GROUP_A);
    const userBefore = await prisma.user.count();

    await groupService.disallowGroup(GROUP_A, OWNER_ID);

    expect(await groupService.isGroupApproved(GROUP_A)).toBe(false);
    // Nothing deleted — deals, users and the group row all remain.
    expect((await prisma.deal.findUnique({ where: { id: deal.id } }))?.status).toBe("CREATED");
    expect(await prisma.user.count()).toBe(userBefore);
    expect((await prisma.groupAuthorization.findUnique({ where: { groupId: GROUP_A } }))?.status).toBe("DISALLOWED");
  });

  it("re-approving after disallow clears the disallow state", async () => {
    await groupService.approveGroup(GROUP_A, "A", OWNER_ID);
    await groupService.disallowGroup(GROUP_A, OWNER_ID);
    await groupService.approveGroup(GROUP_A, "A", OWNER_ID);
    const row = await prisma.groupAuthorization.findUnique({ where: { groupId: GROUP_A } });
    expect(row?.status).toBe("APPROVED");
    expect(row?.disallowedAt).toBeNull();
    expect(await groupService.isGroupApproved(GROUP_A)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP-SPECIFIC ESCROW ADMINS (/addadmin, /removeadmin, /groupadmins)
// ═══════════════════════════════════════════════════════════════════

describe("Group-specific escrow admins", () => {
  // Admins can only be assigned to groups that exist (are authorized) — this
  // mirrors the /allowgroup → /addadmin owner flow.
  beforeEach(async () => {
    await groupService.approveGroup(GROUP_A, "Escrow Group A", OWNER_ID);
    await groupService.approveGroup(GROUP_B, "Escrow Group B", OWNER_ID);
  });

  it("addGroupAdmin assigns an ACTIVE admin scoped to one group", async () => {
    await groupService.addGroupAdmin(GROUP_A, ADMIN_A_ID, OWNER_ID);

    expect(await groupService.isActiveGroupAdmin(GROUP_A, ADMIN_A_TID)).toBe(true);
    expect(await groupService.isActiveGroupAdmin(GROUP_B, ADMIN_A_TID)).toBe(false);

    const rows = await prisma.groupAdmin.findMany({ where: { groupId: GROUP_A, userId: ADMIN_A_ID } });
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("ACTIVE");
    expect(rows[0].assignedBy).toBe(OWNER_ID);
    expect(rows[0].assignedAt).not.toBeNull();
  });

  it("removeGroupAdmin soft-removes and keeps history", async () => {
    await groupService.addGroupAdmin(GROUP_A, ADMIN_A_ID, OWNER_ID);
    const removed = await groupService.removeGroupAdmin(GROUP_A, ADMIN_A_ID, OWNER_ID);
    expect(removed).toBe(1);

    expect(await groupService.isActiveGroupAdmin(GROUP_A, ADMIN_A_TID)).toBe(false);
    const rows = await prisma.groupAdmin.findMany({ where: { groupId: GROUP_A, userId: ADMIN_A_ID } });
    expect(rows.length).toBe(1); // history kept
    expect(rows[0].status).toBe("REMOVED");
    expect(rows[0].removedAt).not.toBeNull();

    // Removing again is a no-op.
    expect(await groupService.removeGroupAdmin(GROUP_A, ADMIN_A_ID, OWNER_ID)).toBe(0);
  });

  it("re-adding a removed admin reactivates the same row (no duplicates)", async () => {
    await groupService.addGroupAdmin(GROUP_A, ADMIN_A_ID, OWNER_ID);
    await groupService.removeGroupAdmin(GROUP_A, ADMIN_A_ID, OWNER_ID);
    await groupService.addGroupAdmin(GROUP_A, ADMIN_A_ID, OWNER_ID);

    expect(await groupService.isActiveGroupAdmin(GROUP_A, ADMIN_A_TID)).toBe(true);
    const rows = await prisma.groupAdmin.findMany({ where: { groupId: GROUP_A, userId: ADMIN_A_ID } });
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("ACTIVE");
  });

  it("listGroupAdmins returns only ACTIVE admins with user info", async () => {
    await groupService.addGroupAdmin(GROUP_A, ADMIN_A_ID, OWNER_ID);
    await groupService.addGroupAdmin(GROUP_A, ADMIN_B_ID, OWNER_ID);
    await groupService.removeGroupAdmin(GROUP_A, ADMIN_B_ID, OWNER_ID);

    const list = await groupService.listGroupAdmins(GROUP_A);
    expect(list.length).toBe(1);
    expect(list[0].userId).toBe(ADMIN_A_ID);
    expect(list[0].user.username).toBe("admin_a");
  });

  it("an admin of one group gains NO powers in another group", async () => {
    await groupService.addGroupAdmin(GROUP_A, ADMIN_A_ID, OWNER_ID);
    expect(await groupService.isAuthorizedForGroup(Number(ADMIN_A_TID), GROUP_A)).toBe(true);
    expect(await groupService.isAuthorizedForGroup(Number(ADMIN_A_TID), GROUP_B)).toBe(false);
  });

  it("bot owner is authorized everywhere; normal users are not", async () => {
    expect(isBotOwner(Number(OWNER_TID))).toBe(true);
    expect(await groupService.isAuthorizedForGroup(Number(OWNER_TID), GROUP_A)).toBe(true);
    expect(await groupService.isAuthorizedForGroup(Number(OWNER_TID), GROUP_B)).toBe(true);
    expect(await groupService.isAuthorizedForGroup(Number(NORMAL_TID), GROUP_A)).toBe(false);
    expect(await groupService.isAuthorizedForGroup(Number(BUYER_TID), GROUP_A)).toBe(false);
    expect(await groupService.isAuthorizedForGroup(Number(ADMIN_A_TID), undefined)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// PARTY AGREEMENT + ADMIN ACCEPTANCE
// ═══════════════════════════════════════════════════════════════════

describe("Party agreement and admin acceptance", () => {
  it("records terms + deadline at creation; agreement is recorded per party", async () => {
    const deal = await createDeal();
    expect(deal.dealDuration).toBe("7 days");
    expect(deal.dealDeadlineAt).not.toBeNull();
    expect(deal.releaseCondition).toContain("receives");
    expect(deal.refundCondition).toContain("7 days");
    expect(deal.buyerAgreedAt).toBeNull();
    expect(deal.sellerAgreedAt).toBeNull();

    const buyerRes = await dealService.agreeToDeal(deal.id, BUYER_ID);
    expect(buyerRes.agreedBy).toBe("BUYER");
    expect(buyerRes.bothAgreed).toBe(false);

    const afterBuyer = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(afterBuyer?.buyerAgreedAt).not.toBeNull();
    expect(afterBuyer?.sellerAgreedAt).toBeNull();

    const sellerRes = await dealService.agreeToDeal(deal.id, SELLER_ID);
    expect(sellerRes.agreedBy).toBe("SELLER");
    expect(sellerRes.bothAgreed).toBe(true);

    const audit = await prisma.escrowAuditLog.findMany({ where: { dealId: deal.id, action: "DEAL_AGREED" } });
    expect(audit.length).toBe(2);
  });

  it("rejects agreement from someone who is not a party", async () => {
    const deal = await createDeal();
    await expect(dealService.agreeToDeal(deal.id, NORMAL_ID)).rejects.toThrow(/buyer or seller/);
    await expect(dealService.agreeToDeal(deal.id, ADMIN_A_ID)).rejects.toThrow(/buyer or seller/);
  });

  it("rejects a second agreement from the same party", async () => {
    const deal = await createDeal();
    await dealService.agreeToDeal(deal.id, BUYER_ID);
    await expect(dealService.agreeToDeal(deal.id, BUYER_ID)).rejects.toThrow(/already agreed/);
  });

  it("posted terms are immutable once agreed (no edit path changes them)", async () => {
    const deal = await createDeal();
    const before = await prisma.deal.findUnique({ where: { id: deal.id } });
    await dealService.agreeToDeal(deal.id, BUYER_ID);
    const after = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(after?.description).toBe(before?.description);
    expect(after?.releaseCondition).toBe(before?.releaseCondition);
    expect(after?.refundCondition).toBe(before?.refundCondition);
    expect(after?.dealDuration).toBe(before?.dealDuration);
  });

  it("admin cannot accept until BOTH parties agree (server-side)", async () => {
    const deal = await createDeal();
    await expect(dealService.adminAccept(deal.id, ADMIN_A_ID)).rejects.toThrow(/both parties must agree/i);

    await dealService.agreeToDeal(deal.id, BUYER_ID);
    await expect(dealService.adminAccept(deal.id, ADMIN_A_ID)).rejects.toThrow(/both parties must agree/i);

    await dealService.agreeToDeal(deal.id, SELLER_ID);
    await dealService.adminAccept(deal.id, ADMIN_A_ID);
    expect((await prisma.deal.findUnique({ where: { id: deal.id } }))?.status).toBe("AWAITING_PAYMENT");
  });

  it("a second admin cannot accept an already-accepted deal", async () => {
    const deal = await createDeal();
    await postCardToGroup(deal.id, GROUP_A);
    await dealService.agreeToDeal(deal.id, BUYER_ID);
    await dealService.agreeToDeal(deal.id, SELLER_ID);

    await dealService.adminAccept(deal.id, ADMIN_A_ID);
    await expect(dealService.adminAccept(deal.id, ADMIN_B_ID)).rejects.toThrow(/already been accepted/);

    const updated = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(updated?.acceptedBy).toBe(ADMIN_A_ID);
  });

  it("groupId/groupMessageId stay attached to the deal after acceptance", async () => {
    const deal = await createDeal();
    await postCardToGroup(deal.id, GROUP_A, 123);
    await dealService.agreeToDeal(deal.id, BUYER_ID);
    await dealService.agreeToDeal(deal.id, SELLER_ID);
    await dealService.adminAccept(deal.id, ADMIN_A_ID);

    const updated = await prisma.deal.findUnique({ where: { id: deal.id } });
    expect(updated?.groupChatId).toBe(GROUP_A);
    expect(updated?.groupMessageId).toBe(123);
    expect(updated?.status).toBe("AWAITING_PAYMENT");
  });
});
