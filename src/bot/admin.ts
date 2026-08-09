import { InlineKeyboard } from "grammy";
import { prisma } from "../lib/db.js";
import { dealService } from "../services/dealService.js";
import { config } from "../config/index.js";
import { notificationService } from "../services/notificationService.js";
import type { MyContext } from "./context.js";
import { logger } from "../lib/logger.js";
import { esc } from "../lib/html.js";
import { formatMoney, bpsToPercent } from "../lib/money.js";
import { getPaymentInstructionsText } from "../lib/paymentInstructions.js";

/**
 * Admin / Escrower panel.
 *
 * SECURITY: every financial action below is gated server-side by
 * config.adminTelegramIds — a crafted callback from a non-admin is rejected
 * before any state changes. The bot NEVER infers payment; the escrower
 * personally verifies each payment and personally pays the seller.
 */

function amountStr(deal: any): string {
  return (deal.asset ?? "") === "INR"
    ? formatMoney(deal.amount.toString(), "INR")
    : formatMoney(deal.amount.toString(), deal.asset);
}

export async function adminDashboard(ctx: MyContext) {
  if (!ctx.from || !config.adminTelegramIds.has(ctx.from.id)) return;

  const [totalDeals, activeDeals, disputedDeals, pendingPayments, completedDeals, totalUsers] = await Promise.all([
    prisma.deal.count(),
    prisma.deal.count({ where: { status: { in: ["CREATED", "JOINED", "AWAITING_PAYMENT", "PAYMENT_REPORTED", "FUNDED", "DELIVERED", "RELEASE_REQUESTED"] } } }),
    prisma.deal.count({ where: { status: { in: ["DISPUTED", "UNDER_REVIEW"] } } }),
    prisma.deal.count({ where: { status: "PAYMENT_REPORTED" } }),
    prisma.deal.count({ where: { status: "COMPLETED" } }),
    prisma.user.count(),
  ]);

  const kb = new InlineKeyboard()
    .text("Pending Payments", "admin:pending_payments")
    .text("List Disputes", "admin:disputes")
    .row()
    .text("Stuck Deals", "admin:stuck")
    .row()
    .text("User Lookup", "admin:user_lookup_prompt");

  await ctx.reply(
    "<b>ADMIN DASHBOARD</b>\n\n" +
    "Total Users: <b>" + totalUsers + "</b>\n" +
    "Total Deals: <b>" + totalDeals + "</b>\n" +
    "Active Deals: <b>" + activeDeals + "</b>\n" +
    "Payments Awaiting Verification: <b>" + pendingPayments + "</b>\n" +
    "Disputed: <b>" + disputedDeals + "</b>\n" +
    "Completed: <b>" + completedDeals + "</b>",
    { reply_markup: kb }
  );
}

