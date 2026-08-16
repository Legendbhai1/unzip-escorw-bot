import { InlineKeyboard } from "grammy";
import { prisma } from "../lib/db.js";
import { dealService } from "../services/dealService.js";
import { config } from "../config/index.js";
import { notificationService } from "../services/notificationService.js";
import type { MyContext } from "./context.js";
import { logger } from "../lib/logger.js";
import { esc, userMention } from "../lib/html.js";
import { formatMoney, bpsToPercent } from "../lib/money.js";
import { getPaymentInstructionsText, getAdminSetting, setAdminSetting, deleteAdminSetting, SETTING_KEYS, GLOBAL_GROUP_ID } from "../lib/paymentInstructions.js";
import { isDealChatValid } from "../lib/flow.js";
import { updateGroupDealCard, postPaymentInstructionsToGroupCard } from "./scenes/dealForm.js";
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
    // The Payment Received button reaches ONLY the admin who ACCEPTED this
    // deal (acceptedBy). Other admins — including global admins and other
    // group admins — see a read-only entry with a View Deal button. Legacy
    // rows without an acceptedBy have no assigned verifier, so nobody gets
    // the verification buttons for them.
    const isVerifier = Boolean(deal.acceptedBy) && deal.acceptedBy === ctx.session.userId;
    const assignedUsername = deal.acceptedBy
      ? (await userService.findById(deal.acceptedBy).catch(() => null))?.username
      : undefined;
    const assignedNote = assignedUsername
      ? `\n⚠️ Verification is assigned to @${esc(assignedUsername)} — only they can confirm this payment.\n`
      : "\n⚠️ This deal has no assigned accepting admin — payment verification is locked.\n";

    const kb = isVerifier
      ? new InlineKeyboard()
          .text("\u{2705}  Payment Received", `admin:verify_payment:${deal.id}`)
          .text("\u{274C}  Payment Not Received", `admin:reject_payment:${deal.id}`)
          .row()
          .text("\u{1F50D}  Request Evidence", `admin:request_evidence:${deal.id}`)
      : new InlineKeyboard().text("\u{1F4CB}  View Deal", `deal:status:${deal.id}`);

    await ctx.reply(
      `<b>BUYER REPORTED PAYMENT</b>\n\n` +
      `Deal: #${esc(deal.inviteCode)}\n` +
      `Amount: <b>${amountStr(deal)}</b>\n` +
      `Payment: ${esc(deal.paymentMethod === "INR" ? "INR / UPI" : "Crypto")}\n` +
      `Reported by: @${esc(deal.buyer?.username ?? "N/A")}\n` +
      `Reported at: ${esc(deal.paymentReportedAt?.toISOString() ?? "?")}\n` +
      (report?.reference ? `Reference: <code>${esc(report.reference)}</code>\n` : "") +
      (report?.notes ? `Notes: ${esc(report.notes)}\n` : "") +
      (report?.evidence ? `Evidence: ${esc(report.evidence)}\n` : "") +
      (deal.acceptedBy && !isVerifier ? assignedNote : ""),
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

/**
 * Payment VERIFICATION is reserved for the admin who ACCEPTED the deal
 * (acceptedBy). Another admin — even a global admin — gets "You are not the
 * admin assigned to this deal." Server-side only; never trusts callback data.
 * Legacy rows without an acceptedBy (pre-group flow) fall back to the generic
 * router-level admin authorization already performed.
 */
async function isAssignedVerifier(dealId: string, userId: string): Promise<{ ok: boolean; acceptedByUsername?: string }> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: { acceptedBy: true },
  });
  if (!deal) return { ok: false };
  if (!deal.acceptedBy) return { ok: true }; // legacy deal — generic admin auth applies
  if (deal.acceptedBy !== userId) {
    const accepter = await userService.findById(deal.acceptedBy).catch(() => null);
    return { ok: false, acceptedByUsername: accepter?.username ?? undefined };
  }
  return { ok: true };
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
  const settingsScope = settingsScopeOf(data);
  let authorized = false;
  if (settingsScope) {
    // Payment settings: group-scoped panels may be edited by the bot owner, a
    // global admin, or an ACTIVE escrow admin of THAT group; global panels
    // remain global-admin only.
    authorized = settingsScope.groupId === GLOBAL_GROUP_ID
      ? config.adminTelegramIds.has(ctx.from.id)
      : await groupService.isAuthorizedForGroup(ctx.from.id, settingsScope.groupId);
  } else if (dealPrefix) {
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
  if (settingsScope) {
    const groupId = settingsScope.groupId;
    // GROUP-ONLY: payment configuration belongs to each authorized escrow
    // group. The global DM panel is not available — there is no global
    // fallback that groups could inherit.
    if (groupId === GLOBAL_GROUP_ID) {
      await ctx.answerCallbackQuery(
        "Payment settings are configured per escrow group — run /settings inside the group."
      ).catch(() => {});
      return;
    }
    if (data === "admin:settings") {
      await showSettings(ctx, groupId);
      await ctx.answerCallbackQuery();
      return;
    }
    if (data.startsWith("admin:settings:set_g:") || data.startsWith("admin:settings:set:")) {
      const key = data.startsWith("admin:settings:set_g:")
        ? data.slice(data.lastIndexOf(":") + 1)
        : data.replace("admin:settings:set:", "");
      ctx.session.pendingSettingKey = key;
      ctx.session.pendingSettingGroupId = groupId;
      ctx.session.pendingFlowChatId = String(ctx.chat?.id ?? "");
      await ctx.editMessageText(
        `Enter the new value for <b>${esc(settingLabel(key))}</b> for ` +
        `${groupId ? `group <code>${esc(groupId)}</code>` : "the global fallback"}.\n\n` +
        `Current: <code>${esc((await getAdminSetting(key, groupId)) || "— not set —")}</code>\n\n` +
        `Send <code>/cancel</code> to abort.`
      );
      return;
    }

    // ── View payment methods / Remove USDT address (scoped to this group) ──
    if (data === "admin:settings:view_methods" || data.startsWith("admin:settings:view_methods_g:")) {
      const [upiId, upiName, usdt] = await Promise.all([
        getAdminSetting(SETTING_KEYS.upiId, groupId),
        getAdminSetting(SETTING_KEYS.upiName, groupId),
        getAdminSetting(SETTING_KEYS.usdtBep20Address, groupId),
      ]);
      await ctx.editMessageText(
        "<b>PAYMENT METHODS</b>\n\n" +
        (groupId ? `Scope: <b>group <code>${esc(groupId)}</code></b>\n\n` : `Scope: <b>global</b>\n\n`) +
        `💰 <b>INR / UPI</b>: ${upiId || upiName ? "✅ Configured" : "❌ Not configured"}\n` +
        `🪙 <b>USDT BEP20</b>: ${usdt ? "✅ Configured" : "❌ Not configured"}\n\n` +
        "Only these two methods are supported. The bot never generates or derives addresses — " +
        "the escrower's own receiving details are entered manually.",
        { reply_markup: new InlineKeyboard().text("Back", groupId ? `admin:settings_g:${groupId}` : "admin:settings") }
      );
      return;
    }

    if (data === "admin:settings:remove_usdt" || data.startsWith("admin:settings:remove_usdt_g:")) {
      await deleteAdminSetting(SETTING_KEYS.usdtBep20Address, groupId);
      logger.info({ adminUserId: ctx.session.userId, groupId }, "Admin removed the USDT BEP20 escrow address");
      await ctx.editMessageText(
        "🗑 <b>USDT BEP20 address removed.</b>\n\n" +
        "Users will see \"Payment method is not configured for this group\" until a new address is set.",
        { reply_markup: new InlineKeyboard().text("Back", groupId ? `admin:settings_g:${groupId}` : "admin:settings") }
      );
      return;
    }
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

  // ── Manual payment verification (ONLY the admin who accepted the deal) ──
  if (data.startsWith("admin:verify_payment:")) {
    const did = data.split(":")[2];
    const verifier = await isAssignedVerifier(did, ctx.session.userId);
    if (!verifier.ok) {
      await ctx.answerCallbackQuery(
        verifier.acceptedByUsername
          ? `You are not the admin assigned to this deal (assigned to @${verifier.acceptedByUsername}).`
          : "You are not the admin assigned to this deal."
      ).catch(() => {});
      return;
    }
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
    const verifier = await isAssignedVerifier(did, ctx.session.userId);
    if (!verifier.ok) {
      await ctx.answerCallbackQuery(
        verifier.acceptedByUsername
          ? `You are not the admin assigned to this deal (assigned to @${verifier.acceptedByUsername}).`
          : "You are not the admin assigned to this deal."
      ).catch(() => {});
      return;
    }
    try {
      const result = await dealService.verifyPayment(did, ctx.session.userId);
      const deal = await prisma.deal.findUnique({ where: { id: did }, include: { buyer: true, seller: true } });
      await ctx.editMessageText(
        `<b>PAYMENT RECEIVED</b>\n\nDeal #${esc(deal?.inviteCode ?? did)} — the escrower has confirmed the payment.\n` +
        `Buyer fee recorded: ${formatMoney(result.buyerFee, deal?.asset === "INR" ? "INR" : (deal?.asset ?? ""))}\n\n` +
        `Send the payment reference (optional) or <code>/skip</code>:`
      );
      ctx.session.pendingPaymentReferenceDealId = did;
      ctx.session.pendingFlowChatId = String(ctx.chat?.id ?? "");

      // GROUP-FIRST: the group deal card is updated to the terminal
      // PAYMENT_RECEIVED state ("🟢 PAYMENT RECEIVED ✅ — CONTINUE THE DEAL
      // MANUALLY") and the bot stops. Then BOTH participants get one short
      // green confirmation DM (no buttons, no follow-up flow) — this is the
      // terminal notification of the deal; delivery/payout continue manually
      // outside the bot.
      if (deal) {
        await updateGroupDealCard(ctx, deal);
        const confirmedBy = ctx.session.username ?? ctx.session.firstName ?? "escrow admin";
        const finalMsg =
          `🟢 <b>PAYMENT RECEIVED</b>\n\n` +
          `Deal #${esc(deal.inviteCode)}\n\n` +
          `Payment has been confirmed by @${esc(confirmedBy)}.\n\n` +
          `You can continue the deal manually.`;
        for (const party of [deal.buyer, deal.seller]) {
          if (party?.telegramId) {
            await ctx.api.sendMessage(Number(party.telegramId), finalMsg, { parse_mode: "HTML" }).catch(() => {});
          }
        }
      }
    } catch (e: unknown) {
      await ctx.answerCallbackQuery(e instanceof Error ? e.message : "Error");
    }
    return;
  }

  if (data.startsWith("admin:reject_payment:")) {
    const did = data.split(":")[2];
    const verifier = await isAssignedVerifier(did, ctx.session.userId);
    if (!verifier.ok) {
      await ctx.answerCallbackQuery(
        verifier.acceptedByUsername
          ? `You are not the admin assigned to this deal (assigned to @${verifier.acceptedByUsername}).`
          : "You are not the admin assigned to this deal."
      ).catch(() => {});
      return;
    }
    ctx.session.pendingRejectPaymentDealId = did;
    ctx.session.pendingFlowChatId = String(ctx.chat?.id ?? "");
    await ctx.editMessageText(
      "Rejecting the payment report for this deal.\n\n" +
      "Enter the <b>reason</b> (the buyer will be told why):"
    );
    return;
  }

  if (data.startsWith("admin:request_evidence:")) {
    const did = data.split(":")[2];
    const verifier = await isAssignedVerifier(did, ctx.session.userId);
    if (!verifier.ok) {
      await ctx.answerCallbackQuery(
        verifier.acceptedByUsername
          ? `You are not the admin assigned to this deal (assigned to @${verifier.acceptedByUsername}).`
          : "You are not the admin assigned to this deal."
      ).catch(() => {});
      return;
    }
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
      ctx.session.pendingFlowChatId = String(ctx.chat?.id ?? "");

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

/**
 * The group scope a settings callback refers to, or null when the callback is
 * not a payment-settings callback. "" (GLOBAL_GROUP_ID) = the global fallback.
 */
function settingsScopeOf(data: string): { groupId: string } | null {
  if (data === "admin:settings" || data.startsWith("admin:settings_g:")) {
    if (data.startsWith("admin:settings_g:")) return { groupId: data.slice("admin:settings_g:".length) };
    return { groupId: GLOBAL_GROUP_ID };
  }
  if (data.startsWith("admin:settings:set_g:")) {
    const rest = data.slice("admin:settings:set_g:".length);
    const i = rest.lastIndexOf(":");
    if (i > 0) return { groupId: rest.slice(0, i) };
    return null;
  }
  if (data.startsWith("admin:settings:set:")) return { groupId: GLOBAL_GROUP_ID };
  if (data.startsWith("admin:settings:view_methods_g:")) return { groupId: data.slice("admin:settings:view_methods_g:".length) };
  if (data === "admin:settings:view_methods") return { groupId: GLOBAL_GROUP_ID };
  if (data.startsWith("admin:settings:remove_usdt_g:")) return { groupId: data.slice("admin:settings:remove_usdt_g:".length) };
  if (data === "admin:settings:remove_usdt") return { groupId: GLOBAL_GROUP_ID };
  return null;
}

/** Build the payment-settings panel text + keyboard for a scope. */
export async function buildSettingsPanel(groupId: string, groupTitle?: string) {
  const [upiId, upiName, usdt] = await Promise.all([
    getAdminSetting(SETTING_KEYS.upiId, groupId),
    getAdminSetting(SETTING_KEYS.upiName, groupId),
    getAdminSetting(SETTING_KEYS.usdtBep20Address, groupId),
  ]);
  const isGlobal = groupId === GLOBAL_GROUP_ID;
  const scopeLine = isGlobal
    ? "<b>GLOBAL</b> — used by groups that have not set their own details"
    : `Group: <b>${esc(groupTitle ?? groupId)}</b> — used for deals posted to this group`;
  const groupVariant = isGlobal ? "" : `_g:${groupId}`;
  const backData = isGlobal ? "admin:settings" : `admin:settings_g:${groupId}`;

  const keyboard = new InlineKeyboard()
    .text("Set UPI ID", `admin:settings:set${groupVariant}:${SETTING_KEYS.upiId}`)
    .text("Set UPI Name", `admin:settings:set${groupVariant}:${SETTING_KEYS.upiName}`)
    .row()
    .text("Set USDT BEP20 Address", `admin:settings:set${groupVariant}:${SETTING_KEYS.usdtBep20Address}`);
  if (isGlobal) {
    keyboard.row().text("Set Escrow Group ID", `admin:settings:set:${SETTING_KEYS.escrowGroupId}`);
  }
  keyboard
    .row()
    .text("\u{1F50D}  View Payment Methods", `admin:settings:view_methods${groupVariant}`)
    .text("\u{1F5D1}\u{FE0F}  Remove USDT Address", `admin:settings:remove_usdt${groupVariant}`)
    .row()
    .text("\u{1F3E0}  Main Menu", "menu:main");

  const text =
    "<b>PAYMENT SETTINGS</b>\n\n" +
    `Scope: ${scopeLine}\n\n` +
    "These are the escrower's own receiving details — manually entered here, " +
    "never generated by the bot. Only the bot owner, a global admin or this " +
    "group's escrow admin can change them.\n\n" +
    `💰 <b>INR / UPI</b>\n` +
    `UPI ID: <code>${esc(upiId || "— not set —")}</code>\n` +
    `Name: <code>${esc(upiName || "— not set —")}</code>\n\n` +
    `🪙 <b>USDT BEP20</b>\n` +
    `Address: <code>${esc(usdt || "— not set —")}</code>\n\n` +
    `If a payment method has no details for this group, users see:\n` +
    `\"Payment method is not configured for this group. Ask an escrow admin to run /settings.\"`;

  return { text, keyboard };
}

async function showSettings(ctx: MyContext, groupId: string = GLOBAL_GROUP_ID, groupTitle?: string) {
  const panel = await buildSettingsPanel(groupId, groupTitle);
  await ctx.editMessageText(panel.text, { reply_markup: panel.keyboard });
}

/** Persist an admin-entered setting (called from the text message handler). */
export async function setSettingValue(key: string, value: string, adminUserId: string, groupId: string = GLOBAL_GROUP_ID) {
  await setAdminSetting(key, value, adminUserId, groupId);
  logger.info({ key, groupId, adminUserId }, "Admin payment setting updated");
}

// ═══════════════════════════════════════════════════════════════════
// GROUP DEAL ACCEPTANCE + PAYMENT INSTRUCTIONS
// ═══════════════════════════════════════════════════════════════════

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
    const cbChat = ctx.callbackQuery?.message?.chat;
    if (cbChat && !isDealChatValid(cbChat.type, cbChat.id, deal.groupChatId)) {
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
      // GROUP-FIRST: the deal card itself becomes the payment instructions
      // (amount + this group's escrow details + [I've Paid]) — nothing is
      // DMed to the parties.
      await postPaymentInstructionsToGroupCard(
        ctx,
        updated,
        ctx.session.username ?? ctx.session.firstName
      );
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
    ctx.session.pendingFlowChatId = String(ctx.chat?.id ?? "");

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
    ctx.session.pendingFlowChatId = String(ctx.chat?.id ?? "");

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
