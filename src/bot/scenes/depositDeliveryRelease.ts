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
 * Buyer accepts delivery -> full release request. This does NOT release any
 * funds and does NOT notify the escrower yet: the counterparty must agree
 * first (RELEASE AGREEMENT), then the escrower is notified and pays the
 * seller manually outside the bot.
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
    ctx.session.lastDealId = dealId;
    await ctx.reply(
      `<b>RELEASE REQUESTED</b>\n\n` +
      `You accepted the delivery.\n\n` +
      `The other party must now <b>agree</b> before the escrower pays the seller.`,
      { reply_markup: backToMain }
    );

    // Ask the counterparty for agreement.
    const counterparty = deal.buyerId === ctx.session.userId ? deal.seller : deal.buyer;
    if (counterparty?.telegramId) {
      try {
        await ctx.api.sendMessage(
          Number(counterparty.telegramId),
          `🛡 <b>Deal #${esc(deal.inviteCode)}</b>\n\n` +
          `A <b>release request</b> has been made for the full amount.\n\n` +
          `Do you agree to release the escrow to the seller?`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("\u{2705}  Agree", `deal:release_agree:${dealId}`)
              .text("\u{274C}  Reject", `deal:release_reject:${dealId}`)
              .row()
              .text("\u{1F6A8}  Dispute", `deal:dispute:${dealId}`),
          }
        );
      } catch (_e) { /* counterparty may have blocked bot */ }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await ctx.reply(esc(msg), { reply_markup: backToMain });
  }
}

/**
 * Participant requests a release (partial or full) via /release. Validates
 * the requester is a participant, the deal permits release, the amount is
 * positive and does not exceed the remaining escrow, then asks the
 * counterparty to agree.
 */
export async function handleReleaseCommand(ctx: Ctx, deal: any, amount?: string) {
  try {
    await dealService.requestRelease(deal.id, ctx.session.userId, amount);
    ctx.session.lastDealId = deal.id;

    const reqAmt = amount ?? (deal.remainingAmount ? parseFloat(deal.remainingAmount.toString()).toString() : deal.amount.toString());
    await ctx.reply(
      `<b>RELEASE REQUESTED</b>\n\n` +
      `Amount: <b>${formatMoney(parseFloat(reqAmt), deal.asset === "INR" ? "INR" : deal.asset)}</b>\n` +
      `The other party must <b>agree</b> before the escrower pays the seller.`,
      { reply_markup: backToMain }
    );

    const counterparty = deal.buyerId === ctx.session.userId ? deal.seller : deal.buyer;
    if (counterparty?.telegramId) {
      try {
        await ctx.api.sendMessage(
          Number(counterparty.telegramId),
          `🛡 <b>Deal #${esc(deal.inviteCode)}</b>\n\n` +
          `A <b>release request</b> has been made: <b>${formatMoney(parseFloat(reqAmt), deal.asset === "INR" ? "INR" : deal.asset)}</b>.\n\n` +
          `Do you agree?`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("\u{2705}  Agree", `deal:release_agree:${deal.id}`)
              .text("\u{274C}  Reject", `deal:release_reject:${deal.id}`)
              .row()
              .text("\u{1F6A8}  Dispute", `deal:dispute:${deal.id}`),
          }
        );
      } catch (_e) { /* counterparty may have blocked bot */ }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await ctx.reply(esc(msg), { reply_markup: backToMain });
  }
}

/**
 * Participant requests a refund (partial or full) via /refund. The
 * counterparty must agree before the escrower refunds the buyer manually.
 */
export async function handleRefundCommand(ctx: Ctx, deal: any, amount?: string) {
  try {
    await dealService.requestRefund(deal.id, ctx.session.userId, amount);
    ctx.session.lastDealId = deal.id;

    const reqAmt = amount ?? (deal.remainingAmount ? parseFloat(deal.remainingAmount.toString()).toString() : deal.amount.toString());
    await ctx.reply(
      `<b>REFUND REQUESTED</b>\n\n` +
      `Amount: <b>${formatMoney(parseFloat(reqAmt), deal.asset === "INR" ? "INR" : deal.asset)}</b>\n` +
      `The other party must <b>agree</b> before the escrower refunds the buyer.`,
      { reply_markup: backToMain }
    );

    const counterparty = deal.buyerId === ctx.session.userId ? deal.seller : deal.buyer;
    if (counterparty?.telegramId) {
      try {
        await ctx.api.sendMessage(
          Number(counterparty.telegramId),
          `🛡 <b>Deal #${esc(deal.inviteCode)}</b>\n\n` +
          `A <b>refund request</b> has been made: <b>${formatMoney(parseFloat(reqAmt), deal.asset === "INR" ? "INR" : deal.asset)}</b>.\n\n` +
          `Do you agree?`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("\u{2705}  Agree", `deal:refund_agree:${deal.id}`)
              .text("\u{274C}  Reject", `deal:refund_reject:${deal.id}`)
              .row()
              .text("\u{1F6A8}  Dispute", `deal:dispute:${deal.id}`),
          }
        );
      } catch (_e) { /* counterparty may have blocked bot */ }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await ctx.reply(esc(msg), { reply_markup: backToMain });
  }
}

