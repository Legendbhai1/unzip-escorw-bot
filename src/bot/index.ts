import { Bot, InlineKeyboard, session } from "grammy";
import { config } from "../config/index.js";
import { redis } from "../lib/redis.js";
import { userService } from "../services/userService.js";
import { dealService } from "../services/dealService.js";
import { notificationService } from "../services/notificationService.js";
import { mainMenu, backToMain, dealTabs } from "./keyboards/index.js";
import { handleJoinDeal, handleAcceptDeal, showDealStatus } from "./scenes/joinDeal.js";
import { handleAcceptRelease, handleDeliver, handleDispute, handleDisputeReason } from "./scenes/depositDeliveryRelease.js";
import { showHistory, showMyDeals } from "./scenes/walletAndDeals.js";
import {
  startDealForm, processDealFormCallback, processDealFormText,
} from "./scenes/dealForm.js";
import { logger } from "../lib/logger.js";
import { esc } from "../lib/html.js";
import type { MyContext, SessionData } from "./context.js";
import { adminDashboard, listDisputes, reviewDispute, handleAdminCallback, banUser, suspendUser, lookupUser } from "./admin.js";

// ─── Bot Setup ────────────────────────────────────────────────────────
const bot = new Bot<MyContext>(config.botToken);

// ─── Global HTML parse-mode ───────────────────────────────────────────
// Every sendMessage / editMessageText goes through this transformer so HTML
// formatting (<b>, <i>, <code>) renders everywhere. User-provided text is
// escaped at the call sites via esc() — see src/lib/html.ts. An explicit
// parse_mode on a call (if ever added) is never overridden.
bot.api.config.use((prev, method, payload, signal) => {
  if (method === "sendMessage" || method === "editMessageText") {
    const p = payload as Record<string, unknown>;
    if (typeof p.text === "string" && !p.parse_mode) {
      p.parse_mode = "HTML";
    }
  }
  return prev(method, payload, signal);
});

// ─── Session Middleware (Redis-backed with in-memory fallback) ─────────
bot.use(session({
  initial: (): SessionData => ({
    userId: "", telegramId: 0, username: null, firstName: "",
  }),
  storage: {
    async read(key: string) {
      try {
        const v = await redis.get(`session:${key}`);
        return v ? JSON.parse(v) : undefined;
      } catch {
        return undefined;
      }
    },
    async write(key: string, val: unknown) {
      try {
        await redis.set(`session:${key}`, JSON.stringify(val), "EX", 86400);
      } catch { /* ignore */ }
    },
    async delete(key: string) {
      try {
        await redis.del(`session:${key}`);
      } catch { /* ignore */ }
    },
  },
}));

// ─── Auth Middleware ──────────────────────────────────────────────────
bot.use(async (ctx, next) => {
  const tgUser = ctx.from;
  if (!tgUser) return;

  const user = await userService.findOrCreate(
    BigInt(tgUser.id),
    tgUser.username,
    tgUser.first_name
  );

  ctx.session.userId = user.id;
  ctx.session.telegramId = Number(user.telegramId);
  ctx.session.username = user.username;
  ctx.session.firstName = user.firstName;

  await next();
});

// ─── /start Command ───────────────────────────────────────────────────
bot.command("start", async (ctx) => {
  const arg = ctx.match?.[1];
  if (arg?.startsWith("deal_")) {
    await handleJoinDeal(ctx, arg.slice(5));
    return;
  }
  if (arg?.startsWith("cancel_")) {
    const inviteCode = arg.slice(7);
    const deal = await dealService.findByInviteCode(inviteCode);
    if (!deal) {
      await ctx.reply("Deal not found or expired.", { reply_markup: backToMain });
      return;
    }
    const userId = ctx.session.userId;
    if (deal.buyerId !== userId && deal.sellerId !== userId) {
      await ctx.reply("Only a party to this deal can cancel it.", { reply_markup: backToMain });
      return;
    }
    try {
      await dealService.cancel(deal.id, userId);
      await ctx.reply(`Deal #${esc(deal.inviteCode)} cancelled.`, { reply_markup: backToMain });
    } catch (e: unknown) {
      await ctx.reply(esc(e instanceof Error ? e.message : "Cannot cancel this deal"), { reply_markup: backToMain });
    }
    return;
  }

  await ctx.reply(
    "<b>ESCROW</b>\n\nSecure your trades with a manually-verified escrow.\n\n" +
    "The escrower personally verifies payment and pays the seller — the bot never holds your funds.\n\n" +
    "Create a deal and let us protect the transaction.",
    { reply_markup: mainMenu }
  );
});

// ─── /form Command + "form" text (same canonical flow as the button) ──
// The form collects deal details, so it only starts in a private chat.
bot.command("form", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  await startDealForm(ctx);
});
bot.hears(/^\s*\/?form\s*$/i, async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  await startDealForm(ctx);
});