export async function listDisputes(ctx: MyContext) {
  if (!ctx.from || !config.adminTelegramIds.has(ctx.from.id)) return;

  const disputes = await prisma.dispute.findMany({
    where: { status: { in: ["OPENED", "UNDER_REVIEW"] } },
    include: { deal: { include: { buyer: true, seller: true } }, opener: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  if (disputes.length === 0) {
    await ctx.reply("<b>DISPUTES</b>\n\nNo open disputes.");
    return;
  }

  const list = disputes.map((d) => {
    const deal = d.deal;
    if (!deal) return "";
    return (
      "<b>#" + esc(deal.inviteCode) + "</b> -- " + esc(deal.status) + "\n" +
      "Amount: " + amountStr(deal) + "\n" +
      "Buyer: @" + esc(deal.buyer?.username ?? "N/A") + " | Seller: @" + esc(deal.seller?.username ?? "N/A") + "\n" +
      "Opened by: @" + esc(d.opener?.username ?? "N/A") + "\n" +
      "Reason: " + esc(d.reason.slice(0, 80)) + "\n" +
      "----------"
    );
  }).join("\n");

  await ctx.reply("<b>OPEN DISPUTES (" + disputes.length + ")</b>\n\n" + list);
}

export async function reviewDispute(ctx: MyContext) {
  if (!ctx.from || !config.adminTelegramIds.has(ctx.from.id)) return;

  const dealId = ctx.match?.[1];
  if (!dealId) {
    await ctx.reply("Usage: /review <deal_id>");
    return;
  }

  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true, seller: true, dispute: { include: { evidence: true } } },
  });

  if (!deal || !deal.dispute) {
    await ctx.reply("Deal or dispute not found.");
    return;
  }

  const evidenceList = deal.dispute.evidence.length > 0
    ? deal.dispute.evidence.map((e, i) => (i + 1) + ". " + esc(e.message)).join("\n")
    : "No evidence submitted yet.";

  const kb = new InlineKeyboard()
    .text("Release to Seller", "admin:release:" + deal.id)
    .text("Refund Buyer", "admin:refund:" + deal.id)
    .row()
    .text("Ask for More Info", "admin:ask_evidence:" + deal.id)
    .text("Assign to Me", "admin:assign:" + deal.id);

  await ctx.reply(
    "<b>DISPUTE REVIEW: #" + esc(deal.inviteCode) + "</b>\n\n" +
    "Buyer: @" + esc(deal.buyer?.username ?? "N/A") + " (" + esc(deal.buyerId) + ")\n" +
    "Seller: @" + esc(deal.seller?.username ?? "N/A") + " (" + esc(deal.sellerId ?? "") + ")\n" +
    "Amount: " + amountStr(deal) + "\n" +
    "Payment: " + esc(deal.paymentMethod === "INR" ? "INR / UPI" : "Crypto") + "\n" +
    "Status: " + esc(deal.status) + "\n\n" +
    "<b>Reason:</b> " + esc(deal.dispute.reason) + "\n\n" +
    "<b>Evidence:</b>\n" + evidenceList,
    { reply_markup: kb }
  );
}

