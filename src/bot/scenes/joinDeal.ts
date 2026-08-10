import { InlineKeyboard } from "grammy";
import { userService } from "../../services/userService.js";
import { dealService } from "../../services/dealService.js";
import { acceptRejectDeal, backToMain, dealActions } from "../keyboards/index.js";
import { config } from "../../config/index.js";
import { esc } from "../../lib/html.js";
import { formatMoney, bpsToPercent } from "../../lib/money.js";
import { getPaymentInstructionsText, hasPaymentInstructions } from "../../lib/paymentInstructions.js";

type Ctx = any;

function paymentLabel(deal: any): string {
  return deal.paymentMethod === "INR" ? "INR / UPI" : "USDT BEP20";
}

function dealAmountStr(deal: any): string {
  return (deal.asset ?? "") === "INR"
    ? formatMoney(deal.amount.toString(), "INR")
    : formatMoney(deal.amount.toString(), deal.asset);
}

export async function handleJoinDeal(ctx: Ctx, inviteCode: string) {
  const userId = ctx.session.userId;
  const deal = await dealService.findByInviteCode(inviteCode);

  if (!deal) {
    await ctx.reply("Deal not found or expired.", { reply_markup: backToMain });
    return;
  }

  if (["COMPLETED", "CANCELLED", "REFUNDED", "RELEASED", "EXPIRED"].includes(deal.status)) {
    await ctx.reply(`This deal is already <b>${deal.status}</b>.`, { reply_markup: backToMain });
    return;
  }

  if (deal.status !== "CREATED") {
    await showDealStatus(ctx, deal.id);
    return;
  }

  if (deal.buyerId === userId) {
    await ctx.reply("You cannot join your own deal.", { reply_markup: backToMain });
    return;
  }

  const buyer = deal.buyerId ? await userService.findById(deal.buyerId) : null;
  ctx.session.lastDealId = deal.id;

  const buyerFeePct = bpsToPercent(deal.buyerFeeBps ?? config.buyerFeeBps);
  const sellerFeePct = bpsToPercent(deal.sellerFeeBps ?? config.sellerFeeBps);

  await ctx.reply(
    `<b>ESCROW DEAL</b>\n\n` +
    `Deal #<code>${esc(deal.inviteCode)}</code>\n\n` +
    `Payment: <b>${paymentLabel(deal)}</b>\n` +
    `Amount: <b>${dealAmountStr(deal)}</b>\n` +
    `Buyer: @${esc(buyer?.username ?? "N/A")}\n` +
    `Seller: @${esc(ctx.session.username ?? ctx.session.firstName)}\n\n` +
    `Buyer fee: ${buyerFeePct}\n` +
    `Seller fee: ${sellerFeePct}\n\n` +
    `Description:\n${esc(deal.description)}\n\n` +
    `🔐 Payment is manually verified by the escrower.\n\n` +
    `Do you accept these terms?`,
    { reply_markup: acceptRejectDeal() }
  );

  ctx.session.pendingJoinDealId = deal.id;
}

