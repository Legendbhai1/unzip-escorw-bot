import { InlineKeyboard } from "grammy";
import { DealCategory } from "@prisma/client";
import { config } from "../../config/index.js";
import { userService } from "../../services/userService.js";
import { dealService } from "../../services/dealService.js";
import { notificationService } from "../../services/notificationService.js";
import { logger } from "../../lib/logger.js";
import { esc } from "../../lib/html.js";
import { formatMoney, bpsToPercent } from "../../lib/money.js";
import {
  paymentMethodSelect, roleSelect, cryptoDenominationSelect, categorySelect,
  formConfirm, activeFormOptions, backToMain,
} from "../keyboards/index.js";
import type { MyContext } from "../context.js";

/**
 * ONE canonical deal-creation implementation.
 *
 * Entry points — all call startDealForm():
 *   - Main Menu -> [Create Deal]
 *   - /form command
 *   - "form" text message
 *
 * Flow: payment method -> role -> counterparty -> amount -> (crypto
 * denomination) -> category -> description -> preview -> confirm.
 * On confirm the SAME dealService.create() + state machine is used as the
 * group-post entry point, so button/form/command deals are identical.
 */

export type DealFormStep =
  | "payment_method" | "role" | "counterparty" | "amount"
  | "crypto_network" | "category" | "description" | "preview";

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
  s.createDealDescription = undefined;
  s.createDealCategory = undefined;
}

function paymentLabel(method?: string): string {
  return method === "INR" ? "INR / UPI" : "Crypto";
}

/** Render the current step's prompt again (used by "Continue"). */
export function renderCurrentStep(ctx: MyContext): string | null {
  const s = ctx.session;
  switch (s.createDealStep as DealFormStep | undefined) {
    case "payment_method":
      return "Choose the <b>payment method</b>:\n\n1. <b>INR / UPI</b> — pay the escrower via UPI\n2. <b>Crypto</b> — pay the escrower in crypto";
    case "role":
      return "Choose your <b>role</b> in this deal:";
    case "counterparty":
      return `You are the <b>${s.createDealRole === "buyer" ? "Buyer" : "Seller"}</b>.\n\nEnter the other party's Telegram username:\n\n<i>Example: @username</i>`;
    case "amount":
      return s.createDealPaymentMethod === "INR"
        ? "<b>DEAL AMOUNT</b>\n\nEnter the amount in <b>INR</b>:\n\n<i>Example: 10000</i>"
        : "<b>DEAL AMOUNT</b>\n\nEnter the amount in your chosen crypto:\n\n<i>Example: 100</i>";
    case "crypto_network":
      return "Which <b>crypto denomination</b> is the payment in?";
    case "category":
      return "<b>CATEGORY</b>\n\nSelect the trade category:";
    case "description":
      return "<b>DEAL DESCRIPTION</b>\n\nDescribe what is being traded:\n\n<i>Example: Logo design for website, 3 revisions included</i>";
    default:
      return null;
  }
}

/** Entry point: [Create Deal] button, /form command and "form" text. */
export async function startDealForm(ctx: MyContext) {
  // If a form is already active, handle it predictably instead of silently
  // swallowing messages: offer continue / restart / cancel.
  if (ctx.session.createDealStep) {
    await ctx.reply(
      "You already have an <b>active deal form</b>.\n\n" +
      "You can continue where you left off, restart it, or cancel.",
      { reply_markup: activeFormOptions() }
    );
    return;
  }

  ctx.session.createDealStep = "payment_method";
  await ctx.reply(
    "<b>CREATE DEAL</b>\n\nChoose the <b>payment method</b>:\n\n" +
    "1. <b>INR / UPI</b> — pay the escrower via UPI\n" +
    "2. <b>Crypto</b> — pay the escrower in crypto\n\n" +
    "The escrower personally verifies the payment — the bot never holds funds.",
    { reply_markup: paymentMethodSelect }
  );
}