/** Payment reports awaiting manual verification. */
async function listPendingPayments(ctx: MyContext) {
  const deals = await prisma.deal.findMany({
    where: { status: "PAYMENT_REPORTED" },
    include: { buyer: true, seller: true, paymentReports: { where: { status: "PENDING" }, orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: { paymentReportedAt: "desc" },
    take: 20,
  });

  if (deals.length === 0) {
    await ctx.reply("<b>PENDING PAYMENTS</b>\n\nNo payments awaiting verification.");
    return;
  }

  for (const deal of deals) {
    const report = deal.paymentReports[0];
    const kb = new InlineKeyboard()
      .text("\u{2705}  Verify Payment", `admin:verify_payment:${deal.id}`)
      .text("\u{274C}  Reject Payment", `admin:reject_payment:${deal.id}`)
      .row()
      .text("\u{1F50D}  Request Evidence", `admin:request_evidence:${deal.id}`);

    await ctx.reply(
      `<b>BUYER REPORTED PAYMENT</b>\n\n` +
      `Deal: #${esc(deal.inviteCode)}\n` +
      `Amount: <b>${amountStr(deal)}</b>\n` +
      `Payment: ${esc(deal.paymentMethod === "INR" ? "INR / UPI" : "Crypto")}\n` +
      `Reported by: @${esc(deal.buyer?.username ?? "N/A")}\n` +
      `Reported at: ${esc(deal.paymentReportedAt?.toISOString() ?? "?")}\n` +
      (report?.reference ? `Reference: <code>${esc(report.reference)}</code>\n` : "") +
      (report?.notes ? `Notes: ${esc(report.notes)}\n` : "") +
      (report?.evidence ? `Evidence: ${esc(report.evidence)}\n` : ""),
      { reply_markup: kb }
    );
  }
}

export async function handleAdminCallback(ctx: MyContext) {
  // Server-side authorization gate — never trust callback data.
  if (!ctx.from || !config.adminTelegramIds.has(ctx.from.id)) {
    await ctx.answerCallbackQuery("Unauthorized.").catch(() => {});
    return;
  }
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("admin:")) return;

  if (data === "admin:disputes") {
    await listDisputes(ctx);
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === "admin:pending_payments") {
    await listPendingPayments(ctx);
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === "admin:stuck") {
    const stuck = await prisma.deal.findMany({
      where: {
        OR: [
          { status: "AWAITING_PAYMENT", createdAt: { lt: new Date(Date.now() - 86_400_000) } },
          { status: "PAYMENT_REPORTED", createdAt: { lt: new Date(Date.now() - 86_400_000) } },
          { status: "RELEASE_REQUESTED", createdAt: { lt: new Date(Date.now() - 604_800_000) } },
        ],
      },
      include: { buyer: true, seller: true },
      take: 20,
    });

    if (stuck.length === 0) {
      await ctx.editMessageText("<b>STUCK DEALS</b>\n\nNone found.");
    } else {
      const list = stuck.map((d) =>
        "#" + d.inviteCode + " -- " + d.status + " -- " + amountStr(d) + " -- created " + d.createdAt.toISOString().slice(0, 10)
      ).join("\n");
      await ctx.editMessageText("<b>STUCK DEALS (" + stuck.length + ")</b>\n\n" + list);
    }
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Manual payment verification ────────────────────────────────────
  if (data.startsWith("admin:verify_payment:")) {
    const did = data.split(":")[2];
    const deal = await prisma.deal.findUnique({ where: { id: did }, include: { buyer: true, seller: true } });
    if (!deal) return;
    const buyerFee = parseFloat(deal.amount.toString()) * deal.buyerFeeBps / 10000;
    const totalPaid = parseFloat(deal.amount.toString()) + buyerFee;

    await ctx.editMessageText(
      `<b>VERIFY PAYMENT — #${esc(deal.inviteCode)}</b>\n\n` +
      `Payment: <b>${esc(deal.paymentMethod === "INR" ? "INR / UPI" : "Crypto")}</b>\n` +
      `Deal amount: <b>${amountStr(deal)}</b>\n` +
      `Buyer fee (${bpsToPercent(deal.buyerFeeBps)}): ${formatMoney(buyerFee, deal.asset === "INR" ? "INR" : deal.asset)}\n` +
      `Buyer should have paid total: <b>${formatMoney(totalPaid, deal.asset === "INR" ? "INR" : deal.asset)}</b>\n\n` +
      `💳 Payment instructions sent to the buyer:\n${getPaymentInstructionsText(deal)}\n\n` +
      `Only confirm after you have <b>personally verified the payment outside the bot</b>.`,
      {
        reply_markup: new InlineKeyboard()
          .text("\u{2705}  Confirm Verification", `admin:verify_confirm:${did}`)
          .text("\u{274C}  Reject Payment", `admin:reject_payment:${did}`)
          .row()
          .text("\u{1F50D}  Request Evidence", `admin:request_evidence:${did}`),
      }
    );
    await ctx.answerCallbackQuery();
    return;
  }

  if (data.startsWith("admin:verify_confirm:")) {
    const did = data.split(":")[2];
    try {
      const result = await dealService.verifyPayment(did, ctx.session.userId);
      const deal = await prisma.deal.findUnique({ where: { id: did }, include: { buyer: true, seller: true } });
      await ctx.editMessageText(
        `<b>PAYMENT VERIFIED</b>\n\nDeal #${esc(deal?.inviteCode ?? did)} is now <b>FUNDED</b>.\n` +
        `Buyer fee recorded: ${formatMoney(result.buyerFee, deal?.asset === "INR" ? "INR" : (deal?.asset ?? ""))}\n\n` +
        `Send the payment reference (optional) or <code>/skip</code>:`
      );
      ctx.session.pendingPaymentReferenceDealId = did;

      // Notify both parties.
      if (deal) {
        if (deal.buyer?.telegramId) {
          await ctx.api.sendMessage(Number(deal.buyer.telegramId),
            `<b>PAYMENT VERIFIED</b>\n\nDeal #${esc(deal.inviteCode)}\nThe escrower has manually verified your payment. The deal is now <b>FUNDED</b>.`,
            { parse_mode: "HTML" });
        }
        if (deal.seller?.telegramId) {
          await ctx.api.sendMessage(Number(deal.seller.telegramId),
            `<b>PAYMENT VERIFIED</b>\n\nDeal #${esc(deal.inviteCode)}\nThe escrower has manually verified the buyer's payment. You can now <b>deliver</b>.`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("Mark as Delivered", `deal:deliver:${did}`),
            });
        }
      }
    } catch (e: unknown) {
      await ctx.answerCallbackQuery(e instanceof Error ? e.message : "Error");
    }
    return;
  }

  if (data.startsWith("admin:reject_payment:")) {
    const did = data.split(":")[2];
    ctx.session.pendingRejectPaymentDealId = did;
    await ctx.editMessageText(
      "Rejecting the payment report for this deal.\n\n" +
      "Enter the <b>reason</b> (the buyer will be told why):"
    );
    return;
  }

  if (data.startsWith("admin:request_evidence:")) {
    const did = data.split(":")[2];
    const deal = await prisma.deal.findUnique({ where: { id: did }, include: { buyer: true } });
    if (deal?.buyer?.telegramId) {
      await ctx.api.sendMessage(Number(deal.buyer.telegramId),
        `<b>EVIDENCE REQUESTED</b>\n\nThe escrower needs more proof for deal #${esc(deal.inviteCode)}.\n\nSend a screenshot or the transaction/reference ID.`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("Submit Evidence", `deal:evidence:${did}`),
        });
      await prisma.escrowAuditLog.create({
        data: { dealId: did, action: "EVIDENCE_REQUESTED", userId: ctx.session.userId },
      });
    }
    await ctx.answerCallbackQuery("Evidence request sent to the buyer");
    return;
  }

  // ── Manual release confirmation (escrower pays seller outside bot) ──
  if (data.startsWith("admin:confirm_release:")) {
    const did = data.split(":")[2];
    const deal = await prisma.deal.findUnique({ where: { id: did }, include: { buyer: true, seller: true } });
    if (!deal) return;
    const sellerFee = parseFloat(deal.amount.toString()) * deal.sellerFeeBps / 10000;
    const sellerPayout = parseFloat(deal.amount.toString()) - sellerFee;

    await ctx.editMessageText(
      `<b>CONFIRM MANUAL RELEASE — #${esc(deal.inviteCode)}</b>\n\n` +
      `Amount: <b>${amountStr(deal)}</b>\n` +
      `Payment method: ${esc(deal.paymentMethod === "INR" ? "INR / UPI" : "Crypto")}\n` +
      `Seller: @${esc(deal.seller?.username ?? "N/A")}\n\n` +
      `Seller payout (${bpsToPercent(deal.sellerFeeBps)} fee): <b>${formatMoney(sellerPayout, deal.asset === "INR" ? "INR" : deal.asset)}</b>\n` +
      `Escrow fee total: <b>${formatMoney(sellerFee, deal.asset === "INR" ? "INR" : deal.asset)} (seller) + buyer fee</b>\n\n` +
      `Only confirm after you have <b>actually paid the seller outside the bot</b>.`,
      {
        reply_markup: new InlineKeyboard()
          .text("\u{2705}  Mark as Released", `admin:mark_released:${did}`)
          .text("\u{274C}  Cancel", `deal:status:${did}`),
      }
    );
    await ctx.answerCallbackQuery();
    return;
  }

  if (data.startsWith("admin:mark_released:")) {
    const did = data.split(":")[2];
    try {
      const result = await dealService.confirmManualRelease(did, ctx.session.userId);
      const deal = await prisma.deal.findUnique({ where: { id: did }, include: { buyer: true, seller: true } });
      await ctx.editMessageText(
        `<b>RELEASED</b>\n\nDeal #${esc(deal?.inviteCode ?? did)} is now <b>COMPLETED</b>.\n` +
        `Seller payout: ${formatMoney(result.sellerPayout, deal?.asset === "INR" ? "INR" : (deal?.asset ?? ""))}\n` +
        `Seller fee: ${formatMoney(result.sellerFee, deal?.asset === "INR" ? "INR" : (deal?.asset ?? ""))}\n\n` +
        `Send the payout reference (optional) or <code>/skip</code>:`
      );
      ctx.session.pendingPayoutReferenceDealId = did;

      if (deal) {
        if (deal.buyer?.telegramId) {
          await ctx.api.sendMessage(Number(deal.buyer.telegramId),
            `<b>DEAL COMPLETED</b>\n\nDeal #${esc(deal.inviteCode)}\nThe escrower has released payment to the seller. Deal is <b>COMPLETED</b>. Thank you!`,
            { parse_mode: "HTML" });
        }
        if (deal.seller?.telegramId) {
          await ctx.api.sendMessage(Number(deal.seller.telegramId),
            `<b>PAYOUT CONFIRMED</b>\n\nDeal #${esc(deal.inviteCode)}\nThe escrower paid you ${formatMoney(result.sellerPayout, deal.asset === "INR" ? "INR" : deal.asset)} (after ${bpsToPercent(deal.sellerFeeBps)} fee). Deal is <b>COMPLETED</b>.`,
            { parse_mode: "HTML" });
        }
      }
    } catch (e: unknown) {
      await ctx.answerCallbackQuery(e instanceof Error ? e.message : "Error");
    }
    return;
  }

  // ── Admin-opened dispute review from a release request ─────────────
  if (data.startsWith("admin:dispute:")) {
    const did = data.split(":")[2];
    try {
      const existing = await prisma.dispute.findUnique({ where: { dealId: did } });
      if (!existing) {
        await prisma.dispute.create({ data: { dealId: did, openedBy: ctx.session.userId, reason: "Escrower opened review" } });
      }
      await dealService.transition(did, "UNDER_REVIEW", "ADMIN");
      await ctx.answerCallbackQuery("Deal moved to review");
      await reviewDisputeById(ctx, did);
    } catch (e: unknown) {
      await ctx.answerCallbackQuery(e instanceof Error ? e.message : "Error");
    }
    return;
  }

  // ── Dispute resolution (manual, escrower acts outside the bot) ─────
  if (data.startsWith("admin:release:")) {
    const did = data.split(":")[2];
    const deal = await prisma.deal.findUnique({ where: { id: did }, include: { seller: true } });
    if (!deal) return;
    const sellerFee = parseFloat(deal.amount.toString()) * deal.sellerFeeBps / 10000;
    const sellerPayout = parseFloat(deal.amount.toString()) - sellerFee;
    await ctx.editMessageText(
      `<b>MANUAL RELEASE (DISPUTE) — #${esc(deal.inviteCode)}</b>\n\n` +
      `Seller: @${esc(deal.seller?.username ?? "N/A")}\n` +
      `Seller payout (${bpsToPercent(deal.sellerFeeBps)} fee): <b>${formatMoney(sellerPayout, deal.asset === "INR" ? "INR" : deal.asset)}</b>\n\n` +
      `Pay the seller outside the bot, then confirm.`,
      {
        reply_markup: new InlineKeyboard()
          .text("\u{2705}  Confirm Manual Release", `admin:release_confirm:${did}`)
          .text("\u{274C}  Cancel", `admin:disputes`),
      }
    );
    return;
  }

  if (data.startsWith("admin:release_confirm:")) {
    const did = data.split(":")[2];
    try {
      await dealService.manualReleaseForDispute(did, ctx.session.userId, "Admin resolved via panel (manual release)");
      const deal = await prisma.deal.findUnique({ where: { id: did }, include: { buyer: true, seller: true } });
      await ctx.editMessageText("<b>RESOLVED</b>\n\nManual release confirmed for deal " + did + ". Seller paid by escrower.");
      if (deal) {
        for (const party of [deal.buyer, deal.seller]) {
          if (party?.telegramId) {
            await ctx.api.sendMessage(Number(party.telegramId),
              `<b>DISPUTE RESOLVED</b>\n\nDeal #${esc(deal.inviteCode)}\nManual release to the seller confirmed by the escrower.`,
              { parse_mode: "HTML" });
          }
        }
      }
    } catch (e: unknown) {
      await ctx.answerCallbackQuery(e instanceof Error ? e.message : "Error");
    }
    return;
  }

  if (data.startsWith("admin:refund:")) {
    const did = data.split(":")[2];
    const deal = await prisma.deal.findUnique({ where: { id: did }, include: { buyer: true } });
    if (!deal) return;
    await ctx.editMessageText(
      `<b>MANUAL REFUND (DISPUTE) — #${esc(deal.inviteCode)}</b>\n\n` +
      `Buyer: @${esc(deal.buyer?.username ?? "N/A")}\n` +
      `Refund amount: <b>${amountStr(deal)}</b>\n\n` +
      `Refund the buyer outside the bot, then confirm.`,
      {
        reply_markup: new InlineKeyboard()
          .text("\u{2705}  Confirm Manual Refund", `admin:refund_confirm:${did}`)
          .text("\u{274C}  Cancel", `admin:disputes`),
      }
    );
    return;
  }

  if (data.startsWith("admin:refund_confirm:")) {
    const did = data.split(":")[2];
    try {
      await dealService.manualRefund(did, ctx.session.userId, "Admin resolved via panel (manual refund)");
      const deal = await prisma.deal.findUnique({ where: { id: did }, include: { buyer: true, seller: true } });
      await ctx.editMessageText("<b>RESOLVED</b>\n\nManual refund confirmed for deal " + did + ". Buyer refunded by escrower.");
      if (deal) {
        for (const party of [deal.buyer, deal.seller]) {
          if (party?.telegramId) {
            await ctx.api.sendMessage(Number(party.telegramId),
              `<b>DISPUTE RESOLVED</b>\n\nDeal #${esc(deal.inviteCode)}\nManual refund to the buyer confirmed by the escrower.`,
              { parse_mode: "HTML" });
          }
        }
      }
    } catch (e: unknown) {
      await ctx.answerCallbackQuery(e instanceof Error ? e.message : "Error");
    }
    return;
  }

  if (data.startsWith("admin:assign:")) {
    const did = data.split(":")[2];
    const dispute = await prisma.dispute.findUnique({ where: { dealId: did } });
    if (dispute) {
      await prisma.dispute.update({
        where: { id: dispute.id },
        data: { assignedAdmin: ctx.session.userId, status: "UNDER_REVIEW" },
      });
      await dealService.transition(did, "UNDER_REVIEW", "ADMIN");
      await ctx.answerCallbackQuery("Dispute assigned to you");
    }
    return;
  }

  if (data.startsWith("admin:ask_evidence:")) {
    const did = data.split(":")[2];
    const deal = await prisma.deal.findUnique({
      where: { id: did },
      include: { buyer: true, seller: true, dispute: true },
    });
    if (deal?.dispute && deal.buyer && deal.seller) {
      await notificationService.notifyDisputeOpened(
        deal.buyer.telegramId, deal.seller.telegramId, deal.inviteCode, "Admin"
      );
      await ctx.answerCallbackQuery("Evidence request sent to both parties");
    }
    return;
  }

  await ctx.answerCallbackQuery();
}

