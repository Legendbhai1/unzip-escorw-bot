import { treasuryService } from "../../services/treasuryService.js";
import { dealService } from "../../services/dealService.js";
import { getUserDepositAddress } from "../../services/depositAddressService.js";
import { walletMenu, dealTabs, backToMain } from "../keyboards/index.js";
import { InlineKeyboard } from "grammy";
import { config } from "../../config/index.js";

type Ctx = any;

export async function showWallet(ctx: Ctx) {
  const userId = ctx.session.userId;
  const balances = await treasuryService.getAllBalances(userId);

  if (balances.length === 0) {
    await ctx.reply(
      `<b>WALLET</b>

No balances yet. Deposit funds to get started.`,
      { reply_markup: walletMenu }
    );
    return;
  }

  const lines = balances
    .map((b: any) => {
      const total = (parseFloat(b.available) + parseFloat(b.locked)).toFixed(8);
      return `<b>${b.asset}</b>  Available: ${parseFloat(b.available).toFixed(2)}  Locked: ${parseFloat(b.locked).toFixed(2)}  Total: ${total}`;
    })
    .join("\n");

  await ctx.reply(
    `<b>WALLET</b>\n\n${lines}`,
    { reply_markup: walletMenu }
  );
}

export async function showDeposit(ctx: Ctx) {
  const userId = ctx.session.userId;
  const session = ctx.session;
  const network = session.depositNetwork ?? "TRC20";
  const address = getUserDepositAddress(userId, network);

  await ctx.reply(
    `<b>DEPOSIT</b>\n\n` +
    `Send <b>USDT</b> on <b>${network}</b> to:\n\n<code>${address}</code>\n\n` +
    `Funds will be credited to your wallet after confirmations.\n` +
    `Then fund your deal from your wallet balance.\n\n` +
    `Fee: Buyer ${(config.buyerFeeBps / 100)}% | Seller ${(config.sellerFeeBps / 100)}%`,
    { reply_markup: new InlineKeyboard()
      .text("TRC20", "wallet:deposit_trc20")
      .text("BEP20", "wallet:deposit_bep20")
      .row()
      .text("Back to Wallet", "wallet:back") }
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
    const { prisma } = await import("../../lib/db.js");
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
    await ctx.reply(`<b>MY ${tab.toUpperCase()} DEALS</b>\n\nNo ${tab} deals found.`, { reply_markup: dealTabs });
    return;
  }

  const statusEmoji: Record<string, string> = {
    CREATED: "\u{1F9ED}", JOINED: "\u{1F91D}", AWAITING_FUNDING: "\u{1F4B0}",
    FUNDED: "\u{2705}", IN_PROGRESS: "\u{1F6E0}\u{FE0F}", DELIVERED: "\u{1F4E6}",
    RELEASE_PENDING: "\u{23F3}",
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
      return `${emoji} <code>#${d.inviteCode}</code>  ${d.amount} ${d.asset}\n   ${isBuyer ? "Buyer" : "Seller"} <-> @${otherParty?.username ?? "N/A"}`;
    })
    .join("\n");

  await ctx.reply(
    `<b>MY ${tab.toUpperCase()} DEALS</b>\n${dealList}` +
    (deals.length > 10 ? `\n\nShowing 10 of ${deals.length} deals` : ""),
    { reply_markup: dealTabs }
  );
}
