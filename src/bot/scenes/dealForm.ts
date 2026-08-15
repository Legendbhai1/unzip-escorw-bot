import { InlineKeyboard } from "grammy";
import { DealCategory } from "@prisma/client";
import { config } from "../../config/index.js";
import { userService } from "../../services/userService.js";
import { groupService } from "../../services/groupService.js";
import { dealService } from "../../services/dealService.js";
import { notificationService } from "../../services/notificationService.js";
import { prisma } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";
import { esc, userMention } from "../../lib/html.js";
import { formatMoney, bpsToPercent } from "../../lib/money.js";
import { parseDurationDeadline } from "../../lib/dealTerms.js";
import { newFlowToken, isFlowExpired, isFlowChatValid, isDealChatValid, splitCallbackToken, FLOW_TTL_MS } from "../../lib/flow.js";
import { getPaymentInstructionsText, hasPaymentInstructions } from "../../lib/paymentInstructions.js";
import { activeFormOptions, backToMain } from "../keyboards/index.js";
import type { MyContext } from "../context.js";

/**
 * ONE canonical deal-creation implementation.
 *
 * Entry points — all call startDealForm():
 *   - Main Menu -> [Create Deal]
 *   - /form command
 *   - "form" text message
 *
 * Flow: payment method (INR / UPI | USDT BEP20) -> role -> counterparty ->
 * amount -> (USDT: crypto payer) -> category -> description -> preview.
 * On confirm the same dealService.create() + state machine is used as the
 * group-post entry point, so button/form/command deals are identical.
 *
 * Only two payment methods are supported: INR / UPI and USDT on BEP20.
 */

export type DealFormStep =
  | "payment_method" | "role" | "counterparty" | "amount"
  | "crypto_payer" | "category" | "description" | "deal_duration"
  | "release_condition" | "refund_condition" | "preview";

function clearForm(ctx: MyContext) {
  const s = ctx.session;
  s.createDealStep = undefined;
  s.createDealPaymentMethod = undefined;
  s.createDealRole = undefined;
  s.createDealCounterpartyUsername = undefined;
  s.createDealCounterpartyUserId = undefined;
  s.createDealAmount = undefined;
  s.createDealAsset = undefined;
  s.createDealNetwork = undefined;
  s.createDealCryptoPayer = undefined;
  s.createDealDescription = undefined;
  s.createDealCategory = undefined;
  s.createDealDuration = undefined;
  s.createDealReleaseCondition = undefined;
  s.createDealRefundCondition = undefined;
  s.createDealTargetGroupId = undefined;
  s.flowToken = undefined;
  s.flowChatId = undefined;
  s.flowExpiresAt = undefined;
}

// ── Flow/state hardening ────────────────────────────────────────────
// The deal form is ONE authoritative interactive flow per user, bound to the
// chat where it started. A version TOKEN is rotated on every step advance and
// embedded in the callback data of the buttons the bot renders, so buttons
// from older messages carry an older token and are rejected with
// "This button has expired." — they can never restart or rewind the flow.
// Free text is only consumed in the flow's chat and while the flow is fresh.

/** Tokenized inline keyboards for the button-driven form steps. */
function formKeyboard(step: DealFormStep, token: string): InlineKeyboard {
  switch (step) {
    case "payment_method":
      return new InlineKeyboard()
        .text("\u{1F4B3}  INR / UPI", `form:payment:INR:v${token}`)
        .row()
        .text("\u{1FA99}  USDT (BEP20)", `form:payment:USDT:v${token}`)
        .row()
        .text("\u{274C}  Cancel", "menu:main");
    case "role":
      return new InlineKeyboard()
        .text("\u{1F6D2}  I'm Buying", `form:role:buyer:v${token}`)
        .row()
        .text("\u{1F4BC}  I'm Selling", `form:role:seller:v${token}`)
        .row()
        .text("\u{274C}  Cancel", "menu:main");
    case "crypto_payer":
      return new InlineKeyboard()
        .text("\u{1F6D2}  Buyer pays", `form:crypto_payer:BUYER:v${token}`)
        .row()
        .text("\u{1F4BC}  Seller pays", `form:crypto_payer:SELLER:v${token}`)
        .row()
        .text("\u{274C}  Cancel", "menu:main");
    case "category":
      return new InlineKeyboard()
        .text("Freelance Services", `form:cat:FREELANCE_SERVICES:v${token}`)
        .row()
        .text("Physical Goods", `form:cat:PHYSICAL_GOODS:v${token}`)
        .row()
        .text("Gift Cards", `form:cat:GIFT_CARDS:v${token}`)
        .row()
        .text("Other Lawful", `form:cat:OTHER_LAWFUL:v${token}`)
        .row()
        .text("\u{274C}  Cancel", "menu:main");
    case "preview":
      return new InlineKeyboard()
        .text("\u{2705}  Confirm & Post", `form:confirm:v${token}`)
        .text("\u{270F}\u{FE0F}  Edit", `form:edit:v${token}`)
        .row()
        .text("\u{274C}  Cancel", "menu:main");
    default:
      return backToMain;
  }
}

/** The step a token-stamped callback may drive (text steps have no buttons). */
export const STEP_FOR_ACTION: Record<string, DealFormStep> = {
  "form:payment:INR": "payment_method",
  "form:payment:USDT": "payment_method",
  "form:role:buyer": "role",
  "form:role:seller": "role",
  "form:crypto_payer:BUYER": "crypto_payer",
  "form:crypto_payer:SELLER": "crypto_payer",
  "form:confirm": "preview",
};

/**
 * Is a deal-form callback valid RIGHT NOW? A button is only valid when:
 *   - it drives the step the form is currently on (a stale button from an
 *     earlier step is rejected), and
 *   - it carries the version token that was stamped when its prompt was
 *     rendered (the token rotates on every step advance, so buttons from
 *     older messages carry an older token and are rejected), and
 *   - the form is still active.
 * Static navigation callbacks (continue/restart/edit, menu) are always safe.
 */
export function isFormCallbackCurrent(
  data: string,
  currentStep: string | undefined,
  flowToken: string | undefined
): boolean {
  if (!currentStep) return false;
  const { action, token } = splitCallbackToken(data);
  const expectedStep = action.startsWith("form:cat:") ? "category" : STEP_FOR_ACTION[action];
  if (!expectedStep) return true; // static navigation — safe in any state
  return Boolean(token) && token === flowToken && currentStep === expectedStep;
}