async function reviewDisputeById(ctx: MyContext, dealId: string) {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { buyer: true, seller: true, dispute: { include: { evidence: true } } },
  });
  if (!deal || !deal.dispute) return;

  const kb = new InlineKeyboard()
    .text("Release to Seller", "admin:release:" + deal.id)
    .text("Refund Buyer", "admin:refund:" + deal.id)
    .row()
    .text("Assign to Me", "admin:assign:" + deal.id);

  await ctx.reply(
    "<b>DISPUTE REVIEW: #" + esc(deal.inviteCode) + "</b>\n\n" +
    "Buyer: @" + esc(deal.buyer?.username ?? "N/A") + "\n" +
    "Seller: @" + esc(deal.seller?.username ?? "N/A") + "\n" +
    "Amount: " + amountStr(deal) + "\n" +
    "Status: " + esc(deal.status) + "\n\n" +
    "<b>Reason:</b> " + esc(deal.dispute.reason),
    { reply_markup: kb }
  );
}

export async function banUser(ctx: MyContext) {
  if (!ctx.from || !config.adminTelegramIds.has(ctx.from.id)) return;
  const parts = (ctx.message?.text ?? "").split(" ");
  const telegramId = parts[1];
  const reason = parts.slice(2).join(" ") || "No reason provided";

  if (!telegramId) {
    await ctx.reply("Usage: /ban <telegram_id> [reason]");
    return;
  }

  const user = await prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
  if (!user) {
    await ctx.reply("User not found.");
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { status: "BANNED" } });
  await prisma.adminAction.create({ data: { adminId: ctx.session.userId, actionType: "USER_BAN", reason } });

  logger.warn({ adminId: ctx.session.userId, bannedUserId: user.id, reason }, "User banned");
  await ctx.reply("User @" + esc(user.username ?? user.id) + " has been banned.\nReason: " + esc(reason));
}

