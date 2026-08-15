import { Bot, InlineKeyboard, session } from "grammy";
import { config, isBotOwner } from "../config/index.js";
import { redis } from "../lib/redis.js";
import { userService } from "../services/userService.js";
import { groupService } from "../services/groupService.js";
import { dealService } from "../services/dealService.js";
import { notificationService } from "../services/notificationService.js";
import { mainMenu, backToMain, dealTabs } from "./keyboards/index.js";
import { handleJoinDeal, handleAcceptDeal, showDealStatus } from "./scenes/joinDeal.js";
import { handleDispute, handleDisputeReason } from "./scenes/depositDeliveryRelease.js";
import { showHistory, showMyDeals } from "./scenes/walletAndDeals.js";
import {
  startDealForm, processDealFormCallback, processDealFormText,
  handleAgreeToDeal,
} from "./scenes/dealForm.js";
import { logger } from "../lib/logger.js";
import { esc } from "../lib/html.js";
import { isDealChatValid } from "../lib/flow.js";
import { canTransition } from "../lib/stateMachine.js";
import type { MyContext, SessionData } from "./context.js";
import { adminDashboard, listDisputes, reviewDispute, handleAdminCallback, banUser, suspendUser, lookupUser, setSettingValue } from "./admin.js";
import { updateGroupDealCard, postPaymentInstructionsToGroupCard } from "./scenes/dealForm.js";

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
// Redis provides cross-instance sessions. When Redis is unavailable (no
// REDIS_URL configured) we fall back to an in-process Map so multi-step
// flows (deal form, payment report, evidence) still work on a single
// instance. Without this fallback the session step is never persisted, the
// first text step of the form (the counterparty username) is silently
// dropped, and the bot never advances past "Enter the username".
const memorySessionStore = new Map<string, string>();
let redisOk = false;

/** Called from src/index.ts after the Redis connect attempt. */
export function setSessionRedisOk(ok: boolean) {
  redisOk = ok;
}