/** Start a fresh interactive flow: new token, bound to this chat, with TTL. */
function beginFlow(ctx: MyContext): string {
  const s = ctx.session;
  s.flowToken = newFlowToken();
  s.flowChatId = String(ctx.chat?.id ?? "");
  s.flowExpiresAt = Date.now() + FLOW_TTL_MS;
  return s.flowToken;
}

/** Rotate the flow token after a step advances. Returns the new token. */
function advanceFlow(ctx: MyContext): string {
  const s = ctx.session;
  s.flowToken = newFlowToken();
  s.flowExpiresAt = Date.now() + FLOW_TTL_MS;
  return s.flowToken;
}

// ── Prompt deletion (message simplification) ───────────────────────────
// When moving to the next form step, the previous bot question is deleted and
// replaced by the newest one, so old temporary prompts disappear. The group
// deal CARD is never tracked/deleted — it is the deal reference.

export async function deleteLastPrompt(ctx: MyContext) {
  const { lastPromptChatId, lastPromptMessageId } = ctx.session;
  if (
    lastPromptMessageId &&
    lastPromptChatId &&
    lastPromptChatId === String(ctx.chat?.id ?? "")
  ) {
    try {
      await ctx.api.deleteMessage(lastPromptChatId, lastPromptMessageId);
    } catch { /* user may have deleted it / permissions — safe to continue */ }
  }
  ctx.session.lastPromptChatId = undefined;
  ctx.session.lastPromptMessageId = undefined;
}

export function trackLastPrompt(ctx: MyContext, messageId: number | undefined) {
  if (messageId == null) return;
  ctx.session.lastPromptChatId = String(ctx.chat?.id ?? "");
  ctx.session.lastPromptMessageId = messageId;
}

/** Send a NEW prompt message, deleting the previous one first. */
async function sendNextPrompt(ctx: MyContext, text: string, kb?: InlineKeyboard) {
  await deleteLastPrompt(ctx);
  const sent = await ctx.reply(text, kb ? { reply_markup: kb } : {});
  trackLastPrompt(ctx, sent.message_id);
  return sent;
}

export function paymentLabel(method?: string): string {
  return method === "INR" ? "INR / UPI" : "USDT BEP20";
}

/** Render the current step's prompt again (used by "Continue"). */
export function renderCurrentStep(ctx: MyContext): string | null {
  const s = ctx.session;
  switch (s.createDealStep as DealFormStep | undefined) {
    case "payment_method":
      return "<b>CREATE DEAL</b>\n\nChoose the <b>payment method</b>:\n\n1. <b>INR / UPI</b> — pay the escrower via UPI\n2. <b>USDT (BEP20)</b> — pay the escrower in USDT on BEP20";
    case "role":
      return "Choose your <b>role</b> in this deal:";
    case "counterparty":
      return `You are the <b>${s.createDealRole === "buyer" ? "Buyer" : "Seller"}</b>.\n\nEnter the other party's Telegram username:\n\n<i>Example: @username</i>`;
    case "amount":
      return s.createDealPaymentMethod === "INR"
        ? "<b>DEAL AMOUNT</b>\n\nEnter the amount in <b>INR</b>:\n\n<i>Example: 10000</i>"
        : "<b>DEAL AMOUNT</b>\n\nEnter the amount in <b>USDT</b>:\n\n<i>Example: 100</i>";
    case "crypto_payer":
      return "Who is <b>paying USDT to the escrow</b>?\n\nIn both cases the escrower manually holds and verifies the real funds — the bot only records the payment.";
    case "category":
      return "<b>CATEGORY</b>\n\nSelect the trade category:";
    case "description":
      return "<b>DEAL DESCRIPTION</b>\n\nDescribe what is being traded:\n\n<i>Example: Logo design for website, 3 revisions included</i>";
    case "deal_duration":
      return "<b>DEAL DURATION</b>\n\nHow long will this deal take?\n\n<i>Example: 7 days, 48 hours, 30 days</i>\n\nThis is a <b>deadline/term</b> only — the bot never auto-refunds or auto-releases money when it passes.";
    case "release_condition":
      return "<b>RELEASE CONDITION</b>\n\nWhen should the escrowed payment be <b>released to the seller</b>?\n\n<i>Example: After the buyer receives and approves the work</i>";
    case "refund_condition":
      return "<b>REFUND CONDITION</b>\n\nUnder what circumstances should the <b>buyer receive a refund</b>?\n\n<i>Example: If the seller does not deliver within the agreed duration</i>";
    default:
      return null;
  }
}

/** Abandon any other pending capture so the deal form is the ONE authoritative
 *  interactive flow for this user (see the flow-hardening section above). */
function abandonOtherFlows(ctx: MyContext) {
  const s = ctx.session;
  s.pendingPaymentReportDealId = undefined;
  s.pendingEvidenceDealId = undefined;
  s.pendingRejectPaymentDealId = undefined;
  s.pendingPaymentReferenceDealId = undefined;
  s.pendingPayoutReferenceDealId = undefined;
  s.pendingRefundReferenceDealId = undefined;
  s.pendingSettingKey = undefined;
  s.pendingSettingGroupId = undefined;
  s.pendingDisputeDealId = undefined;
  s.pendingJoinDealId = undefined;
  s.pendingFlowChatId = undefined;
}

function isGroupChat(ctx: MyContext): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

