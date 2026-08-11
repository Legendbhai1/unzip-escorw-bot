import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { splitCallbackToken, isDealChatValid, isFlowChatValid, isFlowExpired, newFlowToken } from "../src/lib/flow.js";
import { isFormCallbackCurrent, STEP_FOR_ACTION } from "../src/bot/scenes/dealForm.js";
import {
  getAdminSetting, setAdminSetting, deleteAdminSetting,
  getPaymentInstructionsText, hasPaymentInstructions, SETTING_KEYS, GLOBAL_GROUP_ID,
} from "../src/lib/paymentInstructions.js";

const prisma = new PrismaClient();

const ADMIN_ID = "99999999-9999-4999-8999-999999999999";
const GROUP_A = "-1001111111111";
const GROUP_B = "-1002222222222";

async function cleanSettings() {
  await prisma.adminSetting.deleteMany();
}

beforeAll(async () => {
  await cleanSettings();
  await prisma.user.upsert({
    where: { id: ADMIN_ID },
    create: { id: ADMIN_ID, telegramId: BigInt("9900000000000099"), username: "security_admin", firstName: "SecurityTest", status: "ACTIVE" },
    update: {},
  });
});

afterAll(async () => {
  await cleanSettings();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await cleanSettings();
});

// ═══════════════════════════════════════════════════════════════════
// FLOW TOKENS / STALE BUTTONS (pure)
// ═══════════════════════════════════════════════════════════════════

describe("splitCallbackToken", () => {
  it("splits a token-stamped callback into action + token", () => {
    expect(splitCallbackToken("form:payment:INR:vabc123def456")).toEqual({
      action: "form:payment:INR",
      token: "abc123def456",
    });
    expect(splitCallbackToken("form:confirm:vtok123456")).toEqual({
      action: "form:confirm",
      token: "tok123456",
    });
  });

  it("returns token=null for callbacks without a token", () => {
    expect(splitCallbackToken("menu:main")).toEqual({ action: "menu:main", token: null });
    expect(splitCallbackToken("form:cat:FREELANCE_SERVICES")).toEqual({ action: "form:cat:FREELANCE_SERVICES", token: null });
  });
});

describe("isFormCallbackCurrent (stale-button protection)", () => {
  const token = newFlowToken();

  it("accepts a step-choice button carrying the CURRENT token for the CURRENT step", () => {
    expect(isFormCallbackCurrent(`form:payment:INR:v${token}`, "payment_method", token)).toBe(true);
    expect(isFormCallbackCurrent(`form:cat:FREELANCE_SERVICES:v${token}`, "category", token)).toBe(true);
    expect(isFormCallbackCurrent(`form:confirm:v${token}`, "preview", token)).toBe(true);
  });

  it("rejects a STALE token (button rendered by an older message) — the core stale-button case", () => {
    const staleToken = newFlowToken();
    expect(isFormCallbackCurrent(`form:payment:INR:v${staleToken}`, "payment_method", token)).toBe(false);
  });

  it("rejects a callback for the WRONG step (old button from a previous question)", () => {
    expect(isFormCallbackCurrent(`form:role:buyer:v${token}`, "payment_method", token)).toBe(false);
    expect(isFormCallbackCurrent(`form:payment:INR:v${token}`, "amount", token)).toBe(false);
  });

  it("rejects a tokenless step-choice callback (cannot prove it is current)", () => {
    expect(isFormCallbackCurrent("form:payment:INR", "payment_method", token)).toBe(false);
  });

  it("rejects when no form is active", () => {
    expect(isFormCallbackCurrent(`form:payment:INR:v${token}`, undefined, token)).toBe(false);
  });

  it("always allows static navigation (continue/restart/edit/menu)", () => {
    expect(isFormCallbackCurrent("form:continue", "counterparty", token)).toBe(true);
    expect(isFormCallbackCurrent("form:restart", "amount", token)).toBe(true);
    expect(isFormCallbackCurrent("menu:main", "payment_method", token)).toBe(true);
  });

  it("every token-stamped action maps to a step", () => {
    expect(STEP_FOR_ACTION["form:payment:INR"]).toBe("payment_method");
    expect(STEP_FOR_ACTION["form:crypto_payer:SELLER"]).toBe("crypto_payer");
    expect(STEP_FOR_ACTION["form:confirm"]).toBe("preview");
  });
});

// ═══════════════════════════════════════════════════════════════════
// WRONG-CHAT CALLBACKS / CHAT-BOUND TEXT (pure)
// ═══════════════════════════════════════════════════════════════════

describe("isDealChatValid (callback chat vs deal group)", () => {
  it("allows callbacks from the deal's own group", () => {
    expect(isDealChatValid("supergroup", -1001234567890, "-1001234567890")).toBe(true);
  });

  it("rejects callbacks from ANY other group", () => {
    expect(isDealChatValid("supergroup", -1009999999999, "-1001234567890")).toBe(false);
    expect(isDealChatValid("group", 42, "-1001234567890")).toBe(false);
  });

  it("allows private-chat (DM) callbacks — the bot sends DM buttons to parties/admins", () => {
    expect(isDealChatValid("private", 555, "-1001234567890")).toBe(true);
  });

  it("allows callbacks when the deal has no group yet", () => {
    expect(isDealChatValid("supergroup", -1009999999999, null)).toBe(true);
  });
});

