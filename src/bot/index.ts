import { Bot, InlineKeyboard, session } from "grammy";
import { DealCategory } from "@prisma/client";
import { config } from "../config/index.js";
import { redis } from "../lib/redis.js";
import { userService } from "../services/userService.js";
import { dealService } from "../services/dealService.js";
import { blockchainMonitor } from "../services/blockchainMonitor.js";
import { mainMenu, roleSelect, assetSelect, categorySelect, dealConfirm, acceptRejectDeal, backToMain, walletMenu, dealTabs, dealActions } from "./keyboards/index.js";
import { handleJoinDeal, handleAcceptDeal, showDealStatus } from "./scenes/joinDeal.js";
import { handleRelease, handleReleaseConfirm, handleDeliver, handleDispute, handleDisputeReason } from "./scenes/depositDeliveryRelease.js";
import { showWallet, showDeposit, showMyDeals } from "./scenes/walletAndDeals.js";
import { notificationService } from "../services/notificationService.js";
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

// ─── Session Middleware (Redis-backed) ─────────────────────────────────
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

  await ctx.reply(
    "<b>ESCROW</b>\n\nSecure your trades with our escrow system.\n\nCreate a deal and let us protect the transaction.",
    { reply_markup: mainMenu }
  );
});

// ─── Callback Query Router ─────────────────────────────────────────────
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;

  // Let admin callbacks be handled first
  if (data.startsWith("admin:")) {
    await handleAdminCallback(ctx);
    return;
  }

  // ── Main Menu ──
  if (data === "menu:main") {
    // Leaving the create-deal flow: drop any in-progress step so a later
    // text message is not silently consumed by the abandoned flow.
    ctx.session.createDealStep = undefined;
    await ctx.editMessageText(
      "<b>ESCROW</b>\n\nSecure your trades with our escrow system.",
      { reply_markup: mainMenu }
    );
    return;
  }

  // ── Create Deal ──
  if (data === "menu:create_deal") {
    await ctx.editMessageText(
      "<b>CREATE DEAL</b>\n\nChoose your role:",
      { reply_markup: roleSelect }
    );
    ctx.session.createDealStep = "role";
    return;
  }

  // ── Role selection ──
  if (data === "role:buyer" || data === "role:seller") {
    const role = data === "role:buyer" ? "buyer" : "seller";
    ctx.session.createDealRole = role;
    await ctx.editMessageText(
      `You are the <b>${role === "buyer" ? "Buyer" : "Seller"}</b>.\n\nEnter the other party's Telegram username:\n\n<i>Example: @username</i>`,
      { reply_markup: backToMain }
    );
    ctx.session.createDealStep = "counterparty";
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

  // ── Wallet ──
  if (data === "menu:wallet") {
    await showWallet(ctx);
    return;
  }
  if (data === "wallet:deposit") {
    ctx.session.depositNetwork = "TRC20";
    await ctx.answerCallbackQuery();
    try {
      await showDeposit(ctx);
    } catch (e: unknown) {
      await ctx.reply(`Error opening deposit: ${esc(e instanceof Error ? e.message : "Unknown error")}`, { reply_markup: backToMain });
    }
    return;
  }
  if (data === "wallet:deposit_trc20") {
    ctx.session.depositNetwork = "TRC20";
    await ctx.answerCallbackQuery();
    try {
      await showDeposit(ctx);
    } catch (e: unknown) {
      await ctx.reply(`Error opening deposit: ${esc(e instanceof Error ? e.message : "Unknown error")}`, { reply_markup: backToMain });
    }
    return;
  }
  if (data === "wallet:deposit_bep20") {
    ctx.session.depositNetwork = "BEP20";
    await ctx.answerCallbackQuery();
    try {
      await showDeposit(ctx);
    } catch (e: unknown) {
      await ctx.reply(`Error opening deposit: ${esc(e instanceof Error ? e.message : "Unknown error")}`, { reply_markup: backToMain });
    }
    return;
  }
  if (data === "wallet:withdraw") {
    await ctx.reply("<b>WITHDRAW</b>\n\nWithdrawals are processed via the withdrawal queue.\nContact support for withdrawals.", { reply_markup: walletMenu });
    return;
  }
  if (data === "wallet:transactions") {
    await ctx.reply("<b>TRANSACTIONS</b>\n\nTransaction history coming soon.", { reply_markup: walletMenu });
    return;
  }
  if (data === "wallet:back") {
    await showWallet(ctx);
    return;
  }

  // ── How It Works ──
  if (data === "menu:how_it_works") {
    await ctx.editMessageText(
      "<b>HOW IT WORKS</b>\n\n" +
      "1. Create a deal and invite the other party\n" +
      "2. Both parties agree to the terms\n" +
      "3. Buyer deposits funds to their wallet\n" +
      "4. Buyer funds the escrow from wallet balance\n" +
      "5. Seller delivers the item/service\n" +
      "6. Buyer confirms and releases the funds\n" +
      "7. Seller receives the payment\n\n" +
      "If anything goes wrong, either party can open a dispute.",
      { reply_markup: backToMain }
    );
    return;
  }

  // ── Support ──
  if (data === "menu:support") {
    await ctx.editMessageText("<b>SUPPORT</b>\n\nFor help, contact: @admin", { reply_markup: backToMain });
    return;
  }

  // ── Deal: Accept ──
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

  // ── Deal: Release ──
  if (data.startsWith("deal:release:")) {
    const dealId = data.split(":")[2];
    await handleRelease(ctx, dealId);
    return;
  }
  if (data.startsWith("deal:release_confirm:")) {
    const dealId = data.split(":")[2];
    await handleReleaseConfirm(ctx, dealId);
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

  // ── Deal: Fund (buyer manually triggers lock from wallet) ──
  if (data.startsWith("deal:fund:")) {
    const dealId = data.split(":")[2];
    try {
      await dealService.fund(dealId);
      await ctx.answerCallbackQuery("Deal funded from your wallet!");
      await showDealStatus(ctx, dealId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      await ctx.answerCallbackQuery(msg);
    }
    return;
  }

  // ── Asset selection ──
  if (data?.startsWith("asset:")) {
    const parts = data.replace("asset:", "").split("_");
    ctx.session.createDealAsset = parts[0];
    ctx.session.createDealNetwork = parts[1] ?? parts[0];
    await ctx.editMessageText(
      "<b>DEAL DESCRIPTION</b>\n\nDescribe what is being traded:\n\n<i>Example: Logo design for website, 3 revisions included</i>",
      { reply_markup: backToMain }
    );
    ctx.session.createDealStep = "description";
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Category selection ──
  if (data?.startsWith("cat:")) {
    ctx.session.createDealCategory = data.replace("cat:", "");
    const s = ctx.session;

    const buyerFeePct = (config.buyerFeeBps / 100).toFixed(config.buyerFeeBps % 100 === 0 ? 0 : 2);
    const sellerFeePct = (config.sellerFeeBps / 100).toFixed(config.sellerFeeBps % 100 === 0 ? 0 : 2);
    const amount = parseFloat(s.createDealAmount ?? "0");
    const buyerFee = (amount * config.buyerFeeBps / 10000).toFixed(2);
    const sellerFee = (amount * config.sellerFeeBps / 10000).toFixed(2);

    await ctx.reply(
      `<b>DEAL SUMMARY</b>\n\n` +
      `${s.createDealRole === "buyer" ? "Seller" : "Buyer"}: @${esc(s.createDealCounterpartyUsername ?? "")}\n` +
      `${s.createDealRole === "buyer" ? "Buyer" : "Seller"}: @${esc(s.username ?? s.firstName)}\n\n` +
      `Amount: ${esc(s.createDealAmount)} ${esc(s.createDealAsset)}\n` +
      `Buyer fee (${buyerFeePct}%): ${buyerFee} ${esc(s.createDealAsset)}\n` +
      `Seller fee (${sellerFeePct}%): ${sellerFee} ${esc(s.createDealAsset)}\n` +
      `Buyer pays total: ${(amount + parseFloat(buyerFee)).toFixed(2)} ${esc(s.createDealAsset)}\n` +
      `Seller receives: ${(amount - parseFloat(sellerFee)).toFixed(2)} ${esc(s.createDealAsset)}\n\n` +
      `Item: ${esc(s.createDealDescription)}\n\n` +
      `Everything correct?`,
      { reply_markup: dealConfirm() }
    );
    ctx.session.createDealStep = "confirm";
    await ctx.answerCallbackQuery();
    return;
  }

  // ── Confirm deal creation ──
  if (data === "deal:confirm") {
    const s = ctx.session;
    try {
      const buyerId = s.createDealRole === "buyer" ? s.userId : (s.createDealCounterpartyUserId ?? "");
      const sellerId = s.createDealRole === "seller" ? s.userId : (s.createDealCounterpartyUserId ?? null);

      const deal = await dealService.create({
        buyerUserId: buyerId,
        sellerUserId: sellerId,
        sellerUsername: s.createDealCounterpartyUsername ?? "",
        amount: s.createDealAmount ?? "0",
        asset: s.createDealAsset ?? "USDT",
        network: s.createDealNetwork ?? "TRC20",
        description: s.createDealDescription ?? "",
        category: (s.createDealCategory ?? "FREELANCE_SERVICES") as DealCategory,
      });

      // Notify counterparty if they exist in system
      if (s.createDealCounterpartyUserId) {
        await notificationService.notifyDealCreated(
          s.createDealCounterpartyUserId,
          deal.inviteCode,
          s.createDealAmount ?? "0",
          s.createDealAsset ?? "USDT",
          s.createDealDescription ?? ""
        );
      }

      const botInfo = await ctx.api.getMe();
      const link = `https://t.me/${botInfo.username}?start=deal_${deal.inviteCode}`;

      await ctx.reply(
        `<b>DEAL CREATED</b>\n\n` +
        `Deal ID: <code>#${deal.inviteCode}</code>\n\n` +
        `Waiting for the ${s.createDealRole === "buyer" ? "seller" : "buyer"} to join.\n\n` +
        `Invite Link:\n<code>${link}</code>\n\n` +
        `Do not send funds until both parties have joined.`,
        {
          reply_markup: new InlineKeyboard()
            .text("Copy Deal Link", `deal:copy:${deal.inviteCode}`)
            .row()
            .text("Cancel Deal", `deal:cancel:${deal.id}`)
            .row()
            .text("Main Menu", "menu:main"),
        }
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      await ctx.reply(`Error: ${msg}`, { reply_markup: backToMain });
    }
    // Clear draft
    ctx.session.createDealStep = undefined;
    ctx.session.createDealRole = undefined;
    ctx.session.createDealCounterpartyUsername = undefined;
    ctx.session.createDealCounterpartyUserId = undefined;
    ctx.session.createDealAmount = undefined;
    ctx.session.createDealAsset = undefined;
    ctx.session.createDealNetwork = undefined;
    ctx.session.createDealDescription = undefined;
    ctx.session.createDealCategory = undefined;
    return;
  }

  if (data === "deal:edit") {
    await ctx.reply("Starting over.", { reply_markup: mainMenu });
    ctx.session.createDealStep = undefined;
    return;
  }
});

// ─── Text Message Handler ─────────────────────────────────────────────
bot.on("message:text", async (ctx, next) => {
  // Handle dispute reason
  if (ctx.session.pendingDisputeDealId) {
    await handleDisputeReason(ctx, ctx.message.text);
    return;
  }

  // Handle create-deal steps
  const step = ctx.session.createDealStep;
  if (!step) {
    await next();
    return;
  }

  const text = ctx.message.text.trim();

  // Counterparty username
  if (step === "counterparty") {
    // Normalize: trim, strip leading @ (e.g. "@username" -> "username").
    const normalized = text.replace(/^@+/, "").trim();
    // Telegram usernames: 5-32 chars, letters/digits/underscore.
    const usernameRe = /^[A-Za-z0-9_]{5,32}$/;

    if (!normalized) {
      await ctx.reply("Please enter the other party's Telegram username, e.g. <code>@username</code>.");
      return; // stay on the counterparty step
    }
    if (!usernameRe.test(normalized)) {
      await ctx.reply(
        "That doesn't look like a valid Telegram username.\n\n" +
        "Usernames are 5–32 characters and may only contain letters, numbers and underscores.\n\n" +
        "Example: <code>@john_doe</code>\n\nPlease try again:"
      );
      return; // stay on the counterparty step
    }

    const otherUser = await userService.findByUsername(normalized);
    if (!otherUser) {
      // Do NOT clear the step: keep the user here so they can retry.
      await ctx.reply(
        `User <code>@${esc(normalized)}</code> was not found.\n\n` +
        `The other person must start this bot first — ask them to send <code>/start</code> to the bot, then enter their username again.`
      );
      return;
    }

    if (otherUser.id === ctx.session.userId) {
      await ctx.reply("You can't create a deal with yourself. Please enter the other party's username:");
      return; // stay on the counterparty step
    }

    ctx.session.createDealCounterpartyUsername = otherUser.username ?? normalized;
    ctx.session.createDealCounterpartyUserId = otherUser.id;
    await ctx.reply("<b>DEAL AMOUNT</b>\n\nEnter the amount:\n\n<i>Example: 100</i>", { reply_markup: backToMain });
    ctx.session.createDealStep = "amount";
    return;
  }

  // Amount
  if (step === "amount") {
    if (!/^[\d.]+$/.test(text) || Number(text) <= 0) {
      await ctx.reply("Invalid amount. Please enter a positive number.", { reply_markup: backToMain });
      ctx.session.createDealStep = undefined;
      return;
    }
    ctx.session.createDealAmount = text;
    await ctx.reply("<b>PAYMENT ASSET</b>\n\nChoose the cryptocurrency:", { reply_markup: assetSelect });
    ctx.session.createDealStep = "asset";
    return;
  }

  // Description (handled after asset callback)
  if (step === "description") {
    if (text.length < 5) {
      await ctx.reply("Description too short.", { reply_markup: backToMain });
      ctx.session.createDealStep = undefined;
      return;
    }
    ctx.session.createDealDescription = text;
    await ctx.reply("<b>CATEGORY</b>\n\nSelect the trade category:", { reply_markup: categorySelect });
    ctx.session.createDealStep = "category";
    return;
  }

  await next();
});

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