/** Entry point: [Create Deal] button, /form command and "form" text. */
export async function startDealForm(ctx: MyContext) {
  abandonOtherFlows(ctx);

  // ── Group-first: a deal form started inside a group is bound to that
  // group. An unauthorized group is refused immediately (no form steps are
  // wasted) — deal cards are only posted to groups approved via /allowgroup.
  // The approved group where the form runs becomes the deal's home: the
  // finished card is posted to THIS group, not some other configured one.
  if (isGroupChat(ctx)) {
    const groupId = String(ctx.chat?.id ?? "");
    if (!groupId || !(await groupService.isGroupApproved(groupId))) {
      await ctx.reply(
        "⚠️ <b>GROUP NOT AUTHORIZED</b>\n\n" +
        "This group is not authorized for escrow operations.\n\n" +
        "The bot owner must add the bot here and run <code>/allowgroup</code> inside this group before deals can be created."
      );
      return;
    }
    ctx.session.createDealTargetGroupId = groupId;
  } else {
    ctx.session.createDealTargetGroupId = undefined;
  }

  // If a form is already active, handle it predictably instead of silently
  // swallowing messages: offer continue / restart / cancel. An EXPIRED form
  // is discarded silently and a fresh one is started.
  if (ctx.session.createDealStep) {
    if (isFlowExpired(ctx.session.flowExpiresAt)) {
      clearForm(ctx);
    } else {
      await ctx.reply(
        "You already have an <b>active deal form</b>.\n\n" +
        "You can continue where you left off, restart it, or cancel.",
        { reply_markup: activeFormOptions() }
      );
      return;
    }
  }

  // New authoritative flow: fresh token bound to this chat, with a TTL.
  const token = beginFlow(ctx);
  ctx.session.createDealStep = "payment_method";
  await ctx.reply(
    "<b>CREATE DEAL</b>\n\nChoose the <b>payment method</b>:\n\n" +
    "1. <b>INR / UPI</b> — pay the escrower via UPI\n" +
    "2. <b>USDT (BEP20)</b> — pay the escrower in USDT on BEP20\n\n" +
    "The escrower personally verifies the payment — the bot never holds funds.",
    { reply_markup: formKeyboard("payment_method", token) }
  );
}

/** Handle form:* callback data. Returns true if consumed. */
export async function processDealFormCallback(ctx: MyContext, data: string): Promise<boolean> {
  const s = ctx.session;

  // ── Expired flow: abandon and stop consuming stale callbacks. ──
  if (s.createDealStep && isFlowExpired(s.flowExpiresAt)) {
    clearForm(ctx);
    await ctx.answerCallbackQuery("This form has expired. Please start again.").catch(() => {});
    return true;
  }

  const { action } = splitCallbackToken(data);

  // ── Continue / restart / cancel active form (static navigation, safe) ──
  if (action === "form:continue") {
    if (!s.createDealStep) {
      await startDealForm(ctx);
      return true;
    }
    const prompt = renderCurrentStep(ctx);
    const kb = formKeyboard(s.createDealStep as DealFormStep, s.flowToken ?? "");
    await sendNextPrompt(ctx, prompt ?? "<b>CREATE DEAL</b>", kb);
    return true;
  }
  if (action === "form:restart") {
    clearForm(ctx);
    await startDealForm(ctx);
    return true;
  }
  if (action === "form:edit") {
    clearForm(ctx);
    await startDealForm(ctx);
    return true;
  }

  // ── Step-choice callbacks: the button must carry the token stamped when its
  // prompt was rendered. The token rotates on every step advance, so a button
  // from an older message is stale — reject it and change nothing. ──
  if (!isFormCallbackCurrent(data, s.createDealStep, s.flowToken)) {
    await ctx.answerCallbackQuery("This button has expired. Please use the latest deal message.").catch(() => {});
    return true;
  }

  // ── Payment method (INR / UPI or USDT BEP20 only) ──
  if (action === "form:payment:INR" || action === "form:payment:USDT") {
    const isUsdt = action === "form:payment:USDT";
    s.createDealPaymentMethod = isUsdt ? "CRYPTO" : "INR";
    if (isUsdt) {
      s.createDealAsset = "USDT";
      s.createDealNetwork = "BEP20";
    }
    s.createDealStep = "role";
    await ctx.editMessageText(
      "<b>CREATE DEAL</b>\n\nPayment method: <b>" + paymentLabel(s.createDealPaymentMethod) + "</b>\n\nChoose your <b>role</b>:",
      { reply_markup: formKeyboard("role", advanceFlow(ctx)) }
    );
    return true;
  }

  // ── Role ──
  if (action === "form:role:buyer" || action === "form:role:seller") {
    const role = action === "form:role:buyer" ? "buyer" : "seller";
    s.createDealRole = role;
    s.createDealStep = "counterparty";
    advanceFlow(ctx);
    await ctx.editMessageText(
      `You are the <b>${role === "buyer" ? "Buyer" : "Seller"}</b>.\n\n` +
      `Enter the other party's Telegram username:\n\n<i>Example: @username</i>`,
      { reply_markup: backToMain }
    );
    return true;
  }

  // ── Crypto payer (USDT only — bot only records who pays) ──
  if (action === "form:crypto_payer:BUYER" || action === "form:crypto_payer:SELLER") {
    s.createDealCryptoPayer = action.endsWith("SELLER") ? "SELLER" : "BUYER";
    s.createDealStep = "category";
    await ctx.editMessageText(
      `<b>CREATE DEAL</b>\n\nCrypto payer: <b>${s.createDealCryptoPayer === "SELLER" ? "Seller" : "Buyer"}</b>\n\n` +
      "The escrower manually receives and verifies the USDT. The bot only records the payment.\n\n<b>CATEGORY</b>\n\nSelect the trade category:",
      { reply_markup: formKeyboard("category", advanceFlow(ctx)) }
    );
    return true;
  }

  // ── Category → Description (text step) ──
  if (action.startsWith("form:cat:")) {
    s.createDealCategory = action.replace("form:cat:", "");
    s.createDealStep = "description";
    advanceFlow(ctx);
    await ctx.editMessageText(
      "<b>CATEGORY</b>: <b>" + esc(s.createDealCategory.replace(/_/g, " ")) + "</b>\n\n" +
      "Enter the <b>deal details</b> (what is being traded):\n\n<i>Example: Logo design for a website</i>",
      { reply_markup: backToMain }
    );
    return true;
  }

  // ── Preview (legacy, tokenless) ──
  if (action === "form:preview") {
    await previewDealForm(ctx);
    return true;
  }

  // ── Confirm & create ──
  if (action === "form:confirm") {
    await createDealFromForm(ctx);
    return true;
  }

  return false;
}