/** Handle form:* callback data. Returns true if consumed. */
export async function processDealFormCallback(ctx: MyContext, data: string): Promise<boolean> {
  const s = ctx.session;

  // ── Continue / restart / cancel active form ──
  if (data === "form:continue") {
    if (!s.createDealStep) {
      await startDealForm(ctx);
      return true;
    }
    const prompt = renderCurrentStep(ctx);
    const kb =
      s.createDealStep === "payment_method" ? paymentMethodSelect
      : s.createDealStep === "role" ? roleSelect
      : s.createDealStep === "crypto_network" ? cryptoDenominationSelect
      : s.createDealStep === "category" ? categorySelect
      : s.createDealStep === "description" ? backToMain
      : backToMain;
    await ctx.reply(prompt ?? "<b>CREATE DEAL</b>", { reply_markup: kb });
    return true;
  }
  if (data === "form:restart") {
    clearForm(ctx);
    await startDealForm(ctx);
    return true;
  }
  if (data === "form:edit") {
    clearForm(ctx);
    await startDealForm(ctx);
    return true;
  }

  // ── Payment method ──
  if (data === "form:payment:INR" || data === "form:payment:CRYPTO") {
    s.createDealPaymentMethod = data === "form:payment:INR" ? "INR" : "CRYPTO";
    s.createDealStep = "role";
    await ctx.editMessageText(
      "<b>CREATE DEAL</b>\n\nPayment method: <b>" + paymentLabel(s.createDealPaymentMethod) + "</b>\n\nChoose your <b>role</b>:",
      { reply_markup: roleSelect }
    );
    return true;
  }

  // ── Role ──
  if (data === "form:role:buyer" || data === "form:role:seller") {
    const role = data === "form:role:buyer" ? "buyer" : "seller";
    s.createDealRole = role;
    s.createDealStep = "counterparty";
    await ctx.editMessageText(
      `You are the <b>${role === "buyer" ? "Buyer" : "Seller"}</b>.\n\n` +
      `Enter the other party's Telegram username:\n\n<i>Example: @username</i>`,
      { reply_markup: backToMain }
    );
    return true;
  }

  // ── Crypto denomination (payment method ONLY — never a deposit address) ──
  if (data.startsWith("form:asset:")) {
    const parts = data.replace("form:asset:", "").split("_");
    s.createDealAsset = parts[0];
    s.createDealNetwork = parts[1] ?? parts[0];
    s.createDealStep = "category";
    await ctx.editMessageText(
      `<b>CREATE DEAL</b>\n\nDenomination: <b>${esc(parts[0])}${parts[1] ? " (" + esc(parts[1]) + ")" : ""}</b>\n\n` +
      "This is only the payment denomination. You will pay the escrower directly.",
      { reply_markup: categorySelect }
    );
    return true;
  }

  // ── Category ──
  if (data.startsWith("form:cat:")) {
    s.createDealCategory = data.replace("form:cat:", "");
    s.createDealStep = "description";
    await ctx.editMessageText(
      "<b>DEAL DESCRIPTION</b>\n\nDescribe what is being traded:\n\n<i>Example: Logo design for website, 3 revisions included</i>",
      { reply_markup: backToMain }
    );
    return true;
  }

  // ── Preview ──
  if (data === "form:preview") {
    await previewDealForm(ctx);
    return true;
  }

  // ── Confirm & create ──
  if (data === "form:confirm") {
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
    await ctx.reply(
      s.createDealPaymentMethod === "INR"
        ? "<b>DEAL AMOUNT</b>\n\nEnter the amount in <b>INR</b>:\n\n<i>Example: 10000</i>"
        : "<b>DEAL AMOUNT</b>\n\nEnter the amount in your chosen crypto:\n\n<i>Example: 100</i>",
      { reply_markup: backToMain }
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
          : "Example: <code>100</code>"),
        { reply_markup: backToMain }
      );
      return true; // stay on the step
    }
    s.createDealAmount = clean;

    if (s.createDealPaymentMethod === "CRYPTO") {
      s.createDealStep = "crypto_network";
      await ctx.reply(
        "Which <b>crypto denomination</b> is the payment in?",
        { reply_markup: cryptoDenominationSelect }
      );
    } else {
      // INR: no separate asset step. asset=INR, network=UPI.
      s.createDealAsset = "INR";
      s.createDealNetwork = "UPI";
      s.createDealStep = "category";
      await ctx.reply("<b>CATEGORY</b>\n\nSelect the trade category:", { reply_markup: categorySelect });
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
    s.createDealStep = "preview";
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

  await ctx.reply(
    `<b>CREATE ESCROW</b>\n\n` +
    `Payment: <b>${paymentLabel(s.createDealPaymentMethod)}</b>\n` +
    `Amount: <b>${amountStr}</b>\n` +
    `Buyer: ${buyerHandle}\n` +
    `Seller: ${sellerHandle}\n` +
    `Category: ${esc(s.createDealCategory?.replace(/_/g, " ") ?? "")}\n\n` +
    `Buyer fee (${bpsToPercent(config.buyerFeeBps)}): ${buyerFeeStr}\n` +
    `Seller fee (${bpsToPercent(config.sellerFeeBps)}): ${sellerFeeStr}\n\n` +
    `Buyer total: <b>${buyerTotalStr}</b>\n` +
    `Seller receives: <b>${sellerReceivesStr}</b>\n\n` +
    `Terms:\n${esc(s.createDealDescription ?? "")}\n\n` +
    `🔐 Payment is manually verified by the escrower.`,
    { reply_markup: formConfirm() }
  );
}