// ─── Callback Query Router ─────────────────────────────────────────────
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;

  // Admin callbacks first (server-side authorized inside handleAdminCallback)
  if (data.startsWith("admin:")) {
    await handleAdminCallback(ctx);
    return;
  }

  // ── Main Menu ──
  if (data === "menu:main") {
    ctx.session.createDealStep = undefined;
    await ctx.editMessageText(
      "<b>ESCROW</b>\n\nSecure your trades with a manually-verified escrow.",
      { reply_markup: mainMenu }
    );
    return;
  }

  // ── Create Deal (canonical form flow) ──
  if (data === "menu:create_deal") {
    await startDealForm(ctx);
    return;
  }

  // ── Deal form callbacks ──
  if (data.startsWith("form:")) {
    const handled = await processDealFormCallback(ctx, data);
    if (handled) await ctx.answerCallbackQuery().catch(() => {});
    return;
  }

  // ── My Deals ──
  if (data === "menu:my_deals") {
    await ctx.editMessageText("<b>MY DEALS</b>\n\nLoading...", { reply_markup: dealTabs });
    await showMyDeals(ctx, "active");
    return;
  }
  if (data.startsWith("deals:")) {
    const tab = data.split(":")[1] as "active" | "completed" | "disputed";
    await showMyDeals(ctx, tab);
    return;
  }

  // ── Transactions / Payment History (no deposit, no wallet balances) ──
  if (data === "menu:history") {
    await showHistory(ctx);
    return;
  }

  // ── How It Works ──
  if (data === "menu:how_it_works") {
    await ctx.editMessageText(
      "<b>HOW IT WORKS</b>\n\n" +
      "1. Create a deal (button, /form or the word \"form\")\n" +
      "2. Both parties join and agree to the terms\n" +
      "3. You get the escrower's payment instructions\n" +
      "4. Buyer pays the escrower directly (UPI or crypto)\n" +
      "5. Buyer taps \"I've Paid\"\n" +
      "6. The escrower personally verifies the payment\n" +
      "7. Seller delivers the item/service\n" +
      "8. Buyer accepts; the escrower manually pays the seller\n" +
      "9. Deal is marked completed\n\n" +
      "If anything goes wrong, either party can open a dispute.\n\n" +
      "🔐 The bot never holds, sends or withdraws funds.",
      { reply_markup: backToMain }
    );
    return;
  }

  // ── Support ──
  if (data === "menu:support") {
    await ctx.editMessageText("<b>SUPPORT</b>\n\nFor help, contact: @admin", { reply_markup: backToMain });
    return;
  }

  // ── Deal: Accept / Reject ──
  if (data === "deal:accept") {
    await handleAcceptDeal(ctx);
    return;
  }
  if (data === "deal:reject") {
    await ctx.editMessageText("Deal rejected.", { reply_markup: backToMain });
    return;
  }

  // ── Deal: Status ──
  if (data.startsWith("deal:status:")) {
    const dealId = data.split(":")[2];
    await showDealStatus(ctx, dealId);
    return;
  }

  // ── Deal: Buyer reports "I've Paid" (manual payment) ──
  if (data.startsWith("deal:paid:")) {
    const dealId = data.split(":")[2];
    const deal = await dealService.findWithParties(dealId);
    if (!deal) {
      await ctx.answerCallbackQuery("Deal not found.");
      return;
    }
    if (deal.buyerId !== ctx.session.userId) {
      await ctx.answerCallbackQuery("Only the buyer can report payment.");
      return;
    }
    ctx.session.pendingPaymentReportDealId = dealId;
    await ctx.answerCallbackQuery("Let's record your payment.");
    await ctx.reply(
      `<b>REPORT PAYMENT</b>\n\nDeal #${esc(deal.inviteCode)}\n\n` +
      `Send the <b>payment reference / transaction ID</b> (optional), or send <code>/skip</code>.\n` +
      `You may also attach a <b>screenshot</b> as evidence.\n\n` +
      `Note: this only <i>reports</i> your payment — the escrower verifies it manually.`,
      { reply_markup: backToMain }
    );
    return;
  }

  // ── Deal: Buyer submits requested evidence ──
  if (data.startsWith("deal:evidence:")) {
    const dealId = data.split(":")[2];
    ctx.session.pendingEvidenceDealId = dealId;
    await ctx.answerCallbackQuery("Send your evidence.");
    await ctx.reply(
      "Send a <b>screenshot</b> or describe the payment details as text:",
      { reply_markup: backToMain }
    );
    return;
  }

  // ── Deal: Accept & Release (requests manual release — no auto payout) ──
  if (data.startsWith("deal:release:")) {
    const dealId = data.split(":")[2];
    await handleAcceptRelease(ctx, dealId);
    return;
  }

  // ── Deal: Deliver ──
  if (data.startsWith("deal:deliver:")) {
    const dealId = data.split(":")[2];
    await handleDeliver(ctx, dealId);
    return;
  }

  // ── Deal: Dispute ──
  if (data.startsWith("deal:dispute:")) {
    const dealId = data.split(":")[2];
    await handleDispute(ctx, dealId);
    return;
  }

  // ── Deal: Cancel ──
  if (data.startsWith("deal:cancel:")) {
    const dealId = data.split(":")[2];
    try {
      await dealService.cancel(dealId, ctx.session.userId);
      await ctx.editMessageText("Deal cancelled.", { reply_markup: backToMain });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      await ctx.answerCallbackQuery(msg);
    }
    return;
  }

  // ── Deal: Copy invite ──
  if (data.startsWith("deal:copy:")) {
    await ctx.answerCallbackQuery("Invite link copied!");
    return;
  }
});