/** Handle text input during the form. Returns true if consumed. */
export async function processDealFormText(ctx: MyContext, text: string): Promise<boolean> {
  const s = ctx.session;
  const step = s.createDealStep as DealFormStep | undefined;
  if (!step) return false;

  // Chat binding — only the chat where this form started may feed it text.
  // A message typed in ANY other chat is not consumed by this flow; it passes
  // through to the remaining handlers untouched.
  if (!isFlowChatValid(s.flowChatId, String(ctx.chat?.id ?? ""))) return false;

  // Expiry — an abandoned form stops consuming input so an old question can
  // never interpret a later message.
  if (isFlowExpired(s.flowExpiresAt)) {
    clearForm(ctx);
    await ctx.reply(
      "Your deal form has expired. Start again with /form or [Create Deal].",
      { reply_markup: backToMain }
    );
    return true;
  }

  // ── Counterparty username ──
  if (step === "counterparty") {
    const normalized = text.replace(/^@+/, "").trim();
    const usernameRe = /^[A-Za-z0-9_]{5,32}$/;

    if (!normalized) {
      await ctx.reply("Please enter the other party's Telegram username, e.g. <code>@username</code>.");
      return true; // stay on the step
    }
    if (!usernameRe.test(normalized)) {
      await ctx.reply(
        "That doesn't look like a valid Telegram username.\n\n" +
        "Usernames are 5–32 characters and may only contain letters, numbers and underscores.\n\n" +
        "Example: <code>@john_doe</code>\n\nPlease try again:"
      );
      return true; // stay on the step
    }

    const otherUser = await userService.findByUsername(normalized);
    if (!otherUser) {
      // Do NOT clear the step — the user stays here to retry.
      await ctx.reply(
        `User <code>@${esc(normalized)}</code> was not found.\n\n` +
        `The other person must start this bot first — ask them to send <code>/start</code> to the bot, then enter their username again.`
      );
      return true;
    }
    if (otherUser.id === s.userId) {
      await ctx.reply("You can't create a deal with yourself. Please enter the other party's username:");
      return true; // stay on the step
    }

    s.createDealCounterpartyUsername = otherUser.username ?? normalized;
    s.createDealCounterpartyUserId = otherUser.id;
    s.createDealStep = "amount";
    advanceFlow(ctx);
    await sendNextPrompt(
      ctx,
      s.createDealPaymentMethod === "INR"
        ? "Enter the amount in <b>INR</b>:\n\n<i>Example: 10000</i>"
        : "Enter the amount in <b>USDT</b>:\n\n<i>Example: 100</i>"
    );
    return true;
  }

  // ── Amount ──
  if (step === "amount") {
    const clean = text.replace(/,/g, "").trim();
    if (!/^\d+(\.\d{1,8})?$/.test(clean) || parseFloat(clean) <= 0) {
      await ctx.reply(
        "Invalid amount. Please enter a <b>positive number</b>.\n\n" +
        (s.createDealPaymentMethod === "INR"
          ? "Example: <code>10000</code> (INR)"
          : "Example: <code>100</code> (USDT)"),
        { reply_markup: backToMain }
      );
      return true; // stay on the step
    }
    s.createDealAmount = clean;

    if (s.createDealPaymentMethod === "CRYPTO") {
      s.createDealStep = "crypto_payer";
      await sendNextPrompt(
        ctx,
        "Who is <b>paying USDT to the escrow</b>?",
        formKeyboard("crypto_payer", advanceFlow(ctx))
      );
    } else {
      // INR: asset=INR, network=UPI.
      s.createDealAsset = "INR";
      s.createDealNetwork = "UPI";
      s.createDealStep = "category";
      await sendNextPrompt(ctx, "<b>CATEGORY</b>\n\nSelect the trade category:", formKeyboard("category", advanceFlow(ctx)));
    }
    return true;
  }

  // ── Description ──
  if (step === "description") {
    if (text.length < 5 || text.length > 400) {
      await ctx.reply("Description must be between 5 and 400 characters.", { reply_markup: backToMain });
      return true; // stay on the step
    }
    s.createDealDescription = text;
    s.createDealStep = "deal_duration";
    advanceFlow(ctx);
    await sendNextPrompt(
      ctx,
      "<b>DEAL DURATION</b>\n\nHow long will this deal take?\n\n<i>Example: 7 days, 48 hours, 30 days</i>\n\nTerm/deadline only — never auto-enforced."
    );
    return true;
  }

  // ── Deal duration (informational term, never auto-enforced) ──
  if (step === "deal_duration") {
    if (text.length < 1 || text.length > 64) {
      await ctx.reply("Duration must be between 1 and 64 characters, e.g. <code>7 days</code>.", { reply_markup: backToMain });
      return true; // stay on the step
    }
    s.createDealDuration = text.trim();
    s.createDealStep = "release_condition";
    advanceFlow(ctx);
    await sendNextPrompt(
      ctx,
      "<b>RELEASE CONDITION</b>\n\nWhen should the payment be <b>released to the seller</b>?\n\n<i>Example: After the buyer receives and approves the work</i>"
    );
    return true;
  }

  // ── Release condition ──
  if (step === "release_condition") {
    if (text.length < 5 || text.length > 400) {
      await ctx.reply("Release condition must be between 5 and 400 characters.", { reply_markup: backToMain });
      return true; // stay on the step
    }
    s.createDealReleaseCondition = text;
    s.createDealStep = "refund_condition";
    advanceFlow(ctx);
    await sendNextPrompt(
      ctx,
      "<b>REFUND CONDITION</b>\n\nWhen can the payment be <b>refunded</b>?\n\n<i>Example: If the seller does not deliver within the agreed duration</i>",
      backToMain
    );
    return true;
  }

  // ── Refund condition → preview ──
  if (step === "refund_condition") {
    if (text.length < 5 || text.length > 400) {
      await ctx.reply("Refund condition must be between 5 and 400 characters.", { reply_markup: backToMain });
      return true; // stay on the step
    }
    s.createDealRefundCondition = text;
    s.createDealStep = "preview";
    advanceFlow(ctx);
    await previewDealForm(ctx);
    return true;
  }

  return false;
}