/** Build the group-post deal card (old form template style). */
export function buildDealCard(deal: any, buyerUsername: string | null, sellerUsername: string | null): string {
  const isInr = (deal.asset ?? "") === "INR" || (deal.paymentMethod ?? "") === "INR";
  const amountStr = isInr ? formatMoney(deal.amount.toString(), "INR") : formatMoney(deal.amount.toString(), deal.asset);
  const buyerFeeStr = isInr ? formatMoney(deal.buyerFeeAmount.toString(), "INR") : formatMoney(deal.buyerFeeAmount.toString(), deal.asset);
  const sellerFeeStr = isInr ? formatMoney(deal.sellerFeeAmount.toString(), "INR") : formatMoney(deal.sellerFeeAmount.toString(), deal.asset);

  return (
    `<b>╔════════════════════╗\n   ESCROW DEAL\n╚════════════════════╝</b>\n\n` +
    `Deal ID: <code>#${esc(deal.inviteCode)}</code>\n\n` +
    `👤 Buyer: @${esc(buyerUsername ?? "N/A")}\n` +
    `👤 Seller: @${esc(sellerUsername ?? "N/A")}\n\n` +
    `💳 Payment: ${esc(deal.paymentMethod === "INR" ? "INR / UPI" : "Crypto")}\n` +
    `💰 Deal Amount: <b>${amountStr}</b>\n\n` +
    `💸 Buyer Fee: ${buyerFeeStr}\n` +
    `💸 Seller Fee: ${sellerFeeStr}\n\n` +
    `📦 Category: ${esc(deal.category?.replace(/_/g, " ") ?? "")}\n\n` +
    `📝 Terms:\n${esc(deal.description)}\n\n` +
    `🔐 Payment is manually verified by the escrower.`
  );
}

/** Create the deal from the completed form, post the card to the escrow
 *  group and notify the counterparty. */
export async function createDealFromForm(ctx: MyContext) {
  const s = ctx.session;
  try {
    const buyerId = s.createDealRole === "buyer" ? s.userId : (s.createDealCounterpartyUserId ?? "");
    const sellerId = s.createDealRole === "seller" ? s.userId : (s.createDealCounterpartyUserId ?? null);
    const paymentMethod = s.createDealPaymentMethod ?? "CRYPTO";
    const asset = s.createDealAsset ?? (paymentMethod === "INR" ? "INR" : "USDT");
    const network = s.createDealNetwork ?? (paymentMethod === "INR" ? "UPI" : "TRC20");

    const deal = await dealService.create({
      buyerUserId: buyerId,
      sellerUserId: sellerId,
      sellerUsername: s.createDealCounterpartyUsername ?? "",
      amount: s.createDealAmount ?? "0",
      asset,
      network,
      paymentMethod,
      currency: paymentMethod === "INR" ? "INR" : asset,
      description: s.createDealDescription ?? "",
      category: (s.createDealCategory ?? "FREELANCE_SERVICES") as DealCategory,
    });

    // Notify counterparty
    if (s.createDealCounterpartyUserId) {
      await notificationService.notifyDealCreated(
        s.createDealCounterpartyUserId,
        deal.inviteCode,
        s.createDealAmount ?? "0",
        paymentMethod === "INR" ? "INR" : asset,
        s.createDealDescription ?? "",
        paymentLabel(paymentMethod)
      );
    }

    // Post the deal card to the configured escrow group (form entry point).
    await postDealCardToGroup(ctx, deal);

    const botInfo = await ctx.api.getMe();
    const link = `https://t.me/${botInfo.username}?start=deal_${deal.inviteCode}`;

    await ctx.reply(
      `<b>DEAL CREATED</b>\n\n` +
      `Deal ID: <code>#${deal.inviteCode}</code>\n\n` +
      `Payment: <b>${paymentLabel(paymentMethod)}</b>\n` +
      `Waiting for the ${s.createDealRole === "buyer" ? "seller" : "buyer"} to join.\n\n` +
      `Invite Link:\n<code>${link}</code>\n\n` +
      `Do NOT send any payment until both parties have joined and you see the payment instructions.`,
      {
        reply_markup: new InlineKeyboard()
          .text("Copy Deal Link", `deal:copy:${deal.inviteCode}`)
          .row()
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
  clearForm(ctx);
}

/** Post the completed deal card to the configured escrow group. */
export async function postDealCardToGroup(ctx: MyContext, deal: any) {
  const groupId = config.escrowGroupId.trim();
  if (!groupId) {
    logger.info({ dealId: deal.id }, "ESCROW_GROUP_ID not configured — deal card not posted to a group");
    return;
  }

  const buyer = deal.buyerId ? await userService.findById(deal.buyerId) : null;
  const seller = deal.sellerId ? await userService.findById(deal.sellerId) : null;
  const botInfo = await ctx.api.getMe();
  const link = `https://t.me/${botInfo.username}?start=deal_${deal.inviteCode}`;
  const cancelLink = `https://t.me/${botInfo.username}?start=cancel_${deal.inviteCode}`;

  const kb = new InlineKeyboard()
    .url("Accept Deal", link)
    .url("View Deal", link)
    .row()
    .url("Cancel Deal", cancelLink);

  try {
    await ctx.api.sendMessage(
      groupId,
      buildDealCard(deal, buyer?.username ?? null, seller?.username ?? null),
      { parse_mode: "HTML", reply_markup: kb }
    );
    logger.info({ dealId: deal.id, groupId }, "Deal card posted to escrow group");
  } catch (e) {
    logger.warn({ dealId: deal.id, groupId, err: e }, "Failed to post deal card to escrow group");
  }
}