/** Counterparty agrees to a pending release request -> notify the escrower. */
export async function handleReleaseAgree(ctx: Ctx, dealId: string, agree: boolean) {
  const deal = await dealService.findWithParties(dealId);
  if (!deal) {
    await ctx.reply("Deal not found.", { reply_markup: backToMain });
    return;
  }
  try {
    const res = await dealService.agreeRelease(dealId, ctx.session.userId, agree);
    if (!res.agreed) {
      await ctx.reply("You rejected the release request. The deal continues.", { reply_markup: backToMain });
      return;
    }
    await ctx.reply(
      `<b>RELEASE AGREED</b>\n\n` +
      `You agreed to the release. The escrower has been notified and will pay the seller manually.`,
      { reply_markup: backToMain }
    );

    const reqAmount = deal.releaseRequestedAmount ? parseFloat(deal.releaseRequestedAmount.toString()).toString() : deal.amount.toString();
    const sellerFeeBps = deal.sellerFeeBps;
    const sellerFee = parseFloat(reqAmount) * sellerFeeBps / 10000;
    const sellerPayout = parseFloat(reqAmount) - sellerFee;

    await notificationService.notifyAdmins(
      `<b>RELEASE AGREED — PAYOUT NEEDED</b>\n\n` +
      `Deal: #${esc(deal.inviteCode)}\n` +
      `Release: <b>${formatMoney(parseFloat(reqAmount), deal.asset === "INR" ? "INR" : deal.asset)}</b>\n` +
      `Payment: ${deal.paymentMethod === "INR" ? "INR / UPI" : "USDT BEP20"}\n` +
      (deal.paymentMethod !== "INR" ? `Crypto payer: ${deal.cryptoPayer === "SELLER" ? "Seller" : "Buyer"}\n` : "") +
      `Buyer: @${esc(deal.buyer?.username ?? "N/A")}\n` +
      `Seller: @${esc(deal.seller?.username ?? "N/A")}\n\n` +
      `Seller payout (${bpsToPercent(sellerFeeBps)} fee): <b>${formatMoney(sellerPayout, deal.asset === "INR" ? "INR" : deal.asset)}</b>\n\n` +
      `Pay the seller manually outside the bot, then mark it complete.`,
      new InlineKeyboard()
        .text("\u{2705}  Mark Release Completed", `admin:mark_release_complete:${dealId}`)
        .row()
        .text("\u{1F6A8}  Open Dispute", `admin:dispute:${dealId}`),
      { dealId }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await ctx.reply(esc(msg), { reply_markup: backToMain });
  }
}

/** Counterparty agrees to a pending refund request -> notify the escrower. */
export async function handleRefundAgree(ctx: Ctx, dealId: string, agree: boolean) {
  const deal = await dealService.findWithParties(dealId);
  if (!deal) {
    await ctx.reply("Deal not found.", { reply_markup: backToMain });
    return;
  }
  try {
    const res = await dealService.agreeRefund(dealId, ctx.session.userId, agree);
    if (!res.agreed) {
      await ctx.reply("You rejected the refund request. The deal continues.", { reply_markup: backToMain });
      return;
    }
    await ctx.reply(
      `<b>REFUND AGREED</b>\n\n` +
      `You agreed to the refund. The escrower has been notified and will refund the buyer manually.`,
      { reply_markup: backToMain }
    );

    const reqAmount = deal.refundRequestedAmount ? parseFloat(deal.refundRequestedAmount.toString()).toString() : deal.amount.toString();

    await notificationService.notifyAdmins(
      `<b>REFUND AGREED — REFUND NEEDED</b>\n\n` +
      `Deal: #${esc(deal.inviteCode)}\n` +
      `Refund: <b>${formatMoney(parseFloat(reqAmount), deal.asset === "INR" ? "INR" : deal.asset)}</b>\n` +
      `Payment: ${deal.paymentMethod === "INR" ? "INR / UPI" : "USDT BEP20"}\n` +
      `Buyer: @${esc(deal.buyer?.username ?? "N/A")}\n` +
      `Seller: @${esc(deal.seller?.username ?? "N/A")}\n\n` +
      `Refund the buyer manually outside the bot, then mark it complete.`,
      new InlineKeyboard()
        .text("\u{2705}  Mark Refund Completed", `admin:mark_refund_complete:${dealId}`)
        .row()
        .text("\u{1F6A8}  Open Dispute", `admin:dispute:${dealId}`),
      { dealId }
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
  // Chat-bind the capture: only a message typed in the chat where the prompt
  // was sent may become the dispute reason — a message typed in any other
  // chat must never be interpreted by this old question.
  ctx.session.pendingDisputeDealId = dealId;
  ctx.session.pendingFlowChatId = String(ctx.chat?.id ?? "");
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
  delete ctx.session.pendingFlowChatId;
}
