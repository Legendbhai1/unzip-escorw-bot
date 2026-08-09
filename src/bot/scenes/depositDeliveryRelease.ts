import { InlineKeyboard } from "grammy";
import { dealService } from "../../services/dealService.js";
import { notificationService } from "../../services/notificationService.js";
import { backToMain } from "../keyboards/index.js";
import { esc } from "../../lib/html.js";
import { formatMoney, bpsToPercent } from "../../lib/money.js";

type Ctx = any;

function dealAmountStr(deal: any): string {
  return (deal.asset ?? "") === "INR"
    ? formatMoney(deal.amount.toString(), "INR")
    : formatMoney(deal.amount.toString(), deal.asset);
}

/** Seller marks the deal as delivered (FUNDED -> DELIVERED). */
export async function handleDeliver(ctx: Ctx, dealId: string) {
  const deal = await dealService.findWithParties(dealId);
  if (!deal) {
    await ctx.reply("Deal not found.", { reply_markup: backToMain });
    return;
  }

  if (deal.sellerId !== ctx.session.userId) {
    await ctx.reply("Only the seller can mark delivery.", { reply_markup: backToMain });
    return;
  }

  try {
    await dealService.transition(dealId, "DELIVERED", "SELLER");
    await ctx.reply(
      "<b>DELIVERY MARKED</b>\n\nThe buyer has been notified.",
      { reply_markup: backToMain }
    );

    if (deal.buyer?.telegramId) {
      try {
        await ctx.api.sendMessage(
          Number(deal.buyer.telegramId),
          `<b>SELLER MARKED DEAL AS DELIVERED</b>\n\nDeal #${esc(deal.inviteCode)}\nPlease verify that you received what was agreed.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("Accept & Release", `deal:release:${dealId}`)
              .text("I Did Not Receive It", `deal:dispute:${dealId}`),
          }
        );
      } catch (_e) { /* buyer may have blocked bot */ }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await ctx.reply(esc(msg), { reply_markup: backToMain });
  }
}

/**
 * Buyer accepts delivery -> RELEASE_REQUESTED. This does NOT release any funds
 * automatically: the escrower manually pays the seller outside the bot and
 * then confirms the release (admin flow).
 */
export async function handleAcceptRelease(ctx: Ctx, dealId: string) {
  const deal = await dealService.findWithParties(dealId);
  if (!deal) {
    await ctx.reply("Deal not found.", { reply_markup: backToMain });
    return;
  }

  if (deal.buyerId !== ctx.session.userId) {
    await ctx.reply("Only the buyer can accept delivery.", { reply_markup: backToMain });
    return;
  }

  if (deal.status !== "DELIVERED") {
    await ctx.reply(`Cannot accept from ${esc(deal.status)} state.`);
    return;
  }

  try {
    await dealService.requestRelease(dealId, ctx.session.userId);
    await ctx.reply(
      `<b>RELEASE REQUESTED</b>\n\n` +
      `You accepted the delivery.\n\n` +
      `The escrower will now <b>manually pay the seller</b> outside the bot and mark the deal as released.`,
      { reply_markup: backToMain }
    );

    // Notify the escrower/admins: only they can confirm the manual release.
    const sellerFeeBps = deal.sellerFeeBps;
    const sellerFee = parseFloat(deal.amount.toString()) * sellerFeeBps / 10000;
    const sellerPayout = parseFloat(deal.amount.toString()) - sellerFee;

    await notificationService.notifyAdmins(
      `<b>RELEASE REQUESTED</b>\n\n` +
      `Deal: #${esc(deal.inviteCode)}\n` +
      `Amount: <b>${dealAmountStr(deal)}</b>\n` +
      `Payment method: ${deal.paymentMethod === "INR" ? "INR / UPI" : "Crypto"}\n` +
      `Seller: @${esc(deal.seller?.username ?? "N/A")}\n\n` +
      `Seller payout (${bpsToPercent(sellerFeeBps)} fee): <b>${formatMoney(sellerPayout, deal.asset === "INR" ? "INR" : deal.asset)}</b>\n\n` +
      `Pay the seller manually outside the bot, then confirm.`,
      new InlineKeyboard()
        .text("\u{2705}  Confirm Manual Release", `admin:confirm_release:${dealId}`)
        .row()
        .text("\u{1F6A8}  Open Dispute", `admin:dispute:${dealId}`)
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await ctx.reply(esc(msg), { reply_markup: backToMain });
  }
}

/** Buyer opens a dispute. Payment must already be manually verified. */
export async function handleDispute(ctx: Ctx, dealId: string) {
  await ctx.reply(
    `<b>OPEN DISPUTE</b>\n\nOpening a dispute will freeze the deal.\n\nPlease explain the issue:`,
    { reply_markup: backToMain }
  );
  ctx.session.pendingDisputeDealId = dealId;
}

export async function handleDisputeReason(ctx: Ctx, reason: string) {
  const dealId = ctx.session.pendingDisputeDealId;
  if (!dealId) return;

  try {
    await dealService.openDispute(dealId, ctx.session.userId, reason);
    await ctx.reply(
      `<b>DISPUTE OPENED</b>\n\nDeal is now frozen.\nAn administrator will review the case.\n\nDo not send funds outside the escrow.`,
      { reply_markup: backToMain }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await ctx.reply(esc(msg), { reply_markup: backToMain });
  }

  delete ctx.session.pendingDisputeDealId;
}
