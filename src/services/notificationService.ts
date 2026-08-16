import { prisma } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { esc } from "../lib/html.js";
import { config } from "../config/index.js";

// Lazy import to avoid circular dependency with bot/index.ts
let _bot: any = null;
async function getBot() {
  if (!_bot) {
    const mod = await import("../bot/index.js");
    _bot = mod.bot;
  }
  return _bot;
}

/**
 * Notification Service sends cross-user Telegram messages.
 * All outgoing messages are centralized here so they can be
 * audited, throttled, and tested in one place.
 */
export const notificationService = {
  /**
   * Notify a user that a new deal has been created involving them.
   * There is NO web link — the deal message in the escrow group is the deal
   * reference and the escrow admin accepts it there.
   */
  async notifyDealCreated(
    userId: string,
    inviteCode: string,
    amount: string,
    asset: string,
    description: string,
    paymentLabel?: string,
    cryptoPayer?: string
  ) {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return;

      const b = await getBot();
      const amountStr = asset === "INR" ? `${amount} INR` : `${amount} ${asset}`;
      const cryptoPayerLine = cryptoPayer
        ? `Crypto payer: <b>${esc(cryptoPayer === "SELLER" ? "Seller" : "Buyer")}</b>\n`
        : "";

      await b.api.sendMessage(Number(user.telegramId),
        `<b>NEW ESCROW DEAL</b>\n\n` +
        `A deal has been created involving you:\n\n` +
        `Payment: <b>${esc(paymentLabel ?? (asset === "INR" ? "INR / UPI" : "USDT BEP20"))}</b>\n` +
        cryptoPayerLine +
        `Amount: <b>${esc(amountStr)}</b>\n` +
        `Item: ${esc(description.slice(0, 100))}\n\n` +
        `🔐 Payment is manually verified by the escrower.\n\n` +
        `The deal card has been posted to the escrow group. Please <b>agree to the deal there</b> so the escrow admin can accept it. The payment instructions will be posted on the deal card in the group once the admin accepts.`,
        { parse_mode: "HTML" }
      );
    } catch (e) {
      logger.warn({ userId, err: e }, "Failed to send deal created notification");
    }
  },

  /**
   * Send a message (optionally with an inline keyboard) to every configured
   * admin/escrower. When `opts.dealId` (or `opts.groupId`) is given, the
   * ACTIVE escrow admins assigned to that group are notified too — so a
   * group-scoped workflow reaches the admins who actually run that group.
   */
  async notifyAdmins(message: string, replyMarkup?: unknown, opts?: { dealId?: string; groupId?: string }) {
    const b = await getBot();
    const ids = new Set<number>([...config.adminTelegramIds]);

    if (opts?.groupId) {
      const groupAdmins = await prisma.groupAdmin.findMany({
        where: { groupId: opts.groupId, status: "ACTIVE" },
        include: { user: true },
      });
      for (const ga of groupAdmins) ids.add(Number(ga.user.telegramId));
    } else if (opts?.dealId) {
      const deal = await prisma.deal.findUnique({
        where: { id: opts.dealId },
        select: { groupChatId: true },
      });
      if (deal?.groupChatId) {
        const groupAdmins = await prisma.groupAdmin.findMany({
          where: { groupId: deal.groupChatId, status: "ACTIVE" },
          include: { user: true },
        });
        for (const ga of groupAdmins) ids.add(Number(ga.user.telegramId));
      }
    }

    for (const tid of ids) {
      try {
        await b.api.sendMessage(tid, message, {
          parse_mode: "HTML",
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
      } catch (e) {
        logger.warn({ tid, err: e }, "Failed to notify admin");
      }
    }
  },

  /**
   * Notify ONLY the admin who ACCEPTED the deal (acceptedBy) — the only admin
   * allowed to verify its payment. The payment-verification buttons NEVER
   * reach global admins or other group admins: in every fallback path (no
   * deal, no acceptedBy, unknown verifier user) the message is sent WITHOUT
   * the verification keyboard so the "Payment Received" button stays with the
   * accepting admin alone. Callbacks from anyone else are rejected server-side
   * anyway (see admin.ts isAssignedVerifier).
   */
  async notifyAssignedAdmin(message: string, replyMarkup?: unknown, dealId?: string) {
    if (!dealId) {
      // No deal context — inform admins, but never with verification buttons.
      await this.notifyAdmins(message, undefined);
      return;
    }
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      select: { acceptedBy: true, groupChatId: true },
    }).catch(() => null);
    if (!deal?.acceptedBy) {
      // Legacy row without an accepting admin — admins are informed of the
      // report but the verification buttons are NOT included.
      await this.notifyAdmins(message, undefined, { dealId });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: deal.acceptedBy } }).catch(() => null);
    if (!user) {
      await this.notifyAdmins(message, undefined, { dealId });
      return;
    }
    const b = await getBot();
    try {
      await b.api.sendMessage(Number(user.telegramId), message, {
        parse_mode: "HTML",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    } catch (e) {
      logger.warn({ dealId, err: e }, "Failed to notify the assigned admin");
    }
  },

  /**
   * Notify buyer that the deal is funded and ready.
   */
  async notifyDealFunded(
    buyerTelegramId: bigint,
    inviteCode: string,
    amount: string,
    asset: string
  ) {
    try {
      const b = await getBot();
      await b.api.sendMessage(Number(buyerTelegramId),
        `<b>DEAL FUNDED</b>\n\n` +
        `Deal #<code>${esc(inviteCode)}</code> is now funded with ${esc(amount)} ${esc(asset)}.\n\n` +
        `The seller can now deliver the item/service.`,
        { parse_mode: "HTML" }
      );
    } catch (e) {
      logger.warn({ buyerTelegramId, err: e }, "Failed to notify buyer: deal funded");
    }
  },

  /**
   * Notify seller that delivery has been marked.
   */
  async notifyDeliveryMarked(
    buyerTelegramId: bigint,
    inviteCode: string
  ) {
    try {
      const b = await getBot();
      await b.api.sendMessage(Number(buyerTelegramId),
        `<b>DELIVERY MARKED</b>\n\n` +
        `Deal #<code>${esc(inviteCode)}</code>\n\n` +
        `The seller has marked this deal as delivered.\n` +
        `Please verify that you received what was agreed.`,
        { parse_mode: "HTML" }
      );
    } catch (e) {
      logger.warn({ buyerTelegramId, err: e }, "Failed to notify buyer: delivery marked");
    }
  },

  /**
   * Notify both parties that a dispute has been opened.
   */
  async notifyDisputeOpened(
    buyerTelegramId: bigint,
    sellerTelegramId: bigint,
    inviteCode: string,
    openedBy: string
  ) {
    const msg =
      `<b>DISPUTE OPENED</b>\n\n` +
      `Deal #<code>${esc(inviteCode)}</code> has been disputed by @${esc(openedBy)}.\n\n` +
      `The deal is now frozen. An admin will review.\n` +
      `Do NOT send funds outside the escrow.`;

    const b = await getBot();
    for (const tid of [buyerTelegramId, sellerTelegramId]) {
      try {
        await b.api.sendMessage(Number(tid), msg, { parse_mode: "HTML" });
      } catch (e) {
        logger.warn({ tid, err: e }, "Failed to send dispute notification");
      }
    }
  },

  /**
   * Notify both parties that a dispute has been resolved.
   */
  async notifyDisputeResolved(
    buyerTelegramId: bigint,
    sellerTelegramId: bigint,
    inviteCode: string,
    resolution: "RELEASE_TO_SELLER" | "REFUND_BUYER",
    reason: string
  ) {
    const resolutionText = resolution === "RELEASE_TO_SELLER"
      ? "Funds released to the seller"
      : "Funds refunded to the buyer";

    const msg =
      `<b>DISPUTE RESOLVED</b>\n\n` +
      `Deal #<code>${esc(inviteCode)}</code>\n` +
      `${esc(resolutionText)}\n\n` +
      `Admin note: ${esc(reason)}`;

    const b = await getBot();
    for (const tid of [buyerTelegramId, sellerTelegramId]) {
      try {
        await b.api.sendMessage(Number(tid), msg, { parse_mode: "HTML" });
      } catch (e) {
        logger.warn({ tid, err: e }, "Failed to send dispute resolution notification");
      }
    }
  },

  /**
   * Notify user that withdrawal completed.
   */
  async notifyWithdrawalComplete(
    userId: string,
    asset: string,
    amount: string,
    txHash: string
  ) {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return;

      const b = await getBot();
      await b.api.sendMessage(Number(user.telegramId),
        `<b>WITHDRAWAL COMPLETE</b>\n\n` +
        `${esc(amount)} ${esc(asset)} withdrawn successfully.\n\n` +
        `TX: <code>${esc(txHash)}</code>`,
        { parse_mode: "HTML" }
      );
    } catch (e) {
      logger.warn({ userId, err: e }, "Failed to notify withdrawal complete");
    }
  },

  /**
   * Generic notification helper.
   */
  async notifyUser(userId: string, message: string) {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return;

      const b = await getBot();
      await b.api.sendMessage(Number(user.telegramId), message, { parse_mode: "HTML" });
    } catch (e) {
      logger.warn({ userId, err: e }, "Failed to send notification");
    }
  },

  /**
   * Notify user that their deposit was detected and credited.
   */
  async notifyDepositCredited(
    userId: string,
    asset: string,
    amount: string,
    txHash: string,
    dealInviteCode?: string
  ) {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return;

      let msg =
        `<b>DEPOSIT CREDITED</b>\n\n` +
        `${esc(amount)} ${esc(asset)} has been credited to your wallet.\n\n` +
        `TX: <code>${esc(txHash)}</code>`;

      if (dealInviteCode) {
        msg += `\n\nDeal #${dealInviteCode} has been funded automatically.`;
      }

      const b = await getBot();
      await b.api.sendMessage(Number(user.telegramId), msg, { parse_mode: "HTML" });
    } catch (e) {
      logger.warn({ userId, err: e }, "Failed to notify deposit credited");
    }
  },
};
