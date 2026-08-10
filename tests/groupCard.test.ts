import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { buildDealCard } from "../src/bot/scenes/dealForm.js";
import { userMention } from "../src/lib/html.js";
import { getEscrowGroupId, getAdminSetting, SETTING_KEYS } from "../src/lib/paymentInstructions.js";

const prisma = new PrismaClient();
const ADMIN_ID = "66666666-6666-6666-6666-666666666666";

async function cleanSettings() {
  await prisma.adminSetting.deleteMany();
  await prisma.user.deleteMany();
}

beforeAll(async () => {
  await cleanSettings();
  await prisma.user.upsert({
    where: { id: ADMIN_ID },
    create: { id: ADMIN_ID, telegramId: BigInt("660000000000000001"), username: "admin_user", firstName: "AdminTest", status: "ACTIVE" },
    update: {},
  });
});

afterAll(async () => {
  await cleanSettings();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await cleanSettings();
  await prisma.user.upsert({
    where: { id: ADMIN_ID },
    create: { id: ADMIN_ID, telegramId: BigInt("660000000000000001"), username: "admin_user", firstName: "AdminTest", status: "ACTIVE" },
    update: {},
  });
});

function sampleDeal(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    inviteCode: "ABC12345",
    amount: "10000",
    asset: "INR",
    paymentMethod: "INR",
    cryptoPayer: null,
    category: "FREELANCE_SERVICES",
    description: "Logo design <script>alert(1)</script>",
    buyerFeeAmount: "100",
    sellerFeeAmount: "100",
    status: "CREATED",
    ...overrides,
  };
}

describe("buildDealCard (group deal card)", () => {
  it("renders buyer/seller as clickable tg://user mentions", () => {
    const card = buildDealCard(
      sampleDeal(),
      { username: "buyer_user", telegramId: 440000000000000001n },
      { username: "seller_user", telegramId: 550000000000000001n },
      "WAITING FOR ADMIN"
    );
    expect(card).toContain('<a href="tg://user?id=440000000000000001">@buyer_user</a>');
    expect(card).toContain('<a href="tg://user?id=550000000000000001">@seller_user</a>');
    expect(card).toContain("ESCROW DEAL #ABC12345");
    expect(card).toContain("Status: <b>WAITING FOR ADMIN</b>");
    expect(card).toContain("INR / UPI");
  });

  it("escapes user-provided text in the card (description/category)", () => {
    const card = buildDealCard(sampleDeal(), { username: "buyer_user", telegramId: 1n }, { username: null, telegramId: 2n });
    expect(card).toContain("Logo design &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(card).not.toContain("<script>");
  });

  it("falls back to N/A for parties without a username/id", () => {
    const card = buildDealCard(sampleDeal(), null, { username: null, telegramId: null });
    expect(card).toContain("Buyer: N/A");
    expect(card).toContain("Seller: N/A");
  });

  it("shows crypto payer line for USDT BEP20 deals", () => {
    const card = buildDealCard(
      sampleDeal({ asset: "USDT", paymentMethod: "CRYPTO", cryptoPayer: "SELLER", amount: "100", buyerFeeAmount: "1", sellerFeeAmount: "1" }),
      { username: "buyer_user", telegramId: 1n },
      { username: "seller_user", telegramId: 2n }
    );
    expect(card).toContain("USDT BEP20");
    expect(card).toContain("Crypto payer: <b>Seller</b>");
  });
});

describe("userMention helper", () => {
  it("builds a tg://user link with escaped username", () => {
    expect(userMention(123456789n, "john_doe")).toBe('<a href="tg://user?id=123456789">@john_doe</a>');
  });

  it("escapes a malicious username inside the link label", () => {
    expect(userMention(1n, '"><b>')).toBe('<a href="tg://user?id=1">@"&gt;&lt;b&gt;</a>');
  });

  it("falls back to plain text when the id is missing", () => {
    expect(userMention(undefined, "john_doe")).toBe("@john_doe");
    expect(userMention(null, null)).toBe("N/A");
    expect(userMention("", null, "anon")).toBe("anon");
  });
});

describe("escrow group id setting (runtime configurable, env fallback)", () => {
  it("returns the admin-entered escrow_group_id from the DB", async () => {
    await prisma.adminSetting.upsert({
      where: { key: SETTING_KEYS.escrowGroupId },
      create: { key: SETTING_KEYS.escrowGroupId, value: "-1001234567890", updatedBy: ADMIN_ID },
      update: { value: "-1001234567890", updatedBy: ADMIN_ID },
    });
    expect(await getAdminSetting(SETTING_KEYS.escrowGroupId)).toBe("-1001234567890");
    expect(await getEscrowGroupId()).toBe("-1001234567890");
  });

  it("returns empty string when neither setting nor env is configured", async () => {
    expect(await getEscrowGroupId()).toBe("");
  });
});
