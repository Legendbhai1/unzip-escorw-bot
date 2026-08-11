import { InlineKeyboard } from "grammy";
import { prisma } from "../lib/db.js";
import { dealService } from "../services/dealService.js";
import { config } from "../config/index.js";
import { notificationService } from "../services/notificationService.js";
import type { MyContext } from "./context.js";
import { logger } from "../lib/logger.js";
import { esc, userMention } from "../lib/html.js";
import { formatMoney, bpsToPercent } from "../lib/money.js";
import { getPaymentInstructionsText, getAdminSetting, SETTING_KEYS } from "../lib/paymentInstructions.js";
import { updateGroupDealCard } from "./scenes/dealForm.js";
import { userService } from "../services/userService.js";
import { groupService } from "../services/groupService.js";

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
    .text("Payment Settings", "admin:settings")
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
      .text("\u{2705}  Payment Received", `admin:verify_payment:${deal.id}`)
      .text("\u{274C}  Payment Not Received", `admin:reject_payment:${deal.id}`)
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

/** Deal-scoped admin callbacks. These may be performed by global admins OR by
 *  an ACTIVE escrow admin assigned to the deal's group (see
 *  isAuthorizedForDealAction). All other admin:* callbacks stay global-admin
 *  only. Every check is server-side — callback data is never trusted. */
const DEAL_SCOPED_PREFIXES = [
  "admin:accept_deal:",
  "admin:mark_release_complete:",
  "admin:mark_refund_complete:",
  "admin:verify_payment:",
  "admin:verify_confirm:",
  "admin:reject_payment:",
  "admin:request_evidence:",
  "admin:confirm_release:",
  "admin:mark_released:",
  "admin:dispute:",
  "admin:release:",
  "admin:release_confirm:",
  "admin:refund:",
  "admin:refund_confirm:",
  "admin:assign:",
  "admin:ask_evidence:",
];

/** Global admin OR active group escrow admin of the deal's group. */
async function isAuthorizedForDealAction(telegramId: number, dealId: string): Promise<boolean> {
  if (config.adminTelegramIds.has(telegramId)) return true;
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: { groupChatId: true },
  });
  if (!deal?.groupChatId) return false;
  return groupService.isActiveGroupAdmin(deal.groupChatId, BigInt(telegramId));
}

