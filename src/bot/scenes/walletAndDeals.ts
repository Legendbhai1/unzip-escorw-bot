import { prisma } from "../../lib/db.js";
import { dealService } from "../../services/dealService.js";
import { historyMenu, dealTabs, backToMain } from "../keyboards/index.js";
import { esc } from "../../lib/html.js";
import { formatMoney } from "../../lib/money.js";

type Ctx = any;

/**
 * Transactions / Payment History.
 * Shows ONLY internal escrow records (payment reports, verified payments,
 * releases, refunds). There is no deposit, no withdrawal and no wallet
 * balance — the bot has no custody of funds.
 */
export async function showHistory(ctx: Ctx) {
  const userId = ctx.session.userId;

  const [txs, reports] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId },
      include: { deal: true },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    prisma.paymentReport.findMany({
      where: { reportedBy: userId },
      include: { deal: true },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);

  if (txs.length === 0 && reports.length === 0) {
    await ctx.reply(
      "<b>MY TRANSACTIONS</b>\n\nNo payment history yet.\n\n" +
      "Your internal escrow records will appear here as deals progress.",
      { reply_markup: historyMenu }
    );
    return;
  }

  const lines: string[] = [];

  for (const r of reports) {
    const status = r.status === "VERIFIED" ? "\u{2705}" : r.status === "REJECTED" ? "\u{274C}" : "\u{23F3}";
    lines.push(
      `${status} <b>Payment ${r.status.toLowerCase()}</b> — #${esc(r.deal?.inviteCode ?? "?")}\n` +
      `   ${formatMoney(r.amount.toString(), r.deal?.asset === "INR" ? "INR" : (r.deal?.asset ?? ""))} (${r.paymentMethod === "INR" ? "UPI" : "Crypto"})\n` +
      `   ${r.createdAt.toISOString().slice(0, 10)}`
    );
  }

  const typeLabel: Record<string, string> = {
    ESCROW_LOCK: "Payment verified (escrowed)",
    ESCROW_RELEASE: "Payout received",
    REFUND: "Refund",
    FEE: "Fee",
    DEPOSIT: "Deposit (legacy)",
    WITHDRAWAL: "Withdrawal (legacy)",
  };

  for (const t of txs) {
    const sign = parseFloat(t.amount.toString()) < 0 ? "-" : "";
    lines.push(
      `<b>${esc(typeLabel[t.type] ?? t.type)}</b> — #${esc(t.deal?.inviteCode ?? "?")}\n` +
      `   ${sign}${formatMoney(Math.abs(parseFloat(t.amount.toString())).toString(), t.asset)} · ${t.status}\n` +
      `   ${t.createdAt.toISOString().slice(0, 10)}`
    );
  }

  await ctx.reply(
    "<b>MY TRANSACTIONS</b>\n\n" + lines.slice(0, 30).join("\n\n"),
    { reply_markup: historyMenu }
  );
}

export async function showMyDeals(ctx: Ctx, tab: "active" | "completed" | "disputed" = "active") {
  const userId = ctx.session.userId;
  let deals: any[];

  if (tab === "active") {
    deals = await dealService.getActiveDealsForUser(userId);
  } else if (tab === "completed") {
    deals = await dealService.getCompletedDealsForUser(userId);
  } else {
    deals = await prisma.deal.findMany({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        status: { in: ["DISPUTED", "UNDER_REVIEW"] },
      },
      include: { buyer: true, seller: true },
      orderBy: { createdAt: "desc" },
    });
  }

  if (deals.length === 0) {
    await ctx.reply(`<b>MY ${esc(tab.toUpperCase())} DEALS</b>\n\nNo ${esc(tab)} deals found.`, { reply_markup: dealTabs });
    return;
  }

  const statusEmoji: Record<string, string> = {
    CREATED: "\u{1F9ED}", JOINED: "\u{1F91D}",
    AWAITING_PAYMENT: "\u{1F4B3}", PAYMENT_REPORTED: "\u{1F4DD}",
    FUNDED: "\u{2705}", IN_PROGRESS: "\u{1F6E0}\u{FE0F}", DELIVERED: "\u{1F4E6}",
    RELEASE_PENDING: "\u{23F3}", RELEASE_REQUESTED: "\u{23F3}",
    DISPUTED: "\u{26A0}\u{FE0F}", UNDER_REVIEW: "\u{1F50D}",
    COMPLETED: "\u{2705}", REFUNDED: "\u{1F4B0}", RELEASED: "\u{1F4B8}",
    CANCELLED: "\u{274C}", EXPIRED: "\u{23F0}",
  };

  const dealList = deals
    .slice(0, 10)
    .map((d: any) => {
      const isBuyer = d.buyerId === userId;
      const otherParty = isBuyer ? d.seller : d.buyer;
      const emoji = statusEmoji[d.status] ?? "";
      const amount = (d.asset ?? "") === "INR" ? formatMoney(d.amount.toString(), "INR") : formatMoney(d.amount.toString(), d.asset);
      return `${emoji} <code>#${esc(d.inviteCode)}</code>  ${esc(amount)}\n   ${isBuyer ? "Buyer" : "Seller"} <-> @${esc(otherParty?.username ?? "N/A")}`;
    })
    .join("\n");

  await ctx.reply(
    `<b>MY ${esc(tab.toUpperCase())} DEALS</b>\n${dealList}` +
    (deals.length > 10 ? `\n\nShowing 10 of ${deals.length} deals` : ""),
    { reply_markup: dealTabs }
  );
}