export async function suspendUser(ctx: MyContext) {
  if (!ctx.from || !config.adminTelegramIds.has(ctx.from.id)) return;
  const parts = (ctx.message?.text ?? "").split(" ");
  const telegramId = parts[1];
  const reason = parts.slice(2).join(" ") || "No reason provided";

  if (!telegramId) {
    await ctx.reply("Usage: /suspend <telegram_id> [reason]");
    return;
  }

  const user = await prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
  if (!user) {
    await ctx.reply("User not found.");
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } });
  await prisma.adminAction.create({ data: { adminId: ctx.session.userId, actionType: "USER_SUSPEND", reason } });

  logger.warn({ adminId: ctx.session.userId, suspendedUserId: user.id, reason }, "User suspended");
  await ctx.reply("User @" + esc(user.username ?? user.id) + " has been suspended.\nReason: " + esc(reason));
}

export async function lookupUser(ctx: MyContext) {
  if (!ctx.from || !config.adminTelegramIds.has(ctx.from.id)) return;
  const query = ctx.match?.[1]?.replace("@", "");
  if (!query) {
    await ctx.reply("Usage: /user <telegram_id or @username>");
    return;
  }

  const isNumeric = /^[0-9]+$/.test(query);
  const user = isNumeric
    ? await prisma.user.findUnique({ where: { telegramId: BigInt(query) } })
    : await prisma.user.findFirst({ where: { username: query } });

  if (!user) {
    await ctx.reply("User not found.");
    return;
  }

  const dealCount = await prisma.deal.count({ where: { OR: [{ buyerId: user.id }, { sellerId: user.id }] } });
  const disputeCount = await prisma.dispute.count({ where: { openedBy: user.id } });

  const kb = new InlineKeyboard()
    .text("Suspend", "admin:suspend:" + user.id)
    .text("Ban", "admin:ban:" + user.id);

  const profileText =
    "<b>USER PROFILE</b>\n\n" +
    "ID: <code>" + esc(user.id) + "</code>\n" +
    "Telegram: @" + esc(user.username ?? "N/A") + " (" + esc(user.telegramId.toString()) + ")\n" +
    "Name: " + esc(user.firstName) + "\n" +
    "Status: <b>" + esc(user.status) + "</b>\n" +
    "Deals: " + dealCount + "\n" +
    "Disputes Opened: " + disputeCount + "\n" +
    "Joined: " + user.createdAt.toISOString().slice(0, 10);

  await ctx.reply(profileText, { reply_markup: kb });
}