export async function handleAdminCallback(ctx: MyContext) {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("admin:")) return;
  if (!ctx.from) {
    await ctx.answerCallbackQuery("Unauthorized.").catch(() => {});
    return;
  }

  // Server-side authorization — never trust callback data.
  const dealPrefix = DEAL_SCOPED_PREFIXES.find((p) => data.startsWith(p));
  let authorized = false;
  if (dealPrefix) {
    const dealId = data.split(":")[2];
    authorized = await isAuthorizedForDealAction(ctx.from.id, dealId);
  } else {
    authorized = config.adminTelegramIds.has(ctx.from.id);
  }
  if (!authorized) {
    await ctx.answerCallbackQuery("Unauthorized.").catch(() => {});
    return;
  }

  // ── Payment settings (admin-entered escrow receiving details) ──
  if (data === "admin:settings") {
    await showSettings(ctx);
    await ctx.answerCallbackQuery();
    return;
  }
  if (data.startsWith("admin:settings:set:")) {
    const key = data.replace("admin:settings:set:", "");
    ctx.session.pendingSettingKey = key;
    await ctx.editMessageText(
      `Enter the new value for <b>${esc(settingLabel(key))}</b>.\n\n` +
      `Current: <code>${esc((await getAdminSetting(key)) || "— not set —")}</code>\n\n` +
      `Send <code>/cancel</code> to abort.`
    );
    return;
  }

  // ── View payment methods / Remove USDT address ──
  if (data === "admin:settings:view_methods") {
    const [upiId, upiName, usdt] = await Promise.all([
      getAdminSetting(SETTING_KEYS.upiId),
      getAdminSetting(SETTING_KEYS.upiName),
      getAdminSetting(SETTING_KEYS.usdtBep20Address),
    ]);
    await ctx.editMessageText(
      "<b>PAYMENT METHODS</b>\n\n" +
      `💰 <b>INR / UPI</b>: ${upiId || upiName ? "✅ Configured" : "❌ Not configured"}\n` +
      `🪙 <b>USDT BEP20</b>: ${usdt ? "✅ Configured" : "❌ Not configured"}\n\n` +
      "Only these two methods are supported. The bot never generates or derives addresses — " +
      "the escrower's own receiving details are entered manually.",
      { reply_markup: new InlineKeyboard().text("Back", "admin:settings") }
    );
    return;
  }

  if (data === "admin:settings:remove_usdt") {
    await prisma.adminSetting.deleteMany({ where: { key: SETTING_KEYS.usdtBep20Address } });
    logger.info({ adminUserId: ctx.session.userId }, "Admin removed the USDT BEP20 escrow address");
    await ctx.editMessageText(
      "🗑 <b>USDT BEP20 address removed.</b>\n\n" +
      "Users will see \"Payment method is currently unavailable\" until a new address is set.",
      { reply_markup: new InlineKeyboard().text("Back", "admin:settings") }
    );
    return;
  }

  // ── Admin accepts a deal from the group card ──────────────────
  if (data.startsWith("admin:accept_deal:")) {
    const did = data.split(":")[2];
    await acceptDealFromGroup(ctx, did);
    return;
  }

  // ── Admin completes a manually agreed release / refund ─────────
  if (data.startsWith("admin:mark_release_complete:")) {
    const did = data.split(":")[2];
    await markReleaseComplete(ctx, did);
    return;
  }
  if (data.startsWith("admin:mark_refund_complete:")) {
    const did = data.split(":")[2];
    await markRefundComplete(ctx, did);
    return;
  }

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
    const payer = dealService.getPayerId(deal);
    const payerIsBuyer = payer === deal.buyerId;
    const payerUser = payerIsBuyer ? deal.buyer : deal.seller;

    await ctx.editMessageText(
      `<b>VERIFY PAYMENT — #${esc(deal.inviteCode)}</b>\n\n` +
      `Payment: <b>${esc(deal.paymentMethod === "INR" ? "INR / UPI" : "USDT BEP20")}</b>\n` +
      (deal.paymentMethod !== "INR" ? `Crypto payer: @${esc(payerUser?.username ?? "N/A")}\n` : "") +
      `Deal amount: <b>${amountStr(deal)}</b>\n` +
      `Buyer fee (${bpsToPercent(deal.buyerFeeBps)}): ${formatMoney(buyerFee, deal.asset === "INR" ? "INR" : deal.asset)}\n` +
      `Payer should have paid total: <b>${formatMoney(totalPaid, deal.asset === "INR" ? "INR" : deal.asset)}</b>\n\n` +
      `💳 Payment instructions sent to the payer:\n${await getPaymentInstructionsText(deal)}\n\n` +
      `Only confirm after you have <b>personally verified the payment outside the bot</b>.`,
      {
        reply_markup: new InlineKeyboard()
          .text("\u{2705}  Confirm Verification", `admin:verify_confirm:${did}`)
          .text("\u{274C}  Payment Not Received", `admin:reject_payment:${did}`)
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

      // Notify both users in DM: payment verified by escrow admin.
      if (deal) {
        const verifiedMsg =
          `🛡 <b>Deal #${esc(deal.inviteCode)}</b>\n\n` +
          `Payment verified by escrow admin.\n` +
          `@${esc(deal.buyer?.username ?? "buyer")} and @${esc(deal.seller?.username ?? "seller")}, continue the deal here.`;

        if (deal.buyer?.telegramId) {
          await ctx.api.sendMessage(Number(deal.buyer.telegramId), verifiedMsg, {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("\u{1F4CB}  View Deal", `deal:status:${did}`)
              .text("\u{1F6A8}  Dispute", `deal:dispute:${did}`),
          });
        }
        if (deal.seller?.telegramId) {
          await ctx.api.sendMessage(Number(deal.seller.telegramId), verifiedMsg, {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("\u{1F4E6}  Mark as Delivered", `deal:deliver:${did}`)
              .text("\u{1F6A8}  Dispute", `deal:dispute:${did}`),
          });
        }
        await updateGroupDealCard(ctx, deal);
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
    const reqAmount = deal.releaseRequestedAmount ? parseFloat(deal.releaseRequestedAmount.toString()) : parseFloat(deal.amount.toString());
    const sellerFee = reqAmount * deal.sellerFeeBps / 10000;
    const sellerPayout = reqAmount - sellerFee;
    const remaining = deal.remainingAmount ? parseFloat(deal.remainingAmount.toString()) : parseFloat(deal.amount.toString());

    await ctx.editMessageText(
      `<b>CONFIRM MANUAL RELEASE — #${esc(deal.inviteCode)}</b>\n\n` +
      `Release amount: <b>${formatMoney(reqAmount, deal.asset === "INR" ? "INR" : deal.asset)}</b>\n` +
      `Remaining after release: <b>${formatMoney(remaining - reqAmount, deal.asset === "INR" ? "INR" : deal.asset)}</b>\n` +
      `Payment method: ${esc(deal.paymentMethod === "INR" ? "INR / UPI" : "USDT BEP20")}\n` +
      `Seller: @${esc(deal.seller?.username ?? "N/A")}\n\n` +
      `Seller payout (${bpsToPercent(deal.sellerFeeBps)} fee): <b>${formatMoney(sellerPayout, deal.asset === "INR" ? "INR" : deal.asset)}</b>\n` +
      `Seller fee: <b>${formatMoney(sellerFee, deal.asset === "INR" ? "INR" : deal.asset)}</b>\n\n` +
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
      const remaining = deal?.remainingAmount ? parseFloat(deal.remainingAmount.toString()) : 0;
      const complete = !deal || remaining <= 0;
      await ctx.editMessageText(
        `<b>RELEASED</b>\n\nDeal #${esc(deal?.inviteCode ?? did)} ${complete ? "is now <b>COMPLETED</b>" : "— partial release recorded"}.\n` +
        `Seller payout (this release): ${formatMoney(result.sellerPayout, deal?.asset === "INR" ? "INR" : (deal?.asset ?? ""))}\n` +
        `Remaining: ${formatMoney(remaining, deal?.asset === "INR" ? "INR" : (deal?.asset ?? ""))}\n\n` +
        `Send the payout reference (optional) or <code>/skip</code>:`
      );
      ctx.session.pendingPayoutReferenceDealId = did;

      if (deal) {
        const msg = complete
          ? `<b>DEAL COMPLETED</b>\n\nDeal #${esc(deal.inviteCode)}\nThe escrower has released payment to the seller. Deal is <b>COMPLETED</b>. Thank you!`
          : `<b>PARTIAL RELEASE</b>\n\nDeal #${esc(deal.inviteCode)}\nThe escrower released ${formatMoney(parseFloat(result.sellerPayout) + parseFloat(result.sellerFee), deal.asset === "INR" ? "INR" : deal.asset)}. Remaining: ${formatMoney(remaining, deal.asset === "INR" ? "INR" : deal.asset)}.`;
        if (deal.buyer?.telegramId) {
          await ctx.api.sendMessage(Number(deal.buyer.telegramId), msg, { parse_mode: "HTML" });
        }
        if (deal.seller?.telegramId) {
          await ctx.api.sendMessage(Number(deal.seller.telegramId),
            `<b>PAYOUT CONFIRMED</b>\n\nDeal #${esc(deal.inviteCode)}\nThe escrower paid you ${formatMoney(result.sellerPayout, deal.asset === "INR" ? "INR" : deal.asset)} (after ${bpsToPercent(deal.sellerFeeBps)} fee). ${complete ? "Deal is <b>COMPLETED</b>." : `Remaining: ${formatMoney(remaining, deal.asset === "INR" ? "INR" : deal.asset)}.`}`,
            { parse_mode: "HTML" });
        }
        await updateGroupDealCard(ctx, deal);
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
      await prisma.escrowAuditLog.create({
        data: { dealId: did, action: "DISPUTE_RESOLVED", userId: ctx.session.userId, notes: "Manual release to seller (dispute resolved)" },
      });
      await ctx.editMessageText("<b>RESOLVED</b>\n\nManual release confirmed for deal " + did + ". Seller paid by escrower.");
      if (deal) {
        for (const party of [deal.buyer, deal.seller]) {
          if (party?.telegramId) {
            await ctx.api.sendMessage(Number(party.telegramId),
              `<b>DISPUTE RESOLVED</b>\n\nDeal #${esc(deal.inviteCode)}\nManual release to the seller confirmed by the escrower.`,
              { parse_mode: "HTML" });
          }
        }
        await updateGroupDealCard(ctx, deal);
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
      await prisma.escrowAuditLog.create({
        data: { dealId: did, action: "DISPUTE_RESOLVED", userId: ctx.session.userId, notes: "Manual refund to buyer (dispute resolved)" },
      });
      await ctx.editMessageText("<b>RESOLVED</b>\n\nManual refund confirmed for deal " + did + ". Buyer refunded by escrower.");
      if (deal) {
        for (const party of [deal.buyer, deal.seller]) {
          if (party?.telegramId) {
            await ctx.api.sendMessage(Number(party.telegramId),
              `<b>DISPUTE RESOLVED</b>\n\nDeal #${esc(deal.inviteCode)}\nManual refund to the buyer confirmed by the escrower.`,
              { parse_mode: "HTML" });
          }
        }
        await updateGroupDealCard(ctx, deal);
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

// ═══════════════════════════════════════════════════════════════════
// PAYMENT SETTINGS (admin-entered escrow receiving details)
// ═══════════════════════════════════════════════════════════════════

function settingLabel(key: string): string {
  const map: Record<string, string> = {
    [SETTING_KEYS.upiId]: "UPI ID",
    [SETTING_KEYS.upiName]: "UPI name",
    [SETTING_KEYS.usdtBep20Address]: "USDT BEP20 receiving address",
    [SETTING_KEYS.escrowGroupId]: "Escrow group chat id",
  };
  return map[key] ?? key;
}

async function showSettings(ctx: MyContext) {
  const [upiId, upiName, usdt, groupId] = await Promise.all([
    getAdminSetting(SETTING_KEYS.upiId),
    getAdminSetting(SETTING_KEYS.upiName),
    getAdminSetting(SETTING_KEYS.usdtBep20Address),
    getAdminSetting(SETTING_KEYS.escrowGroupId),
  ]);

  await ctx.editMessageText(
    "<b>PAYMENT SETTINGS</b>\n\n" +
    "These are the escrower's own receiving details — manually entered here, " +
    "never generated by the bot. Only authorized admins can change them.\n\n" +
    `💰 <b>INR / UPI</b>\n` +
    `UPI ID: <code>${esc(upiId || "— not set —")}</code>\n` +
    `Name: <code>${esc(upiName || "— not set —")}</code>\n\n` +
    `🪙 <b>USDT BEP20</b>\n` +
    `Address: <code>${esc(usdt || "— not set —")}</code>\n\n` +
    `👥 <b>Escrow group</b>\n` +
    `Chat id: <code>${esc(groupId || "— not set —")}</code> — new deal cards are posted here.\n\n` +
    `If a payment method has no details, users see \"Payment method is currently unavailable. Please contact an admin.\"`,
    {
      reply_markup: new InlineKeyboard()
        .text("Set UPI ID", `admin:settings:set:${SETTING_KEYS.upiId}`)
        .text("Set UPI Name", `admin:settings:set:${SETTING_KEYS.upiName}`)
        .row()
        .text("Set USDT BEP20 Address", `admin:settings:set:${SETTING_KEYS.usdtBep20Address}`)
        .row()
        .text("Set Escrow Group ID", `admin:settings:set:${SETTING_KEYS.escrowGroupId}`)
        .row()
        .text("\u{1F50D}  View Payment Methods", "admin:settings:view_methods")
        .text("\u{1F5D1}\u{FE0F}  Remove USDT Address", "admin:settings:remove_usdt")
        .row()
        .text("\u{1F3E0}  Main Menu", "menu:main"),
    }
  );
}

/** Persist an admin-entered setting (called from the text message handler). */
export async function setSettingValue(key: string, value: string, adminUserId: string) {
  const clean = value.trim();
  await prisma.adminSetting.upsert({
    where: { key },
    create: { key, value: clean, updatedBy: adminUserId },
    update: { value: clean, updatedBy: adminUserId },
  });
  logger.info({ key, adminUserId }, "Admin payment setting updated");
}

// ═══════════════════════════════════════════════════════════════════
// GROUP DEAL ACCEPTANCE + PAYMENT INSTRUCTIONS
// ═══════════════════════════════════════════════════════════════════

/** Send the payment-required message + instructions to both parties. */
async function sendPaymentInstructionsToParties(ctx: MyContext, deal: any) {
  const buyer = deal.buyer;
  const seller = deal.seller;
  const payerId = dealService.getPayerId(deal);
  const payerIsBuyer = payerId === deal.buyerId;
  const payerUser = payerIsBuyer ? buyer : seller;

  const instructions = await getPaymentInstructionsText(deal);
  const buyerFee = parseFloat(deal.amount.toString()) * deal.buyerFeeBps / 10000;
  const totalPaid = parseFloat(deal.amount.toString()) + buyerFee;
  const amountStr = (deal.asset ?? "") === "INR" ? formatMoney(deal.amount.toString(), "INR") : formatMoney(deal.amount.toString(), deal.asset);
  const cryptoPayerLine = deal.paymentMethod !== "INR"
    ? `Crypto payer: ${userMention(payerUser?.telegramId, payerUser?.username)}\n`
    : "";

  // The DM message tags the deal and the payer, and names both parties, so the
  // payer always knows exactly which deal and which party they are paying for.
  const header =
    `🛡 <b>ESCROW DEAL #${esc(deal.inviteCode)}</b>\n\n` +
    `🔐 <b>PAYMENT REQUIRED</b>\n\n` +
    `Deal: #${esc(deal.inviteCode)}\n` +
    `Buyer: ${userMention(buyer?.telegramId, buyer?.username)}\n` +
    `Seller: ${userMention(seller?.telegramId, seller?.username)}\n` +
    `Payment method: <b>${deal.paymentMethod === "INR" ? "INR / UPI" : "USDT BEP20"}</b>\n` +
    cryptoPayerLine +
    `Amount: <b>${amountStr}</b> + applicable buyer fee\n` +
    `Buyer fee: ${formatMoney(buyerFee, deal.asset === "INR" ? "INR" : deal.asset)} — total to pay: <b>${formatMoney(totalPaid, deal.asset === "INR" ? "INR" : deal.asset)}</b>\n\n` +
    `💳 <b>How to pay:</b>\n${instructions}\n\n` +
    `Payment is verified manually by the escrow admin. Only send money to the details above.`;

  for (const [user, isPayer] of [[buyer, payerIsBuyer], [seller, !payerIsBuyer]] as const) {
    if (!user?.telegramId) continue;
    const kb = new InlineKeyboard();
    if (isPayer) {
      kb.text("\u{2705}  Payment Sent / Check Payment", `deal:paid:${deal.id}`);
    } else {
      kb.text("\u{1F4CB}  View Deal", `deal:status:${deal.id}`);
    }
    kb.row().text("\u{1F3E0}  Main Menu", "menu:main");
    try {
      await ctx.api.sendMessage(Number(user.telegramId), header, { parse_mode: "HTML", reply_markup: kb });
    } catch (_e) { /* user may have blocked the bot */ }
  }

  await prisma.deal.update({
    where: { id: deal.id },
    data: { paymentInstructionsSentAt: new Date() },
  });
  await prisma.escrowAuditLog.create({
    data: {
      dealId: deal.id, action: "PAYMENT_INSTRUCTIONS_SENT",
      notes: `Payment instructions sent (payer: @${payerUser?.username ?? "N/A"})`,
    },
  });
}

/** Escrow admin accepts a deal from the group card. Server-side checks (never
 *  trusts callback data): the deal exists, belongs to an APPROVED group, the
 *  callback comes from that group, BOTH parties agreed, and the clicker is the
 *  bot owner / a global admin / an ACTIVE escrow admin for THIS group. */
async function acceptDealFromGroup(ctx: MyContext, dealId: string) {
  try {
    const deal = await prisma.deal.findUnique({ where: { id: dealId }, include: { buyer: true, seller: true } });
    if (!deal) {
      await ctx.answerCallbackQuery("Deal not found.").catch(() => {});
      return;
    }
    if (deal.acceptedAt) {
      const accepter = deal.acceptedBy ? await userService.findById(deal.acceptedBy) : null;
      await ctx.answerCallbackQuery(`Already accepted by @${accepter?.username ?? "an admin"}.`);
      return;
    }
    if (!deal.groupChatId || !(await groupService.isGroupApproved(deal.groupChatId))) {
      await ctx.answerCallbackQuery("This group is not approved for escrow operations.").catch(() => {});
      return;
    }
    const chatId = ctx.callbackQuery?.message?.chat?.id;
    if (chatId && String(chatId) !== deal.groupChatId) {
      await ctx.answerCallbackQuery("This deal belongs to another group.").catch(() => {});
      return;
    }
    if (!deal.buyerAgreedAt || !deal.sellerAgreedAt) {
      await ctx.answerCallbackQuery("Both parties must agree to the deal before it can be accepted.").catch(() => {});
      return;
    }
    if (!ctx.from || !(await groupService.isAuthorizedForGroup(ctx.from.id, deal.groupChatId))) {
      await ctx.answerCallbackQuery("Unauthorized — you are not an escrow admin for this group.").catch(() => {});
      return;
    }

    await dealService.adminAccept(dealId, ctx.session.userId);
    await ctx.answerCallbackQuery("Deal accepted \u2705").catch(() => {});

    const updated = await prisma.deal.findUnique({ where: { id: dealId }, include: { buyer: true, seller: true } });
    if (updated) {
      await sendPaymentInstructionsToParties(ctx, updated);
      await updateGroupDealCard(ctx, {
        ...updated,
        acceptedByUsername: ctx.session.username ?? ctx.session.firstName,
      });
    }
  } catch (e: unknown) {
    await ctx.answerCallbackQuery(e instanceof Error ? e.message : "Error").catch(() => {});
  }
}

/** Escrow admin marks a manually agreed release as completed. */
async function markReleaseComplete(ctx: MyContext, dealId: string) {
  try {
    const result = await dealService.confirmManualRelease(dealId, ctx.session.userId);
    const deal = await prisma.deal.findUnique({ where: { id: dealId }, include: { buyer: true, seller: true } });
    const remaining = deal?.remainingAmount ? parseFloat(deal.remainingAmount.toString()) : 0;
    const complete = !deal || remaining <= 0;

    await ctx.editMessageText(
      `<b>RELEASE COMPLETED</b>\n\nDeal #${esc(deal?.inviteCode ?? dealId)} ${complete ? "is now <b>COMPLETED</b>" : "— partial release recorded"}.\n` +
      `Seller payout (this release): ${formatMoney(result.sellerPayout, deal?.asset === "INR" ? "INR" : (deal?.asset ?? ""))}\n` +
      `Remaining: ${formatMoney(remaining, deal?.asset === "INR" ? "INR" : (deal?.asset ?? ""))}\n\n` +
      `Send the payout reference (optional) or <code>/skip</code>:`
    );
    ctx.session.pendingPayoutReferenceDealId = dealId;

    if (deal) {
      const msg = complete
        ? `🛡 <b>Deal #${esc(deal.inviteCode)}</b>\n\nThe escrower has released payment to the seller. Deal is <b>COMPLETED</b>.`
        : `🛡 <b>Deal #${esc(deal.inviteCode)}</b>\n\nPartial release recorded. Remaining: ${formatMoney(remaining, deal.asset === "INR" ? "INR" : deal.asset)}.`;
      for (const party of [deal.buyer, deal.seller]) {
        if (party?.telegramId) {
          await ctx.api.sendMessage(Number(party.telegramId), msg, { parse_mode: "HTML" });
        }
      }
      await updateGroupDealCard(ctx, deal);
    }
  } catch (e: unknown) {
    await ctx.answerCallbackQuery(e instanceof Error ? e.message : "Error").catch(() => {});
  }
}

/** Escrow admin marks a manually agreed refund as completed. */
async function markRefundComplete(ctx: MyContext, dealId: string) {
  try {
    const result = await dealService.completeManualRefund(dealId, ctx.session.userId);
    const deal = await prisma.deal.findUnique({ where: { id: dealId }, include: { buyer: true, seller: true } });
    const remaining = deal?.remainingAmount ? parseFloat(deal.remainingAmount.toString()) : 0;
    const complete = !deal || remaining <= 0;

    await ctx.editMessageText(
      `<b>REFUND COMPLETED</b>\n\nDeal #${esc(deal?.inviteCode ?? dealId)} ${complete ? "is now <b>REFUNDED</b>" : "— partial refund recorded"}.\n` +
      `Refunded (this): ${formatMoney(parseFloat(result.refundAmount), deal?.asset === "INR" ? "INR" : (deal?.asset ?? ""))}\n` +
      `Remaining: ${formatMoney(remaining, deal?.asset === "INR" ? "INR" : (deal?.asset ?? ""))}\n\n` +
      `Send the refund reference (optional) or <code>/skip</code>:`
    );
    ctx.session.pendingRefundReferenceDealId = dealId;

    if (deal) {
      const msg = complete
        ? `🛡 <b>Deal #${esc(deal.inviteCode)}</b>\n\nThe escrower has refunded the buyer. Deal is <b>REFUNDED</b>.`
        : `🛡 <b>Deal #${esc(deal.inviteCode)}</b>\n\nPartial refund recorded. Remaining: ${formatMoney(remaining, deal.asset === "INR" ? "INR" : deal.asset)}.`;
      for (const party of [deal.buyer, deal.seller]) {
        if (party?.telegramId) {
          await ctx.api.sendMessage(Number(party.telegramId), msg, { parse_mode: "HTML" });
        }
      }
      await updateGroupDealCard(ctx, deal);
    }
  } catch (e: unknown) {
    await ctx.answerCallbackQuery(e instanceof Error ? e.message : "Error").catch(() => {});
  }
}