/** Show the final deal summary with fees before creating. */
export async function previewDealForm(ctx: MyContext) {
  const s = ctx.session;
  const amount = parseFloat(s.createDealAmount ?? "0");
  const asset = s.createDealAsset ?? (s.createDealPaymentMethod === "INR" ? "INR" : "USDT");
  const isInr = asset === "INR";

  const buyerFee = amount * config.buyerFeeBps / 10000;
  const sellerFee = amount * config.sellerFeeBps / 10000;
  const buyerTotal = amount + buyerFee;
  const sellerReceives = amount - sellerFee;

  const buyerHandle = s.createDealRole === "buyer" ? `@${esc(s.username ?? s.firstName)}` : `@${esc(s.createDealCounterpartyUsername ?? "?")}`;
  const sellerHandle = s.createDealRole === "seller" ? `@${esc(s.username ?? s.firstName)}` : `@${esc(s.createDealCounterpartyUsername ?? "?")}`;

  const amountStr = isInr ? formatMoney(amount, "INR") : formatMoney(amount, asset);
  const buyerFeeStr = isInr ? formatMoney(buyerFee, "INR") : formatMoney(buyerFee, asset);
  const sellerFeeStr = isInr ? formatMoney(sellerFee, "INR") : formatMoney(sellerFee, asset);
  const buyerTotalStr = isInr ? formatMoney(buyerTotal, "INR") : formatMoney(buyerTotal, asset);
  const sellerReceivesStr = isInr ? formatMoney(sellerReceives, "INR") : formatMoney(sellerReceives, asset);

  const cryptoPayerLine = s.createDealPaymentMethod === "CRYPTO"
    ? `Crypto payer: <b>${s.createDealCryptoPayer === "SELLER" ? "Seller" : "Buyer"}</b>\n`
    : "";

  const durationLine = s.createDealDuration ? `⏱ Deal duration: <b>${esc(s.createDealDuration)}</b>\n` : "";
  const releaseLine = s.createDealReleaseCondition
    ? `🔓 Release condition:\n${esc(s.createDealReleaseCondition)}\n`
    : "";
  const refundLine = s.createDealRefundCondition
    ? `↩️ Refund condition:\n${esc(s.createDealRefundCondition)}\n`
    : "";

  await sendNextPrompt(
    ctx,
    `<b>CREATE ESCROW</b>\n\n` +
    `Payment: <b>${paymentLabel(s.createDealPaymentMethod)}</b>\n` +
    cryptoPayerLine +
    `Amount: <b>${amountStr}</b>\n` +
    `Buyer: ${buyerHandle}\n` +
    `Seller: ${sellerHandle}\n` +
    `Category: ${esc(s.createDealCategory?.replace(/_/g, " ") ?? "")}\n\n` +
    `Buyer fee (${bpsToPercent(config.buyerFeeBps)}): ${buyerFeeStr}\n` +
    `Seller fee (${bpsToPercent(config.sellerFeeBps)}): ${sellerFeeStr}\n\n` +
    `Buyer total: <b>${buyerTotalStr}</b>\n` +
    `Seller receives: <b>${sellerReceivesStr}</b>\n\n` +
    `📝 Description:\n${esc(s.createDealDescription ?? "")}\n\n` +
    durationLine +
    releaseLine +
    refundLine +
    `🔐 Payment is manually verified by the escrower.`,
    formKeyboard("preview", ctx.session.flowToken ?? "")
  );
}

function groupStatusLabel(status: string): string {
  const map: Record<string, string> = {
    CREATED: "WAITING FOR ADMIN",
    JOINED: "WAITING FOR ADMIN",
    AWAITING_PAYMENT: "AWAITING PAYMENT",
    PAYMENT_REPORTED: "PAYMENT REPORTED",
    PAYMENT_RECEIVED: "🟢 PAYMENT RECEIVED ✅ — CONTINUE THE DEAL MANUALLY",
    FUNDED: "FUNDED — PAYMENT VERIFIED",
    DELIVERED: "DELIVERED",
    RELEASE_REQUESTED: "RELEASE REQUESTED",
    REFUND_REQUESTED: "REFUND REQUESTED",
    DISPUTED: "DISPUTED",
    UNDER_REVIEW: "UNDER REVIEW",
    COMPLETED: "COMPLETED",
    REFUNDED: "REFUNDED",
    RELEASED: "RELEASED",
    CANCELLED: "CANCELLED",
    EXPIRED: "EXPIRED",
  };
  return map[status] ?? status.replace(/_/g, " ");
}

/** Status label for the group card: during the agreement phase it shows how
 *  many parties have agreed; once both have agreed it becomes WAITING FOR
 *  ADMIN so the escrow admin knows the deal is ready to accept. */
export function dealCardStatusLabel(deal: any): string {
  if ((deal.status ?? "CREATED") === "CREATED") {
    const buyerOk = Boolean(deal.buyerAgreedAt);
    const sellerOk = Boolean(deal.sellerAgreedAt);
    if (buyerOk && sellerOk) return "WAITING FOR ADMIN";
    return `WAITING FOR PARTY AGREEMENT (${[buyerOk, sellerOk].filter(Boolean).length}/2)`;
  }
  return groupStatusLabel(deal.status);
}

/** Keyboard for the group deal card. While the deal is pending (CREATED):
 *  [✅ Agree to Deal] until both parties agree (the bot identifies who
 *  clicks), then [🛡 Accept Deal] for the escrow admin. Once the deal has
 *  moved past creation the card becomes read-only with a View Status button. */
export function groupCardKeyboard(deal: any): InlineKeyboard {
  const kb = new InlineKeyboard();
  if ((deal.status ?? "CREATED") === "CREATED") {
    const bothAgreed = Boolean(deal.buyerAgreedAt) && Boolean(deal.sellerAgreedAt);
    if (bothAgreed) {
      kb.text("\u{1F6E1}\u{FE0F}  Accept Deal", `admin:accept_deal:${deal.id}`);
    } else {
      kb.text("\u{2705}  Agree to Deal", `deal:agree:${deal.id}`);
    }
    kb.row().text("\u{274C}  Cancel Deal", `deal:cancel:${deal.id}`);
  } else {
    kb.text("\u{1F4CB}  View Status", `deal:status:${deal.id}`);
  }
  return kb;
}

/** Build the group-post deal card. The Telegram message itself is the deal
 *  reference — there are NO web links. Buyer/seller are rendered as clickable
 *  tg://user mentions so they work in groups regardless of privacy mode. */