describe("isFlowChatValid (text only consumed in the flow's chat)", () => {
  it("consumes text in the chat where the flow started", () => {
    expect(isFlowChatValid("42", "42")).toBe(true);
  });

  it("does NOT consume text typed in another chat", () => {
    expect(isFlowChatValid("42", "99")).toBe(false);
    expect(isFlowChatValid("42", undefined)).toBe(false);
  });
});

describe("isFlowExpired", () => {
  it("treats fresh flows as active and old flows as expired", () => {
    expect(isFlowExpired(Date.now() - 1000)).toBe(false);
    expect(isFlowExpired(Date.now() - 31 * 60 * 1000)).toBe(true);
    expect(isFlowExpired(undefined)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// PER-GROUP PAYMENT SETTINGS (DB-backed)
// ═══════════════════════════════════════════════════════════════════

describe("per-group payment settings", () => {
  it("each group has its own UPI details; groups without details fall back to global", async () => {
    await setAdminSetting(SETTING_KEYS.upiId, "global@upi.example", ADMIN_ID, GLOBAL_GROUP_ID);
    await setAdminSetting(SETTING_KEYS.upiId, "groupA@upi.example", ADMIN_ID, GROUP_A);

    expect(await getAdminSetting(SETTING_KEYS.upiId, GROUP_A)).toBe("groupA@upi.example");
    // Group B has no row of its own → the global fallback is used.
    expect(await getAdminSetting(SETTING_KEYS.upiId, GROUP_B)).toBe("global@upi.example");
    expect(await getAdminSetting(SETTING_KEYS.upiId, GLOBAL_GROUP_ID)).toBe("global@upi.example");
  });

  it("removing a group's row restores the global fallback for that group", async () => {
    await setAdminSetting(SETTING_KEYS.usdtBep20Address, "0xGlobal", ADMIN_ID, GLOBAL_GROUP_ID);
    await setAdminSetting(SETTING_KEYS.usdtBep20Address, "0xGroupA", ADMIN_ID, GROUP_A);

    expect(await getAdminSetting(SETTING_KEYS.usdtBep20Address, GROUP_A)).toBe("0xGroupA");
    await deleteAdminSetting(SETTING_KEYS.usdtBep20Address, GROUP_A);
    expect(await getAdminSetting(SETTING_KEYS.usdtBep20Address, GROUP_A)).toBe("0xGlobal");
    // The global row is untouched.
    expect(await getAdminSetting(SETTING_KEYS.usdtBep20Address, GLOBAL_GROUP_ID)).toBe("0xGlobal");
  });

  it("falls back to the env value when neither group nor global row exists (global scope)", async () => {
    // vitest.config.ts sets ESCROW_UPI_ID=escrow@upi.example — no DB rows here.
    expect(await getAdminSetting(SETTING_KEYS.upiId, GLOBAL_GROUP_ID)).toBe("escrow@upi.example");
  });

  it("payment instructions resolve to the DEAL'S group scope", async () => {
    await setAdminSetting(SETTING_KEYS.upiId, "groupA@upi.example", ADMIN_ID, GROUP_A);
    const dealInA = { asset: "INR", network: "UPI", paymentMethod: "INR", groupChatId: GROUP_A };
    const dealInB = { asset: "INR", network: "UPI", paymentMethod: "INR", groupChatId: GROUP_B };

    expect(await getPaymentInstructionsText(dealInA)).toContain("groupA@upi.example");
    // Deal in group B: no group B row → global env fallback is used.
    expect(await getPaymentInstructionsText(dealInB)).toContain("escrow@upi.example");
    expect(await hasPaymentInstructions(dealInA)).toBe(true);
  });

  it("never mixes one group's details into another group's instructions", async () => {
    await setAdminSetting(SETTING_KEYS.upiId, "GROUP_A_ONLY@upi.example", ADMIN_ID, GROUP_A);
    await setAdminSetting(SETTING_KEYS.usdtBep20Address, "0xGroupA", ADMIN_ID, GROUP_A);
    await setAdminSetting(SETTING_KEYS.usdtBep20Address, "0xGroupB", ADMIN_ID, GROUP_B);

    const usdtDealInA = { asset: "USDT", network: "BEP20", paymentMethod: "CRYPTO", groupChatId: GROUP_A };
    const usdtDealInB = { asset: "USDT", network: "BEP20", paymentMethod: "CRYPTO", groupChatId: GROUP_B };

    expect(await getPaymentInstructionsText(usdtDealInA)).toContain("0xGroupA");
    expect(await getPaymentInstructionsText(usdtDealInA)).not.toContain("0xGroupB");
    expect(await getPaymentInstructionsText(usdtDealInB)).toContain("0xGroupB");
    expect(await getPaymentInstructionsText(usdtDealInB)).not.toContain("0xGroupA");
  });

  it("global settings panel values stay global; group rows never leak into the global panel", async () => {
    await setAdminSetting(SETTING_KEYS.upiId, "groupA@upi.example", ADMIN_ID, GROUP_A);
    await setAdminSetting(SETTING_KEYS.upiId, "global@upi.example", ADMIN_ID, GLOBAL_GROUP_ID);
    // The global panel reads the global row — never the group-A row.
    expect(await getAdminSetting(SETTING_KEYS.upiId, GLOBAL_GROUP_ID)).toBe("global@upi.example");
    // And group A still has its own value.
    expect(await getAdminSetting(SETTING_KEYS.upiId, GROUP_A)).toBe("groupA@upi.example");
  });
});