// ─── Text Message Handler ─────────────────────────────────────────────
bot.on("message:text", async (ctx, next) => {
  const text = ctx.message.text.trim();

  // 1. Dispute reason
  if (ctx.session.pendingDisputeDealId) {
    await handleDisputeReason(ctx, text);
    return;
  }

  // 2. Buyer reports payment (reference or notes after "I've Paid")
  if (ctx.session.pendingPaymentReportDealId) {
    const dealId = ctx.session.pendingPaymentReportDealId;
    delete ctx.session.pendingPaymentReportDealId;
    if (text.toLowerCase() === "/skip") {
      await completePaymentReport(ctx, dealId, {});
    } else {
      await completePaymentReport(ctx, dealId, { reference: text });
    }
    return;
  }

  // 3. Buyer submits evidence as text
  if (ctx.session.pendingEvidenceDealId) {
    const dealId = ctx.session.pendingEvidenceDealId;
    delete ctx.session.pendingEvidenceDealId;
    await submitEvidence(ctx, dealId, text, undefined);
    return;
  }

  // 4. Admin: rejection reason
  if (ctx.session.pendingRejectPaymentDealId) {
    const dealId = ctx.session.pendingRejectPaymentDealId;
    delete ctx.session.pendingRejectPaymentDealId;
    try {
      await dealService.rejectPayment(dealId, ctx.session.userId, text);
      const deal = await dealService.findWithParties(dealId);
      await ctx.reply(`Payment report rejected for deal #${esc(deal?.inviteCode ?? dealId)}.`);
      if (deal?.buyer?.telegramId) {
        await ctx.api.sendMessage(
          Number(deal.buyer.telegramId),
          `<b>PAYMENT REJECTED</b>\n\nDeal #${esc(deal.inviteCode)}\nThe escrower could not verify your payment.\n\nReason: ${esc(text)}\n\nYou can pay again and re-report.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("\u{2705}  I've Paid", `deal:paid:${dealId}`),
          }
        );
      }
    } catch (e: unknown) {
      await ctx.reply(esc(e instanceof Error ? e.message : "Could not reject payment"));
    }
    return;
  }

  // 5. Admin: optional payment reference after verifying
  if (ctx.session.pendingPaymentReferenceDealId) {
    const dealId = ctx.session.pendingPaymentReferenceDealId;
    delete ctx.session.pendingPaymentReferenceDealId;
    if (text.toLowerCase() !== "/skip") {
      const { prisma } = await import("../lib/db.js");
      await prisma.deal.update({ where: { id: dealId }, data: { paymentReference: text } });
      await ctx.reply(`Payment reference recorded for deal #${esc(dealId)}.`);
    } else {
      await ctx.reply("No reference recorded.");
    }
    return;
  }

  // 6. Admin: optional payout reference after marking released
  if (ctx.session.pendingPayoutReferenceDealId) {
    const dealId = ctx.session.pendingPayoutReferenceDealId;
    delete ctx.session.pendingPayoutReferenceDealId;
    if (text.toLowerCase() !== "/skip") {
      const { prisma } = await import("../lib/db.js");
      await prisma.deal.update({ where: { id: dealId }, data: { payoutReference: text } });
      await ctx.reply(`Payout reference recorded for deal #${esc(dealId)}.`);
    } else {
      await ctx.reply("No reference recorded.");
    }
    return;
  }

  // 7. Deal form text steps (counterparty / amount / description)
  if (ctx.session.createDealStep) {
    const handled = await processDealFormText(ctx, text);
    if (handled) return;
  }

  await next();
});

// ─── Photo handler: evidence / payment screenshot ──────────────────────
bot.on("message:photo", async (ctx) => {
  const fileId = ctx.message.photo?.[ctx.message.photo.length - 1]?.file_id;

  if (ctx.session.pendingPaymentReportDealId) {
    const dealId = ctx.session.pendingPaymentReportDealId;
    delete ctx.session.pendingPaymentReportDealId;
    const caption = ctx.message.caption?.trim() ?? "";
    await completePaymentReport(ctx, dealId, {
      evidence: fileId,
      reference: caption || undefined,
      notes: caption || undefined,
    });
    return;
  }

  if (ctx.session.pendingEvidenceDealId) {
    const dealId = ctx.session.pendingEvidenceDealId;
    delete ctx.session.pendingEvidenceDealId;
    const caption = ctx.message.caption?.trim() ?? "";
    await submitEvidence(ctx, dealId, caption, fileId);
    return;
  }
});

// ─── Payment report completion (shared by text + photo) ────────────────
async function completePaymentReport(
  ctx: MyContext,
  dealId: string,
  opts: { reference?: string; evidence?: string; notes?: string }
) {
  try {
    await dealService.reportPayment(dealId, ctx.session.userId, opts);
    const deal = await dealService.findWithParties(dealId);
    await ctx.reply(
      `<b>PAYMENT REPORTED</b>\n\nDeal #${esc(deal?.inviteCode ?? dealId)}\n` +
      `The escrower has been notified and will verify your payment manually.`,
      { reply_markup: backToMain }
    );

    await notificationService.notifyAdmins(
      `<b>BUYER REPORTED PAYMENT</b>\n\n` +
      `Deal: #${esc(deal?.inviteCode ?? dealId)}\n` +
      `Amount: <b>${esc(deal?.amount?.toString() ?? "")} ${esc(deal?.asset ?? "")}</b>\n` +
      `Payment: ${esc(deal?.paymentMethod === "INR" ? "INR / UPI" : "Crypto")}\n` +
      `Reported by: @${esc(ctx.session.username ?? ctx.session.firstName)}${opts.reference ? `\nReference: <code>${esc(opts.reference)}</code>` : ""}${opts.evidence ? "\n📎 Screenshot attached" : ""}`,
      new InlineKeyboard()
        .text("\u{2705}  Verify Payment", `admin:verify_payment:${dealId}`)
        .text("\u{274C}  Reject Payment", `admin:reject_payment:${dealId}`)
        .row()
        .text("\u{1F50D}  Request Evidence", `admin:request_evidence:${dealId}`)
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await ctx.reply(esc(msg), { reply_markup: backToMain });
  }
}

// ─── Evidence submission (text or photo) ───────────────────────────────
async function submitEvidence(ctx: MyContext, dealId: string, text: string, fileId?: string) {
  try {
    const { prisma } = await import("../lib/db.js");
    const report = await prisma.paymentReport.findFirst({
      where: { dealId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    });

    if (!report) {
      // No pending report — record against the deal's evidence field instead.
      await prisma.deal.update({
        where: { id: dealId },
        data: {
          paymentEvidence: fileId ?? text,
          ...(text ? { paymentNotes: text } : {}),
        },
      });
    } else {
      await prisma.paymentReport.update({
        where: { id: report.id },
        data: {
          ...(fileId ? { evidence: fileId } : {}),
          ...(text ? { notes: report.notes ? `${report.notes}\n${text}` : text } : {}),
        },
      });
    }

    await prisma.escrowAuditLog.create({
      data: { dealId, action: "EVIDENCE_SUBMITTED", userId: ctx.session.userId, notes: fileId ? "Screenshot submitted" : text },
    });

    await ctx.reply(
      fileId
        ? "<b>EVIDENCE SUBMITTED</b>\n\nYour screenshot has been sent to the escrower."
        : "<b>EVIDENCE SUBMITTED</b>\n\nYour details have been sent to the escrower.",
      { reply_markup: backToMain }
    );

    await notificationService.notifyAdmins(
      `<b>EVIDENCE SUBMITTED</b>\n\nDeal: #${esc(dealId)}\nBy: @${esc(ctx.session.username ?? ctx.session.firstName)}\n` +
      (fileId ? "📎 Screenshot attached." : `Notes: ${esc(text)}`),
      new InlineKeyboard().text("Review", `admin:verify_payment:${dealId}`)
    );
  } catch (e: unknown) {
    await ctx.reply(esc(e instanceof Error ? e.message : "Could not submit evidence"), { reply_markup: backToMain });
  }
}

// ─── Admin Commands ──────────────────────────────────────────────────
bot.command("admin", adminDashboard);
bot.command("disputes", listDisputes);
bot.command("review", reviewDispute);
bot.command("ban", banUser);
bot.command("suspend", suspendUser);
bot.command("user", lookupUser);

// ─── Error Handler ────────────────────────────────────────────────────
bot.catch((err) => {
  logger.error({ err }, "Bot error");
});

export { bot };