export async function handleAcceptDeal(ctx: Ctx) {
  const dealId = ctx.session.pendingJoinDealId;
  if (!dealId) return;
  ctx.session.lastDealId = dealId;

  try {
    await dealService.join(dealId, ctx.session.userId);
    const deal = await dealService.findWithParties(dealId);

    await ctx.reply(
      `<b>DEAL ACCEPTED</b>\n\n` +
      `Both parties have joined.\n\n` +
      `🔐 <b>PAYMENT REQUIRED</b>\n\n` +
      `Payment method: <b>${deal ? paymentLabel(deal) : ""}</b>\n` +
      `Amount: <b>${deal ? dealAmountStr(deal) : ""}</b>\n\n` +
      `${deal ? await paymentInstructionsBlock(deal) : ""}\n\n` +
      `After you have paid the escrower, tap <b>I've Paid</b> below.`,
      {
        reply_markup: new InlineKeyboard()
          .text("\u{2705}  I've Paid", `deal:paid:${dealId}`)
          .row()
          .text("\u{1F3E0}  Main Menu", "menu:main"),
      }
    );

    // Notify the buyer with the same payment instructions.
    if (deal?.buyer?.telegramId && deal.buyerId !== ctx.session.userId) {
      try {
        await ctx.api.sendMessage(
          Number(deal.buyer.telegramId),
          `<b>DEAL ACCEPTED</b>\n\n` +
          `Both parties have joined.\n\n` +
          `🔐 <b>PAYMENT REQUIRED</b>\n\n` +
          `Payment method: <b>${paymentLabel(deal)}</b>\n` +
          `Amount: <b>${dealAmountStr(deal)}</b>\n\n` +
          `${await paymentInstructionsBlock(deal)}\n\n` +
          `After you have paid the escrower, tap <b>I've Paid</b> below.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("\u{2705}  I've Paid", `deal:paid:${dealId}`)
              .row()
              .text("\u{1F3E0}  Main Menu", "menu:main"),
          }
        );
      } catch (_e) { /* buyer may have blocked bot */ }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await ctx.reply(esc(msg), { reply_markup: backToMain });
  }

  delete ctx.session.pendingJoinDealId;
}

/** Payment instructions block — configured escrower details or a clear
 *  "unavailable" fallback. NEVER an auto-generated address. */
async function paymentInstructionsBlock(deal: any): Promise<string> {
  if (await hasPaymentInstructions(deal)) {
    return `💳 <b>How to pay:</b>\n${await getPaymentInstructionsText(deal)}`;
  }
  return "Payment method is currently unavailable. Please contact an admin.";
}

export async function showDealStatus(ctx: Ctx, dealId: string) {
  const deal = await dealService.findWithParties(dealId);
  if (!deal) {
    await ctx.reply("Deal not found.", { reply_markup: backToMain });
    return;
  }

  const statusEmoji: Record<string, string> = {
    CREATED: "\u{1F9ED}", JOINED: "\u{1F91D}",
    AWAITING_PAYMENT: "\u{1F4B3}", PAYMENT_REPORTED: "\u{1F4DD}",
    FUNDED: "\u{2705}", IN_PROGRESS: "\u{1F6E0}\u{FE0F}", DELIVERED: "\u{1F4E6}",
    RELEASE_PENDING: "\u{23F3}", RELEASE_REQUESTED: "\u{23F3}",
    RELEASED: "\u{1F4B8}", COMPLETED: "\u{2705}",
    DISPUTED: "\u{26A0}\u{FE0F}", UNDER_REVIEW: "\u{1F50D}",
    REFUNDED: "\u{1F4B0}", CANCELLED: "\u{274C}", EXPIRED: "\u{23F0}",
  };

  const statusLabel = deal.status.replace(/_/g, " ");
  const emoji = statusEmoji[deal.status] ?? "";
  const isBuyer = deal.buyerId === ctx.session.userId;
  const roleLabel = isBuyer ? "Buyer" : "Seller";

  const paymentOk = ["FUNDED", "IN_PROGRESS", "DELIVERED", "RELEASE_PENDING", "RELEASE_REQUESTED", "RELEASED", "COMPLETED"].includes(deal.status);
  const deliveryOk = ["DELIVERED", "RELEASE_PENDING", "RELEASE_REQUESTED", "RELEASED", "COMPLETED"].includes(deal.status);
  const releaseOk = ["RELEASED", "COMPLETED"].includes(deal.status);

  const buyerFeePct = bpsToPercent(deal.buyerFeeBps ?? config.buyerFeeBps);
  const sellerFeePct = bpsToPercent(deal.sellerFeeBps ?? config.sellerFeeBps);

  await ctx.reply(
    `<b>ESCROW DEAL #${esc(deal.inviteCode)}</b>\n\n` +
    `Status: ${emoji} <b>${esc(statusLabel)}</b>\n\n` +
    `Your role: ${esc(roleLabel)}\n` +
    `Payment: <b>${paymentLabel(deal)}</b>\n` +
    `Buyer: @${esc(deal.buyer?.username ?? "N/A")}\n` +
    `Seller: @${esc(deal.seller?.username ?? "N/A")}\n\n` +
    `Amount: <b>${dealAmountStr(deal)}</b>\n` +
    `Buyer fee: ${buyerFeePct}\n` +
    `Seller fee: ${sellerFeePct}\n\n` +
    `Item: ${esc(deal.description)}\n\n` +
    `Payment: ${paymentOk ? "Verified" : "Pending"}\n` +
    `Delivery: ${deliveryOk ? "Done" : "Pending"}\n` +
    `Release: ${releaseOk ? "Done" : "Pending"}\n\n` +
    `Created: ${deal.createdAt.toISOString().slice(0, 10)}`,
    { reply_markup: dealActions(deal.id, deal.status) }
  );
}