export function buildDealCard(
  deal: any,
  buyer: { username?: string | null; telegramId?: bigint | number | null } | null | undefined,
  seller: { username?: string | null; telegramId?: bigint | number | null } | null | undefined,
  status?: string
): string {
  const isInr = (deal.asset ?? "") === "INR" || (deal.paymentMethod ?? "") === "INR";
  const amountStr = isInr ? formatMoney(deal.amount.toString(), "INR") : formatMoney(deal.amount.toString(), deal.asset);
  const buyerFeeStr = isInr ? formatMoney(deal.buyerFeeAmount.toString(), "INR") : formatMoney(deal.buyerFeeAmount.toString(), deal.asset);
  const sellerFeeStr = isInr ? formatMoney(deal.sellerFeeAmount.toString(), "INR") : formatMoney(deal.sellerFeeAmount.toString(), deal.asset);
  const isUsdt = !isInr;
  const cryptoPayerLine = isUsdt
    ? `Crypto payer: <b>${(deal.cryptoPayer ?? "BUYER") === "SELLER" ? "Seller" : "Buyer"}</b>\n`
    : "";
  const durationLine = deal.dealDuration
    ? `⏱ Deal duration: <b>${esc(deal.dealDuration)}</b>\n`
    : "";
  const releaseLine = deal.releaseCondition
    ? `🔓 Release condition:\n${esc(deal.releaseCondition)}\n`
    : "";
  const refundLine = deal.refundCondition
    ? `↩️ Refund condition:\n${esc(deal.refundCondition)}\n`
    : "";

  // Party agreement block — the bot records who actually clicked.
  const agreementBlock =
    `🤝 <b>AGREEMENT</b>\n` +
    `Buyer: ${buyer ? userMention(buyer.telegramId, buyer.username) : "—"} ${deal.buyerAgreedAt ? "✅ Agreed" : "⏳ Waiting"}\n` +
    `Seller: ${seller ? userMention(seller.telegramId, seller.username) : "—"} ${deal.sellerAgreedAt ? "✅ Agreed" : "⏳ Waiting"}\n`;

  return (
    `🛡 <b>ESCROW DEAL #${esc(deal.inviteCode)}</b>\n\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `👤 Buyer: ${userMention(buyer?.telegramId, buyer?.username)}\n` +
    `👤 Seller: ${userMention(seller?.telegramId, seller?.username)}\n\n` +
    `💳 Payment: <b>${esc(deal.paymentMethod === "INR" ? "INR / UPI" : "USDT BEP20")}</b>\n` +
    cryptoPayerLine +
    `💰 Amount: <b>${amountStr}</b>\n` +
    `📦 Category: ${esc(deal.category?.replace(/_/g, " ") ?? "")}\n\n` +
    `📝 Description:\n${esc(deal.description)}\n\n` +
    durationLine +
    releaseLine +
    refundLine +
    `💸 Buyer fee: ${buyerFeeStr} · Seller fee: ${sellerFeeStr}\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    agreementBlock +
    `\nStatus: <b>${esc(status ?? dealCardStatusLabel(deal))}</b>\n\n` +
    `🔐 Payment is manually verified by the escrower.`
  );
}

/** Resolve the escrow group a new deal card is posted to: the admin-entered
 *  `escrow_group_id` setting (or the ESCROW_GROUP_ID env fallback), otherwise
 *  the first approved group. */
export async function resolveEscrowGroupId(): Promise<string> {
  const { getEscrowGroupId } = await import("../../lib/paymentInstructions.js");
  const configured = (await getEscrowGroupId()).trim();
  if (configured) return configured;
  const approved = await groupService.getFirstApprovedGroupId();
  return approved ?? "";
}

/** Create the deal from the completed form, post the card to an APPROVED
 *  escrow group (the deal reference) and notify the counterparty. */