bot.use(session({
  initial: (): SessionData => ({
    userId: "", telegramId: 0, username: null, firstName: "",
  }),
  // CRITICAL for group support: key sessions per-user (ctx.from.id), NOT
  // per-chat. grammY's default getSessionKey is ctx.chatId, which in a shared
  // escrow group would give every member the SAME session — colliding form
  // state, lastDealId and pending flows between users and breaking inline
  // callbacks. Keying by from.id isolates each user's flow in every chat.
  getSessionKey: (ctx) => {
    const fromId = ctx.from?.id;
    if (fromId != null) return `u${fromId}`;
    return ctx.chatId != null ? `c${ctx.chatId}` : undefined;
  },
  storage: {
    async read(key: string) {
      const memory = memorySessionStore.get(key);
      try {
        if (redisOk) {
          const v = await redis.get(`session:${key}`);
          if (v) return JSON.parse(v);
        }
      } catch { /* fall through to memory */ }
      return memory ? JSON.parse(memory) : undefined;
    },
    async write(key: string, val: unknown) {
      const data = JSON.stringify(val);
      try {
        if (redisOk) {
          await redis.set(`session:${key}`, data, "EX", 86400);
          return;
        }
      } catch { /* fall through to memory */ }
      memorySessionStore.set(key, data);
    },
    async delete(key: string) {
      try {
        if (redisOk) await redis.del(`session:${key}`);
      } catch { /* ignore */ }
      memorySessionStore.delete(key);
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
// The form collects deal details. It works in DM and in the escrow group
// (subject to Telegram permissions — see the group setup section in README).
bot.command("form", async (ctx) => {
  await startDealForm(ctx);
});
bot.hears(/^\s*\/?form\s*$/i, async (ctx) => {
  await startDealForm(ctx);
});

// ── /release and /refund are OUT OF SCOPE ────────────────────────
// The bot's scope ends when the assigned escrow admin confirms PAYMENT
// RECEIVED. Delivery, payout and refunds continue manually outside the bot —
// the commands are kept registered only to give a clear answer instead of an
// unknown-command error. They never touch a deal.
bot.command("release", async (ctx) => {
  await ctx.reply(
    "Release is handled manually by the escrower outside the bot.\n\n" +
    "The bot's job ends once the escrow admin confirms <b>PAYMENT RECEIVED</b>."
  );
});

bot.command("refund", async (ctx) => {
  await ctx.reply(
    "Refunds are handled manually by the escrower outside the bot.\n\n" +
    "The bot's job ends once the escrow admin confirms <b>PAYMENT RECEIVED</b>."
  );
});

// ─── Admin payment settings ────────────────────────────────────────
// In DM: global admins edit the GLOBAL fallback details. Inside a group: the
// bot owner, a global admin, or THAT group's escrow admin can configure the
// group's OWN receiving details (never another group's).
bot.command("settings", async (ctx) => {
  if (!ctx.from) {
    await ctx.reply("Unauthorized.");
    return;
  }
  if (isGroupChat(ctx)) {
    const ok = await groupService.isAuthorizedForGroup(ctx.from.id, String(ctx.chat.id));
    if (!ok) {
      await ctx.reply("Unauthorized — only the bot owner, a global admin or this group's escrow admin can change its payment details.");
      return;
    }
  } else if (!config.adminTelegramIds.has(ctx.from.id)) {
    await ctx.reply("Unauthorized.");
    return;
  }
  await adminPaymentSettings(ctx);
});

// ─── Group authorization + group escrow admins (bot owner only) ──────
function isGroupChat(ctx: MyContext): boolean {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
}

function groupTitle(ctx: MyContext): string | undefined {
  const chat = ctx.chat as { title?: string } | undefined;
  return chat?.title;
}

bot.command("allowgroup", async (ctx) => {
  if (!ctx.from || !isBotOwner(ctx.from.id)) {
    await ctx.reply("Only the bot owner can use /allowgroup.");
    return;
  }
  if (!isGroupChat(ctx)) {
    await ctx.reply("Run this command <b>inside</b> the group you want to authorize.");
    return;
  }
  const groupId = String(ctx.chat.id);
  await groupService.approveGroup(groupId, groupTitle(ctx), ctx.session.userId);
  await ctx.reply(
    `✅ <b>GROUP AUTHORIZED</b>\n\n` +
    `Group: <b>${esc(groupTitle(ctx) ?? groupId)}</b>\n` +
    `ID: <code>${esc(groupId)}</code>\n` +
    `Status: <b>APPROVED</b>\n\n` +
    `Deal cards can now be posted here and escrow admins can accept deals.\n` +
    `Assign escrow admins with <code>/addadmin @username</code>.`
  );
});

bot.command("disallowgroup", async (ctx) => {
  if (!ctx.from || !isBotOwner(ctx.from.id)) {
    await ctx.reply("Only the bot owner can use /disallowgroup.");
    return;
  }
  if (!isGroupChat(ctx)) {
    await ctx.reply("Run this command <b>inside</b> the group you want to disallow.");
    return;
  }
  const groupId = String(ctx.chat.id);
  await groupService.disallowGroup(groupId, ctx.session.userId);
  await ctx.reply(
    `⚠️ <b>GROUP DISALLOWED</b>\n\n` +
    `Group: <b>${esc(groupTitle(ctx) ?? groupId)}</b>\n` +
    `ID: <code>${esc(groupId)}</code>\n` +
    `Status: <b>DISALLOWED</b>\n\n` +
    `New deals will not be posted here. Existing deals, users and audit records are <b>untouched</b>.`
  );
});

bot.command("addadmin", async (ctx) => {
  if (!ctx.from || !isBotOwner(ctx.from.id)) {
    await ctx.reply("Only the bot owner can use /addadmin.");
    return;
  }
  if (!isGroupChat(ctx)) {
    await ctx.reply("Run /addadmin <b>inside</b> the group you want to assign the admin for.");
    return;
  }
  const username = (ctx.match ?? "").trim().replace(/^@+/, "");
  if (!username) {
    await ctx.reply("Usage: <code>/addadmin @username</code>");
    return;
  }
  const groupId = String(ctx.chat.id);
  if (!(await groupService.isGroupApproved(groupId))) {
    await ctx.reply("⚠️ This group is not approved yet — run <code>/allowgroup</code> here first.");
    return;
  }
  const user = await userService.findByUsername(username);
  if (!user) {
    await ctx.reply(`User <code>@${esc(username)}</code> was not found — they must have started this bot first.`);
    return;
  }
  await groupService.addGroupAdmin(groupId, user.id, ctx.session.userId);
  await ctx.reply(
    `✅ <b>GROUP ESCROW ADMIN ADDED</b>\n\n` +
    `@${esc(user.username ?? user.id)} is now an escrow admin for <b>${esc(groupTitle(ctx) ?? groupId)}</b> only.`
  );
});

bot.command("removeadmin", async (ctx) => {
  if (!ctx.from || !isBotOwner(ctx.from.id)) {
    await ctx.reply("Only the bot owner can use /removeadmin.");
    return;
  }
  if (!isGroupChat(ctx)) {
    await ctx.reply("Run /removeadmin <b>inside</b> the group you want to unassign the admin from.");
    return;
  }
  const username = (ctx.match ?? "").trim().replace(/^@+/, "");
  if (!username) {
    await ctx.reply("Usage: <code>/removeadmin @username</code>");
    return;
  }
  const user = await userService.findByUsername(username);
  if (!user) {
    await ctx.reply(`User <code>@${esc(username)}</code> was not found.`);
    return;
  }
  const groupId = String(ctx.chat.id);
  const removed = await groupService.removeGroupAdmin(groupId, user.id, ctx.session.userId);
  if (removed === 0) {
    await ctx.reply(`@${esc(user.username ?? user.id)} is not an active escrow admin for this group.`);
    return;
  }
  await ctx.reply(`🗑 <b>GROUP ESCROW ADMIN REMOVED</b>\n\n@${esc(user.username ?? user.id)} no longer has escrow powers in <b>${esc(groupTitle(ctx) ?? groupId)}</b>.`);
});

bot.command("groupadmins", async (ctx) => {
  if (!ctx.from || !isBotOwner(ctx.from.id)) {
    await ctx.reply("Only the bot owner can use /groupadmins.");
    return;
  }
  if (!isGroupChat(ctx)) {
    await ctx.reply("Run /groupadmins <b>inside</b> the group you want to inspect.");
    return;
  }
  const groupId = String(ctx.chat.id);
  const admins = await groupService.listGroupAdmins(groupId);
  if (admins.length === 0) {
    await ctx.reply(
      `<b>GROUP ESCROW ADMINS</b>\n\n` +
      `Group: <b>${esc(groupTitle(ctx) ?? groupId)}</b>\n` +
      `No escrow admins assigned yet. Use <code>/addadmin @username</code>.`
    );
    return;
  }
  const lines = admins.map((a, i) =>
    `${i + 1}. @${esc(a.user.username ?? a.user.id)} — assigned ${a.assignedAt.toISOString().slice(0, 10)}`
  ).join("\n");
  await ctx.reply(
    `<b>GROUP ESCROW ADMINS</b>\n\n` +
    `Group: <b>${esc(groupTitle(ctx) ?? groupId)}</b>\n` +
    `ID: <code>${esc(groupId)}</code>\n\n` +
    lines +
    `\n\nThese escrow admins can accept/verify deals in this group only.`
  );
});

// ─── Callback Query Router ─────────────────────────────────────────────
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;

  // Admin callbacks first (server-side authorized inside handleAdminCallback)
  if (data.startsWith("admin:")) {
    await handleAdminCallback(ctx);
    return;
  }

  // ── Deal-scoped callback chat guard ──
  // Every deal:* callback that carries a deal id must come from the deal's own
  // group OR a private chat (the bot sends DM buttons to the parties/admins).
  // A callback crafted in or forwarded from ANY other group is invalid and is
  // rejected before any handler runs — it can never act on this deal.
  const dealAction = data.match(/^deal:(agree|status|paid|evidence|release|release_agree|release_reject|refund_agree|refund_reject|deliver|dispute|cancel):(.+)$/);
  if (dealAction) {
    const deal = await dealService.findWithParties(dealAction[2]);
    if (!deal) {
      await ctx.answerCallbackQuery("Deal not found.").catch(() => {});
      return;
    }
    const cbChat = ctx.callbackQuery?.message?.chat;
    if (!isDealChatValid(cbChat?.type, cbChat?.id, deal.groupChatId)) {
      await ctx.answerCallbackQuery("This action is no longer valid.").catch(() => {});
      return;
    }
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
      "2. Both parties agree to the posted deal in the escrow group\n" +
      "3. The escrow admin accepts the deal\n" +
      "4. You get the escrower's payment instructions\n" +
      "5. Buyer (or the configured crypto payer) pays the escrower directly (UPI or crypto)\n" +
      "6. The payer taps \"I've Paid\"\n" +
      "7. The escrower personally verifies the payment\n" +
      "8. Payment received — the bot's job is done; delivery and payout continue manually\n\n" +
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

  // ── Deal: Party agrees to the posted deal card (group flow) ──
  // The bot identifies who clicked and records the agreement for that party
  // only — nobody can agree on someone else's behalf.
  if (data.startsWith("deal:agree:")) {
    const dealId = data.split(":")[2];
    await handleAgreeToDeal(ctx, dealId);
    return;
  }

  // ── Deal: Status ──
  if (data.startsWith("deal:status:")) {
    const dealId = data.split(":")[2];
    ctx.session.lastDealId = dealId;
    await showDealStatus(ctx, dealId);
    return;
  }

  // ── Deal: Payer reports "I've Paid" (manual payment) ──
  if (data.startsWith("deal:paid:")) {
    const dealId = data.split(":")[2];
    const deal = await dealService.findWithParties(dealId);
    if (!deal) {
      await ctx.answerCallbackQuery("Deal not found.");
      return;
    }
    if (dealService.getPayerId(deal) !== ctx.session.userId) {
      await ctx.answerCallbackQuery("Only the payer can report payment.");
      return;
    }
    ctx.session.lastDealId = dealId;
    // One authoritative flow: starting the payment-report capture abandons
    // any in-progress deal form.
    ctx.session.createDealStep = undefined;
    ctx.session.pendingPaymentReportDealId = dealId;
    ctx.session.pendingFlowChatId = String(ctx.chat?.id ?? "");
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
    ctx.session.createDealStep = undefined;
    ctx.session.pendingEvidenceDealId = dealId;
    ctx.session.pendingFlowChatId = String(ctx.chat?.id ?? "");
    await ctx.answerCallbackQuery("Send your evidence.");
    await ctx.reply(
      "Send a <b>screenshot</b> or describe the payment details as text:",
      { reply_markup: backToMain }
    );
    return;
  }

  // ── Deal: Release / Refund / Delivery are OUT OF SCOPE ──
  // The bot's flow ends at PAYMENT_RECEIVED. Old buttons from the previous
  // release/refund/delivery automation (kept for historical rows) are answered
  // with a clear message and never act on the deal.
  if (data.startsWith("deal:release:") || data.startsWith("deal:release_agree:") ||
      data.startsWith("deal:release_reject:") || data.startsWith("deal:refund_agree:") ||
      data.startsWith("deal:refund_reject:") || data.startsWith("deal:deliver:")) {
    await ctx.answerCallbackQuery("This action is no longer available.").catch(() => {});
    return;
  }

  // ── Deal: Dispute ──
  if (data.startsWith("deal:dispute:")) {
    const dealId = data.split(":")[2];
    ctx.session.lastDealId = dealId;
    await handleDispute(ctx, dealId);
    return;
  }

  // ── Deal: Cancel (parties or admin; group card updated) ──
  if (data.startsWith("deal:cancel:")) {
    const dealId = data.split(":")[2];
    const deal = await dealService.findWithParties(dealId);
    if (!deal) {
      await ctx.answerCallbackQuery("Deal not found.");
      return;
    }
    const isParty = deal.buyerId === ctx.session.userId || deal.sellerId === ctx.session.userId;
    const isAdminUser = ctx.from ? config.adminTelegramIds.has(ctx.from.id) : false;
    const isGroupAdmin = ctx.from && deal.groupChatId
      ? await groupService.isActiveGroupAdmin(deal.groupChatId, BigInt(ctx.from.id))
      : false;
    if (!isParty && !isAdminUser && !isGroupAdmin) {
      await ctx.answerCallbackQuery("Only the parties or an escrow admin can cancel.").catch(() => {});
      return;
    }
    try {
      await dealService.cancel(dealId, ctx.session.userId);
      await ctx.editMessageText("Deal cancelled.", { reply_markup: backToMain });
      // Re-fetch so the group card reflects CANCELLED (the pre-cancel object is stale).
      const cancelled = await dealService.findWithParties(dealId);
      if (cancelled) await updateGroupDealCard(ctx, cancelled);
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

  // ── Stale text from another chat must not be consumed by a pending capture
  // state. Only the chat where the prompt was sent may answer it — a message
  // typed anywhere else passes through untouched. ──
  if (ctx.session.pendingFlowChatId && String(ctx.chat?.id ?? "") !== ctx.session.pendingFlowChatId) {
    await next();
    return;
  }

  // 1. Dispute reason
  if (ctx.session.pendingDisputeDealId) {
    await handleDisputeReason(ctx, text);
    return;
  }

  // 2. Buyer reports payment (reference or notes after "I've Paid")
  if (ctx.session.pendingPaymentReportDealId) {
    const dealId = ctx.session.pendingPaymentReportDealId;
    // Stale-state check: only consume the message when the deal can still be
    // reported by this user. If it moved on, drop the capture WITHOUT
    // consuming the message for the old question.
    const deal = await dealService.findWithParties(dealId).catch(() => null);
    const payerRole = deal && dealService.getPayerId(deal) === deal.buyerId ? "BUYER" : "SELLER";
    if (!deal || !canTransition(deal.status, "PAYMENT_REPORTED", payerRole)) {
      delete ctx.session.pendingPaymentReportDealId;
      delete ctx.session.pendingFlowChatId;
    } else {
      delete ctx.session.pendingPaymentReportDealId;
      delete ctx.session.pendingFlowChatId;
      if (text.toLowerCase() === "/skip") {
        await completePaymentReport(ctx, dealId, {});
      } else {
        await completePaymentReport(ctx, dealId, { reference: text });
      }
      return;
    }
  }

  // 3. Buyer submits evidence as text
  if (ctx.session.pendingEvidenceDealId) {
    const dealId = ctx.session.pendingEvidenceDealId;
    const { prisma } = await import("../lib/db.js");
    const pending = await prisma.paymentReport.findFirst({ where: { dealId, status: "PENDING" } }).catch(() => null);
    const deal = await dealService.findWithParties(dealId).catch(() => null);
    if (!pending && deal?.status !== "PAYMENT_REPORTED") {
      // No pending report to attach evidence to — stale capture, do not consume.
      delete ctx.session.pendingEvidenceDealId;
      delete ctx.session.pendingFlowChatId;
    } else {
      delete ctx.session.pendingEvidenceDealId;
      delete ctx.session.pendingFlowChatId;
      await submitEvidence(ctx, dealId, text, undefined);
      return;
    }
  }

  // 4. Admin: rejection reason
  if (ctx.session.pendingRejectPaymentDealId) {
    const dealId = ctx.session.pendingRejectPaymentDealId;
    delete ctx.session.pendingRejectPaymentDealId;
    try {
      await dealService.rejectPayment(dealId, ctx.session.userId, text);
      const deal = await dealService.findWithParties(dealId);
      await ctx.reply(`Payment report rejected for deal #${esc(deal?.inviteCode ?? dealId)}.`);
      // GROUP-FIRST: the group card is re-rendered with PAYMENT REQUIRED, the
      // rejection reason and a fresh [I've Paid] button for the payer.
      if (deal) {
        await postPaymentInstructionsToGroupCard(ctx, deal, undefined, text);
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

  // 6b. Admin: optional refund reference after marking refunded
  if (ctx.session.pendingRefundReferenceDealId) {
    const dealId = ctx.session.pendingRefundReferenceDealId;
    delete ctx.session.pendingRefundReferenceDealId;
    if (text.toLowerCase() !== "/skip") {
      const { prisma } = await import("../lib/db.js");
      await prisma.deal.update({ where: { id: dealId }, data: { refundReference: text } });
      await ctx.reply(`Refund reference recorded for deal #${esc(dealId)}.`);
    } else {
      await ctx.reply("No reference recorded.");
    }
    return;
  }

  // 6c. Admin: capture a payment setting value (/settings flow)
  if (ctx.session.pendingSettingKey) {
    const key = ctx.session.pendingSettingKey;
    const groupId = ctx.session.pendingSettingGroupId ?? "";
    delete ctx.session.pendingSettingKey;
    delete ctx.session.pendingSettingGroupId;
    delete ctx.session.pendingFlowChatId;
    if (!ctx.from) {
      await ctx.reply("Unauthorized.");
      return;
    }
    // Authorization is re-checked for the SCOPE this value belongs to:
    // group details need the bot owner / global admin / that group's admin.
    const ok = groupId
      ? await groupService.isAuthorizedForGroup(ctx.from.id, groupId)
      : config.adminTelegramIds.has(ctx.from.id);
    if (!ok) {
      await ctx.reply("Unauthorized.");
      return;
    }
    if (text.toLowerCase() === "/cancel") {
      await ctx.reply("Setting update cancelled.");
      return;
    }
    if (text.trim().length < 3 || text.length > 300) {
      ctx.session.pendingSettingKey = key;
      ctx.session.pendingSettingGroupId = groupId;
      ctx.session.pendingFlowChatId = String(ctx.chat?.id ?? "");
      await ctx.reply("Value must be between 3 and 300 characters. Please try again (or <code>/cancel</code>):");
      return;
    }
    try {
      await setSettingValue(key, text, ctx.session.userId, groupId);
      await ctx.reply(
        `✅ <b>${esc(key.replace(/_/g, " ").toUpperCase())}</b> updated` +
        (groupId ? ` for group <code>${esc(groupId)}</code>` : " (global fallback)") +
        `.\n\nUse <code>/settings</code> to review.`
      );
    } catch (e: unknown) {
      await ctx.reply(esc(e instanceof Error ? e.message : "Could not save setting"));
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

    // GROUP-FIRST: the group card flips to PAYMENT REPORTED (the [I've Paid]
    // button is removed; verification happens only via the assigned admin's DM).
    if (deal) await updateGroupDealCard(ctx, deal);

    // ONLY the admin who accepted this deal gets the verification buttons —
    // other admins are never notified and their callbacks are rejected
    // server-side (see admin.ts isAssignedVerifier).
    await notificationService.notifyAssignedAdmin(
      `<b>PAYMENT CHECK</b>\n\n` +
      `Deal: #${esc(deal?.inviteCode ?? dealId)}\n` +
      `Payer: @${esc(ctx.session.username ?? ctx.session.firstName)}\n` +
      `Amount: <b>${esc(deal?.amount?.toString() ?? "")} ${esc(deal?.asset ?? "")}</b>\n` +
      `Payment: ${esc(deal?.paymentMethod === "INR" ? "INR / UPI" : "Crypto")}${opts.reference ? `\nReference: <code>${esc(opts.reference)}</code>` : ""}${opts.evidence ? "\n📎 Screenshot attached" : ""}\n\n` +
      `Please check the payment manually.`,
      new InlineKeyboard()
        .text("\u{2705}  Payment Received", `admin:verify_payment:${dealId}`)
        .text("\u{274C}  Not Received", `admin:reject_payment:${dealId}`)
        .row()
        .text("\u{1F50D}  Request Evidence", `admin:request_evidence:${dealId}`),
      dealId
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

    await notificationService.notifyAssignedAdmin(
      `<b>EVIDENCE SUBMITTED</b>\n\nDeal: #${esc(dealId)}\nBy: @${esc(ctx.session.username ?? ctx.session.firstName)}\n` +
      (fileId ? "📎 Screenshot attached." : `Notes: ${esc(text)}`),
      new InlineKeyboard().text("Review", `admin:verify_payment:${dealId}`),
      dealId
    );
  } catch (e: unknown) {
    await ctx.reply(esc(e instanceof Error ? e.message : "Could not submit evidence"), { reply_markup: backToMain });
  }
}

// ─── Admin Commands ──────────────────────────────────────────────────
bot.command("admin", adminDashboard);

// ─── Admin: /settings command body ───────────────────────────────────
async function adminPaymentSettings(ctx: MyContext) {
  const { buildSettingsPanel } = await import("./admin.js");
  const groupId = isGroupChat(ctx) ? String(ctx.chat?.id ?? "") : "";
  const panel = await buildSettingsPanel(groupId, groupTitle(ctx));
  await ctx.reply(panel.text, { reply_markup: panel.keyboard });
}

/** Resolve the deal a /release or /refund refers to: replied-to deal card,
 *  optional deal code argument, or the last deal the user interacted with.
 *
 *  GROUP-FIRST: when the command runs inside a group, only a deal posted to
 *  THAT group may be acted on. The reply-to path is already chat-scoped; the
 *  code-arg / lastDealId fallbacks are ignored when they point at a deal in
 *  another group — a user cannot drive a Group B deal from Group A. In DM
 *  the fallbacks work as before (participant checks still apply server-side). */
export async function resolveDealFromContext(ctx: MyContext, codeArg?: string) {
  const inGroup = isGroupChat(ctx);
  const chatId = String(ctx.chat?.id ?? "");
  let deal: Awaited<ReturnType<typeof dealService.findWithParties>> | null = null;

  // 1. Replying to a bot deal card (group or DM).
  const replyTo = ctx.message?.reply_to_message;
  if (replyTo?.message_id && replyTo.from?.is_bot && ctx.chat) {
    const { prisma } = await import("../lib/db.js");
    const byMsg = await prisma.deal.findFirst({
      where: { groupChatId: chatId, groupMessageId: replyTo.message_id },
    });
    if (byMsg) deal = await dealService.findWithParties(byMsg.id);
  }
  // 2. Deal code argument.
  if (!deal && codeArg) {
    const byCode = await dealService.findByInviteCode(codeArg.toUpperCase());
    if (byCode) deal = await dealService.findWithParties(byCode.id);
  }
  // 3. Last deal the user viewed (DM context).
  if (!deal && ctx.session.lastDealId) {
    deal = await dealService.findWithParties(ctx.session.lastDealId);
  }
  // 4. Group gate: a deal from another group is never resolved here.
  if (deal && inGroup && deal.groupChatId && deal.groupChatId !== chatId) {
    return null;
  }
  return deal;
}
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
