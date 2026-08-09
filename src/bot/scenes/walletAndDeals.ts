import { InlineKeyboard } from "grammy";
import { treasuryService } from "../../services/treasuryService.js";
import { dealService } from "../../services/dealService.js";
import { getUserDepositAddress } from "../../services/depositAddressService.js";
import { walletMenu, dealTabs, backToMain } from "../keyboards/index.js";
import { config } from "../../config/index.js";
import { logger } from "../../lib/logger.js";
import { esc } from "../../lib/html.js";

type Ctx = any;

export async function showWallet(ctx: Ctx) {
  const userId = ctx.session.userId;
  const balances = await treasuryService.getAllBalances(userId);

  if (balances.length === 0) {
    await ctx.reply(
      `<b>WALLET</b>\n\nNo balances yet. Deposit funds to get started.`,
      { reply_markup: walletMenu }
    );
    return;
  }

  const lines = balances
    .map((b: any) => {
      const total = (parseFloat(b.available) + parseFloat(b.locked)).toFixed(8);
      return `<b>${esc(b.asset)}</b>  Available: ${parseFloat(b.available).toFixed(2)}  Locked: ${parseFloat(b.locked).toFixed(2)}  Total: ${total}`;
    })
    .join("\n");

  await ctx.reply(
    `<b>WALLET</b>\n\n${lines}`,
    { reply_markup: walletMenu }
  );
}

function depositKeyboard() {
  return new InlineKeyboard()
    .text("TRC20", "wallet:deposit_trc20")
    .text("BEP20", "wallet:deposit_bep20")
    .row()
    .text("Back to Wallet", "wallet:back");
}

export async function showDeposit(ctx: Ctx) {
  const userId = ctx.session.userId;
  const network = (ctx.session.depositNetwork ?? "TRC20").toUpperCase();

  // Get the real per-user deposit address. Returns null when the deposit
  // mnemonic is not configured — in that case we NEVER show a fabricated
  // address; the user gets a clear "temporarily unavailable" message.
  let address: string | null = null;
  try {
    address = await getUserDepositAddress(userId, network, "USDT");
  } catch (e) {
    logger.error({ userId, network, err: e }, "Failed to load deposit address");
  }

  if (!address) {
    logger.warn(
      { userId, network },
      "Deposit screen requested but no deposit address is configured (DEPOSIT_HD_MNEMONIC)"
    );
    await ctx.reply(
      `<b>DEPOSIT</b>\n\nDeposits temporarily unavailable — address not configured.\n\nPlease contact support.`,
      { reply_markup: depositKeyboard() }
    );
    return;
  }

  const buyerFeePct = (config.buyerFeeBps / 100).toFixed(config.buyerFeeBps % 100 === 0 ? 0 : 2);
  const sellerFeePct = (config.sellerFeeBps / 100).toFixed(config.sellerFeeBps % 100 === 0 ? 0 : 2);

  await ctx.reply(
    `<b>DEPOSIT</b>\n\n` +
    `Send <b>USDT</b> on <b>${esc(network)}</b> to:\n\n<code>${esc(address)}</code>\n\n` +
    `Funds will be credited to your wallet after confirmations.\n` +
    `Then fund your deal from your wallet balance.\n\n` +
    `Fee: Buyer ${buyerFeePct}% | Seller ${sellerFeePct}%`,
    { reply_markup: depositKeyboard() }
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
    await ctx.reply(`<b>MY ${esc(tab.toUpperCase())} DEALS</b>\n\nNo ${esc(tab)} deals found.`, { reply_markup: dealTabs });
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
      return `${emoji} <code>#${esc(d.inviteCode)}</code>  ${esc(d.amount)} ${esc(d.asset)}\n   ${isBuyer ? "Buyer" : "Seller"} <-> @${esc(otherParty?.username ?? "N/A")}`;
    })
    .join("\n");

  await ctx.reply(
    `<b>MY ${esc(tab.toUpperCase())} DEALS</b>\n${dealList}` +
    (deals.length > 10 ? `\n\nShowing 10 of ${deals.length} deals` : ""),
    { reply_markup: dealTabs }
  );
}
