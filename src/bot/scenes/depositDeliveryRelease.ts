import { InlineKeyboard } from "grammy";
import { dealService } from "../../services/dealService.js";
import { backToMain } from "../keyboards/index.js";

type Ctx = any;

export async function handleRelease(ctx: Ctx, dealId: string) {
  const deal = await dealService.findWithParties(dealId);
  if (!deal) {
    await ctx.reply("Deal not found.", { reply_markup: backToMain });
    return;
  }

  if (deal.buyerId !== ctx.session.userId) {
    await ctx.reply("Only the buyer can release funds.", { reply_markup: backToMain });
    return;
  }

  if (deal.status !== "DELIVERED") {
    await ctx.reply(`Cannot release from ${deal.status} state.`);
    return;
  }

  await ctx.reply(
    `<b>CONFIRM RELEASE</b>

You are about to release:
${deal.amount} ${deal.asset}
to: @${deal.seller?.username ?? "N/A"}

This action cannot normally be reversed.`,
    {
      reply_markup: new InlineKeyboard()
        .text("Confirm Release", `deal:release_confirm:${dealId}`)
        .text("Cancel", `deal:status:${dealId}`),
    }
  );
}

export async function handleReleaseConfirm(ctx: Ctx, dealId: string) {
  try {
    await dealService.release(dealId);
    const deal = await dealService.findWithParties(dealId);
    await ctx.reply(
      `<b>DEAL COMPLETED</b>

${deal?.amount} ${deal?.asset} released to @${deal?.seller?.username ?? "N/A"}.

Deal ID: #${deal?.inviteCode}`,
      { reply_markup: backToMain }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await ctx.reply(msg, { reply_markup: backToMain });
  }
}

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

    // Notify buyer
    if (deal.buyer?.telegramId) {
      try {
        await ctx.api.sendMessage(
          Number(deal.buyer.telegramId),
          `<b>SELLER MARKED DEAL AS DELIVERED</b>\n\nDeal #${deal.inviteCode}\nPlease verify that you received what was agreed.`,
          {
            reply_markup: new InlineKeyboard()
              .text("Accept & Release", `deal:release:${dealId}`)
              .text("I Did not Receive It", `deal:dispute:${dealId}`),
          }
        );
      } catch (_e) { /* buyer may have blocked bot */ }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await ctx.reply(msg, { reply_markup: backToMain });
  }
}

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
    await ctx.reply(msg, { reply_markup: backToMain });
  }

  delete ctx.session.pendingDisputeDealId;
}
