import { InlineKeyboard } from "grammy";
import { userService } from "../../services/userService.js";
import { dealService } from "../../services/dealService.js";
import { acceptRejectDeal, backToMain, dealActions } from "../keyboards/index.js";

type Ctx = any;

export async function handleJoinDeal(ctx: Ctx, inviteCode: string) {
  const userId = ctx.session.userId;
  const deal = await dealService.findByInviteCode(inviteCode);

  if (!deal) {
    await ctx.reply("Deal not found or expired.", { reply_markup: backToMain });
    return;
  }

  if (["COMPLETED", "CANCELLED", "REFUNDED"].includes(deal.status)) {
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
  await ctx.reply(
    `<b>ESCROW DEAL</b>

` +
    `Deal #<code>${deal.inviteCode}</code>

` +
    `Buyer: @${buyer?.username ?? "N/A"}\n` +
    `Seller: @${ctx.session.username ?? ctx.session.firstName}\n
` +
    `Amount: ${deal.amount} ${deal.asset}\n` +
    `Description:\n${deal.description}\n
` +
    `Do you accept these terms?`,
    { reply_markup: acceptRejectDeal() }
  );

  ctx.session.pendingJoinDealId = deal.id;
}

export async function handleAcceptDeal(ctx: Ctx) {
  const dealId = ctx.session.pendingJoinDealId;
  if (!dealId) return;

  try {
    await dealService.join(dealId, ctx.session.userId);
    await ctx.reply(
      `<b>DEAL ACCEPTED</b>\n\n` +
      `Both parties have joined. The buyer must now deposit funds to their wallet,\n` +
      `then the deal will auto-fund from their available balance.\n\n` +
      `Go to Wallet -> Deposit to add funds.`,
      { reply_markup: backToMain }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await ctx.reply(`${msg}`, { reply_markup: backToMain });
  }

  delete ctx.session.pendingJoinDealId;
}

export async function showDealStatus(ctx: Ctx, dealId: string) {
  const deal = await dealService.findWithParties(dealId);
  if (!deal) {
    await ctx.reply("Deal not found.", { reply_markup: backToMain });
    return;
  }

  const statusEmoji: Record<string, string> = {
    CREATED: "\u{1F9ED}", JOINED: "\u{1F91D}", AWAITING_DEPOSIT: "\u{1F4B0}",
    FUNDED: "\u{2705}", IN_PROGRESS: "\u{1F6E0}\u{FE0F}", DELIVERED: "\u{1F4E6}",
    RELEASE_PENDING: "\u{23F3}", RELEASED: "\u{1F4B8}", COMPLETED: "\u{2705}",
    DISPUTED: "\u{26A0}\u{FE0F}", UNDER_REVIEW: "\u{1F50D}",
    REFUNDED: "\u{1F4B0}", CANCELLED: "\u{274C}",
  };

  const statusLabel = deal.status.replace(/_/g, " ");
  const emoji = statusEmoji[deal.status] ?? "";
  const isBuyer = deal.buyerId === ctx.session.userId;
  const roleLabel = isBuyer ? "Buyer" : "Seller";

  const paymentOk = ["FUNDED", "IN_PROGRESS", "DELIVERED", "RELEASE_PENDING", "RELEASED", "COMPLETED"].includes(deal.status);
  const deliveryOk = ["DELIVERED", "RELEASE_PENDING", "RELEASED", "COMPLETED"].includes(deal.status);
  const releaseOk = ["RELEASED", "COMPLETED"].includes(deal.status);

  await ctx.reply(
    `<b>ESCROW DEAL #${deal.inviteCode}</b>\n\n` +
    `Status: ${emoji} <b>${statusLabel}</b>\n\n` +
    `Your role: ${roleLabel}\n` +
    `Buyer: @${deal.buyer?.username ?? "N/A"}\n` +
    `Seller: @${deal.seller?.username ?? "N/A"}\n\n` +
    `Amount: ${deal.amount} ${deal.asset}\n` +
    `Network: ${deal.network}\n` +
    `Item: ${deal.description}\n\n` +
    `Payment: ${paymentOk ? "Secured" : "Pending"}\n` +
    `Delivery: ${deliveryOk ? "Done" : "Pending"}\n` +
    `Release: ${releaseOk ? "Done" : "Pending"}\n\n` +
    `Created: ${deal.createdAt.toISOString().slice(0, 10)}`,
    { reply_markup: dealActions(deal.id, deal.status) }
  );
}
