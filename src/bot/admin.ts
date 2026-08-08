import { InlineKeyboard } from "grammy";
import { prisma } from "../lib/db.js";
import { dealService } from "../services/dealService.js";
import { config } from "../config/index.js";
import { notificationService } from "../services/notificationService.js";
import type { MyContext } from "./context.js";
import { logger } from "../lib/logger.js";

export async function adminDashboard(ctx: MyContext) {
  if (!ctx.from || !config.adminTelegramIds.has(ctx.from.id)) return;

  const [totalDeals, activeDeals, disputedDeals, completedDeals, totalUsers] = await Promise.all([
    prisma.deal.count(),
    prisma.deal.count({ where: { status: { in: ["CREATED", "JOINED", "AWAITING_DEPOSIT", "FUNDED", "IN_PROGRESS", "DELIVERED", "RELEASE_PENDING"] } } }),
    prisma.deal.count({ where: { status: { in: ["DISPUTED", "UNDER_REVIEW"] } } }),
    prisma.deal.count({ where: { status: "COMPLETED" } }),
    prisma.user.count(),
  ]);

  const kb = new InlineKeyboard()
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
      "<b>#" + deal.inviteCode + "</b> -- " + deal.status + "\n" +
      "Amount: " + deal.amount + " " + deal.asset + "\n" +
      "Buyer: @" + (deal.buyer?.username ?? "N/A") + " | Seller: @" + (deal.seller?.username ?? "N/A") + "\n" +
      "Opened by: @" + (d.opener?.username ?? "N/A") + "\n" +
      "Reason: " + d.reason.slice(0, 80) + "\n" +
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
    ? deal.dispute.evidence.map((e, i) => (i + 1) + ". " + e.message).join("\n")
    : "No evidence submitted yet.";

  const kb = new InlineKeyboard()
    .text("Release to Seller", "admin:release:" + deal.id)
    .text("Refund Buyer", "admin:refund:" + deal.id)
    .row()
    .text("Ask for More Info", "admin:ask_evidence:" + deal.id)
    .text("Assign to Me", "admin:assign:" + deal.id);

  await ctx.reply(
    "<b>DISPUTE REVIEW: #" + deal.inviteCode + "</b>\n\n" +
    "Buyer: @" + (deal.buyer?.username ?? "N/A") + " (" + deal.buyerId + ")\n" +
    "Seller: @" + (deal.seller?.username ?? "N/A") + " (" + deal.sellerId + ")\n" +
    "Amount: " + deal.amount + " " + deal.asset + "\n" +
    "Status: " + deal.status + "\n\n" +
    "<b>Reason:</b> " + deal.dispute.reason + "\n\n" +
    "<b>Evidence:</b>\n" + evidenceList,
    { reply_markup: kb }
  );
}

export async function handleAdminCallback(ctx: MyContext) {
  if (!ctx.from || !config.adminTelegramIds.has(ctx.from.id)) return;
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("admin:")) return;

  if (data === "admin:disputes") {
    await listDisputes(ctx);
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === "admin:stuck") {
    const stuck = await prisma.deal.findMany({
      where: {
        OR: [
          { status: "AWAITING_DEPOSIT", createdAt: { lt: new Date(Date.now() - 86_400_000) } },
          { status: "FUNDED", createdAt: { lt: new Date(Date.now() - 604_800_000) } },
        ],
      },
      include: { buyer: true, seller: true },
      take: 20,
    });

    if (stuck.length === 0) {
      await ctx.editMessageText("<b>STUCK DEALS</b>\n\nNone found.");
    } else {
      const list = stuck.map((d) =>
        "#" + d.inviteCode + " -- " + d.status + " -- " + d.amount + " " + d.asset + " -- created " + d.createdAt.toISOString().slice(0, 10)
      ).join("\n");
      await ctx.editMessageText("<b>STUCK DEALS (" + stuck.length + ")</b>\n\n" + list);
    }
    await ctx.answerCallbackQuery();
    return;
  }

  if (data.startsWith("admin:release:")) {
    const did = data.split(":")[2];
    try {
      await dealService.resolveDispute(did, ctx.session.userId, "RELEASE_TO_SELLER", "Admin resolved via panel");
      await ctx.editMessageText("<b>RESOLVED</b>\n\nFunds released to seller for deal " + did + ".");
    } catch (e: unknown) {
      await ctx.answerCallbackQuery(e instanceof Error ? e.message : "Error");
    }
    return;
  }

  if (data.startsWith("admin:refund:")) {
    const did = data.split(":")[2];
    try {
      await dealService.resolveDispute(did, ctx.session.userId, "REFUND_BUYER", "Admin resolved via panel");
      await ctx.editMessageText("<b>RESOLVED</b>\n\nFunds refunded to buyer for deal " + did + ".");
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
  await ctx.reply("User @" + (user.username ?? user.id) + " has been banned.\nReason: " + reason);
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
  await ctx.reply("User @" + (user.username ?? user.id) + " has been suspended.\nReason: " + reason);
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
    "ID: <code>" + user.id + "</code>\n" +
    "Telegram: @" + (user.username ?? "N/A") + " (" + user.telegramId + ")\n" +
    "Name: " + user.firstName + "\n" +
    "Status: <b>" + user.status + "</b>\n" +
    "Deals: " + dealCount + "\n" +
    "Disputes Opened: " + disputeCount + "\n" +
    "Joined: " + user.createdAt.toISOString().slice(0, 10);

  await ctx.reply(profileText, { reply_markup: kb });
}