export async function createDealFromForm(ctx: MyContext) {
  const s = ctx.session;
  try {
    // Only an approved escrow group can host deals — do NOT create the deal
    // if no group is configured/approved (the creator gets a clear message).
    // Group-first: when the form was started inside an approved escrow group,
    // the card is posted to THAT group (the deal's home). DM-started forms
    // fall back to the configured escrow group / first approved group.
    const targetGroupId = s.createDealTargetGroupId?.trim() || (await resolveEscrowGroupId());
    if (!targetGroupId) {
      await ctx.reply(
        "⚠️ <b>ESCROW GROUP NOT AUTHORIZED</b>\n\n" +
        "No escrow group is configured or approved yet.\n\n" +
        "The bot owner must add the bot to the escrow group and run <code>/allowgroup</code> there before deals can be created."
      );
      clearForm(ctx);
      return;
    }
    if (!(await groupService.isGroupApproved(targetGroupId))) {
      await ctx.reply(
        "⚠️ <b>GROUP NOT AUTHORIZED</b>\n\n" +
        "This group is not approved for escrow operations.\n\n" +
        "The bot owner must run <code>/allowgroup</code> inside the group before deals can be posted there."
      );
      clearForm(ctx);
      return;
    }

    const buyerId = s.createDealRole === "buyer" ? s.userId : (s.createDealCounterpartyUserId ?? "");
    const sellerId = s.createDealRole === "seller" ? s.userId : (s.createDealCounterpartyUserId ?? null);
    const paymentMethod = s.createDealPaymentMethod ?? "CRYPTO";
    const asset = s.createDealAsset ?? (paymentMethod === "INR" ? "INR" : "USDT");
    const network = s.createDealNetwork ?? (paymentMethod === "INR" ? "UPI" : "BEP20");

    const deal = await dealService.create({
      buyerUserId: buyerId,
      sellerUserId: sellerId,
      sellerUsername: s.createDealCounterpartyUsername ?? "",
      amount: s.createDealAmount ?? "0",
      asset,
      network,
      paymentMethod,
      currency: paymentMethod === "INR" ? "INR" : asset,
      cryptoPayer: paymentMethod === "CRYPTO" ? (s.createDealCryptoPayer ?? "BUYER") : undefined,
      description: s.createDealDescription ?? "",
      category: (s.createDealCategory ?? "FREELANCE_SERVICES") as DealCategory,
      dealDuration: s.createDealDuration ?? undefined,
      dealDeadlineAt: s.createDealDuration ? parseDurationDeadline(s.createDealDuration) ?? undefined : undefined,
      releaseCondition: s.createDealReleaseCondition ?? undefined,
      refundCondition: s.createDealRefundCondition ?? undefined,
    });

    // Notify counterparty (no web link — the group card is the deal reference).
    if (s.createDealCounterpartyUserId) {
      await notificationService.notifyDealCreated(
        s.createDealCounterpartyUserId,
        deal.inviteCode,
        s.createDealAmount ?? "0",
        paymentMethod === "INR" ? "INR" : asset,
        s.createDealDescription ?? "",
        paymentLabel(paymentMethod),
        s.createDealCryptoPayer
      );
    }

    // Post the deal card to the configured escrow group (form entry point).
    // On a buyer-created deal the seller has not joined yet, so pass the
    // intended seller's username for the card instead of showing "N/A".
    const intendedSellerUsername =
      s.createDealRole === "seller" ? (s.username ?? null) : (s.createDealCounterpartyUsername ?? null);
    await postDealCardToGroup(ctx, deal, intendedSellerUsername, targetGroupId);

    await ctx.reply(
      `<b>DEAL CREATED</b>\n\n` +
      `Deal ID: <code>#${deal.inviteCode}</code>\n\n` +
      `Payment: <b>${paymentLabel(paymentMethod)}</b>\n` +
      (paymentMethod === "CRYPTO" ? `Crypto payer: <b>${s.createDealCryptoPayer === "SELLER" ? "Seller" : "Buyer"}</b>\n` : "") +
      `Amount: <b>${formatMoney(parseFloat(s.createDealAmount ?? "0"), asset === "INR" ? "INR" : asset)}</b>\n\n` +
      `The deal has been posted to the escrow group and is <b>waiting for the escrow admin to accept it</b>.\n\n` +
      `⚠️ Do <b>NOT</b> send any payment until the admin accepts and you receive the payment instructions.`,
      {
        reply_markup: new InlineKeyboard()
          .text("Cancel Deal", `deal:cancel:${deal.id}`)
          .row()
          .text("Main Menu", "menu:main"),
      }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    logger.warn({ err: e }, "Deal form creation failed");
    await ctx.reply(`Error: ${esc(msg)}`, { reply_markup: backToMain });
  }
  // The temporary form prompts (including the preview) disappear — the group
  // deal card remains as the deal reference.
  await deleteLastPrompt(ctx).catch(() => {});
  clearForm(ctx);
}

/** Post the completed deal card to an APPROVED escrow group and remember the
 *  message (chat id + message id) on the deal so it can be updated as the deal
 *  progresses. The Telegram message itself is the deal reference — the bot
 *  never generates web links. The group id is the admin-entered
 *  `escrow_group_id` setting (or the ESCROW_GROUP_ID env fallback / first
 *  approved group) and MUST be approved via /allowgroup before cards post. */
export async function postDealCardToGroup(
  ctx: MyContext,
  deal: any,
  intendedSellerUsername?: string | null,
  groupId?: string
) {
  const target = groupId?.trim() || (await resolveEscrowGroupId());
  if (!target) {
    logger.info({ dealId: deal.id }, "No escrow group configured/approved — deal card not posted to a group");
    return;
  }
  if (!(await groupService.isGroupApproved(target))) {
    logger.warn({ dealId: deal.id, groupId: target }, "Refusing to post deal card: group not approved for escrow");
    return;
  }

  const buyer = deal.buyerId ? await userService.findById(deal.buyerId) : null;
  // If the seller has joined, use their real username; otherwise resolve the
  // intended seller from the form (buyer-created deals have no sellerId yet)
  // so the card shows a correct, clickable mention.
  const seller = deal.sellerId ? await userService.findById(deal.sellerId) : null;
  const sellerResolved = seller ?? (intendedSellerUsername ? await userService.findByUsername(intendedSellerUsername) : null);

  const kb = groupCardKeyboard(deal);

  try {
    const sent = await ctx.api.sendMessage(
      target,
      buildDealCard(deal, buyer, sellerResolved, dealCardStatusLabel(deal)),
      { parse_mode: "HTML", reply_markup: kb }
    );
    await prisma.deal.update({
      where: { id: deal.id },
      data: {
        groupChatId: String(sent.chat.id),
        groupMessageId: sent.message_id,
      },
    });
    logger.info({ dealId: deal.id, groupId: target, messageId: sent.message_id }, "Deal card posted to escrow group");
  } catch (e) {
    logger.warn({ dealId: deal.id, groupId: target, err: e }, "Failed to post deal card to escrow group");
  }
}

/** Edit the group deal card with the current status (the group message stays
 *  the single source of truth for the deal). */
export async function updateGroupDealCard(ctx: MyContext, deal: any) {
  if (!deal?.groupChatId || !deal?.groupMessageId) return;
  const buyer = deal.buyerId ? await userService.findById(deal.buyerId) : null;
  const seller = deal.sellerId ? await userService.findById(deal.sellerId) : null;
  const status = dealCardStatusLabel(deal);

  const acceptedByUser = deal.acceptedAt && deal.acceptedBy
    ? await userService.findById(deal.acceptedBy).catch(() => null)
    : null;
  const acceptedByLine = acceptedByUser
    ? `\nAccepted by: ${userMention(acceptedByUser.telegramId, acceptedByUser.username)}`
    : (deal.acceptedAt && deal.acceptedBy
      ? `\nAccepted by: ${userMention(undefined, deal.acceptedByUsername ?? "escrow admin")}`
      : "");

  const kb = groupCardKeyboard(deal);

  try {
    await ctx.api.editMessageText(
      deal.groupChatId,
      deal.groupMessageId,
      buildDealCard(deal, buyer, seller, status + acceptedByLine),
      { parse_mode: "HTML", reply_markup: kb }
    );
  } catch (e) {
    logger.warn({ dealId: deal.id, err: e }, "Failed to update group deal card");
  }
}

/**
 * After the escrow admin ACCEPTS a deal, the group deal card itself becomes
 * the payment instructions: who accepted, the exact amount to pay, the
 * escrower's manually-configured receiving details scoped to THIS group, and
 * the [I've Paid] button for the payer. Nothing is DMed to the parties — the
 * group card is the deal reference and the single source of truth.
 * Also records the PAYMENT_INSTRUCTIONS_SENT audit event.
 */
export async function postPaymentInstructionsToGroupCard(
  ctx: MyContext,
  deal: any,
  acceptedByUsername?: string | null,
  rejectionReason?: string
) {
  if (!deal?.groupChatId || !deal?.groupMessageId) return;

  const buyer = deal.buyerId ? await userService.findById(deal.buyerId) : null;
  const seller = deal.sellerId ? await userService.findById(deal.sellerId) : null;

  const payerId = dealService.getPayerId(deal);
  const payerIsBuyer = payerId === deal.buyerId;
  const payerUser = payerIsBuyer ? buyer : seller;

  const amount = parseFloat(deal.amount.toString());
  const buyerFee = amount * (deal.buyerFeeBps ?? config.buyerFeeBps) / 10000;
  const totalPaid = amount + buyerFee;
  const isInr = (deal.asset ?? "") === "INR";

  const configured = await hasPaymentInstructions(deal);
  const methodLabel = deal.paymentMethod === "INR" ? "INR / UPI" : "USDT BEP20";
  const instructions = configured
    ? `💳 <b>How to pay:</b>\n${await getPaymentInstructionsText(deal)}\n`
    : `❌ <b>${deal.paymentMethod === "INR" ? "UPI" : "USDT BEP20"} payment isn't configured for this group.</b>\nAsk an admin to run /settings.\n`;

  const acceptedByLine = acceptedByUsername ? `Accepted by: @${esc(acceptedByUsername)}\n` : "";
  const payerLine = deal.paymentMethod !== "INR"
    ? `Payer: ${userMention(payerUser?.telegramId, payerUser?.username)}\n`
    : "";
  const rejectionLine = rejectionReason
    ? `\n⚠️ Your previous payment report was rejected: ${esc(rejectionReason)}\nPay again and tap <b>I've Paid</b>.\n`
    : "";

  const paymentBlock =
    `━━━━━━━━━━━━━━━━\n` +
    `💰 <b>PAYMENT REQUIRED</b>\n\n` +
    `Deal: #${esc(deal.inviteCode)}\n` +
    acceptedByLine +
    `Payment: <b>${esc(methodLabel)}</b>\n` +
    payerLine +
    `Amount to pay: <b>${formatMoney(totalPaid, isInr ? "INR" : deal.asset)}</b>\n\n` +
    instructions +
    rejectionLine +
    `Only send to the details above. The escrower verifies payment manually.`;

  const kb = new InlineKeyboard()
    .text("\u{2705}  I've Paid", `deal:paid:${deal.id}`)
    .row()
    .text("\u{1F4CB}  View Status", `deal:status:${deal.id}`);

  try {
    await ctx.api.editMessageText(
      deal.groupChatId,
      deal.groupMessageId,
      buildDealCard(deal, buyer, seller, dealCardStatusLabel(deal)) + "\n\n" + paymentBlock,
      { parse_mode: "HTML", reply_markup: kb }
    );
  } catch (e) {
    logger.warn({ dealId: deal.id, err: e }, "Failed to post payment instructions to group card");
  }

  try {
    await prisma.escrowAuditLog.create({
      data: {
        dealId: deal.id,
        action: "PAYMENT_INSTRUCTIONS_SENT",
        notes: `Payment instructions posted to the group card (payer: @${payerUser?.username ?? "N/A"})`,
      },
    });
  } catch (e) {
    logger.warn({ dealId: deal.id, err: e }, "Failed to record PAYMENT_INSTRUCTIONS_SENT audit");
  }
}

/**
 * Party clicks [✅ Agree to Deal] on the group card. The bot identifies the
 * Telegram user who clicked and records the agreement for THEIR party only.
 * After both parties agree, the card is re-rendered with [🛡 Accept Deal] and
 * the owner + this group's escrow admins are notified.
 */
export async function handleAgreeToDeal(ctx: MyContext, dealId: string) {
  try {
    const deal = await dealService.findWithParties(dealId);
    if (!deal) {
      await ctx.answerCallbackQuery("Deal not found.").catch(() => {});
      return;
    }

    // The callback must come from the deal's own group (when known); DM
    // callbacks are allowed only where the bot sends them.
    const cbChat = ctx.callbackQuery?.message?.chat;
    if (cbChat && !isDealChatValid(cbChat.type, cbChat.id, deal.groupChatId)) {
      await ctx.answerCallbackQuery("This deal belongs to another group.").catch(() => {});
      return;
    }

    const res = await dealService.agreeToDeal(dealId, ctx.session.userId);
    await ctx.answerCallbackQuery(
      res.agreedBy === "BUYER" ? "Buyer agreed \u2705" : "Seller agreed \u2705"
    ).catch(() => {});

    // The group card is the source of truth: it is re-rendered with the
    // agreement status (and [🛡 Accept Deal] once both parties agree). No
    // extra party DMs — only the admins are nudged in DM to accept.
    const updated = await dealService.findWithParties(dealId);
    if (updated) await updateGroupDealCard(ctx, updated);

    if (res.bothAgreed && updated) {
      const amountStr = (updated.asset ?? "") === "INR"
        ? formatMoney(updated.amount.toString(), "INR")
        : formatMoney(updated.amount.toString(), updated.asset);
      await notificationService.notifyAdmins(
        `🤝 <b>BOTH PARTIES AGREED — DEAL READY</b>\n\n` +
        `Deal: #${esc(updated.inviteCode)}\n` +
        `Buyer: @${esc(updated.buyer?.username ?? "N/A")}\n` +
        `Seller: @${esc(updated.seller?.username ?? "N/A")}\n` +
        `Amount: <b>${amountStr}</b>\n\n` +
        `Both parties agreed to the terms in the group. Accept the deal there to start the payment flow.`,
        new InlineKeyboard().text("\u{1F6E1}\u{FE0F}  Accept Deal", `admin:accept_deal:${updated.id}`),
        { dealId: updated.id }
      );

    }
  } catch (e: unknown) {
    await ctx.answerCallbackQuery(e instanceof Error ? e.message : "Error").catch(() => {});
  }
}
