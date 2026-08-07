/**
 * Deal flow handler: payment received → release/refund with confirmation.
 *
 * Flow after admin forwards a group deal:
 *   1. Admin sees "💰 Payment Received" button on the group form
 *   2. Admin clicks it → bot notifies both users in DM, sends role-specific buttons
 *   3. Buyer gets Release button (cannot see Refund)
 *   4. Seller gets Refund button (cannot see Release)
 *   5. Either button requires a SECOND confirmation tap (irreversible)
 *   6. After confirmation → admin notified in DM + group, deal finalized
 */

const db = require('../database/db');
const { requireAdmin } = require('../middleware/auth');
const groupDealService = require('../services/groupDealService');
const notify = require('../services/notificationService');
const env = require('../config/env');
const {
  paymentReceivedKeyboard,
  releaseRefundKeyboard,
  confirmReleaseKeyboard,
  confirmRefundKeyboard,
} = require('../keyboards');
const { escapeHtml, fmtUser } = require('../utils/format');

/**
 * Check if user is the seller for a group deal.
 */
function isSeller(deal, userId) {
  if (deal.seller_id && Number(deal.seller_id) === Number(userId)) return true;
  return false;
}

function isBuyer(deal, userId) {
  if (deal.buyer_id && Number(deal.buyer_id) === Number(userId)) return true;
  return false;
}

/** Update group_deals form message in the group chat */
async function updateGroupFormMessage(bot, deal) {
  if (!deal.chat_id || !deal.form_message_id) return;
  const { filledFormText } = require('./groupForm');
  try {
    await bot.telegram.editMessageText(
      deal.chat_id,
      deal.form_message_id,
      undefined,
      filledFormText(deal),
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.warn(`Could not update form message ${deal.form_message_id}:`, err.message);
  }
}

function register(bot) {
  // ─── /fee command ───
  bot.command('fee', async (ctx) => {
    const settingsService = require('../services/settingsService');
    const feePercent = await settingsService.getFeePercent();
    await ctx.reply(
      `💰 <b>Escrow Fee</b>\n\nCurrent fee: ${feePercent}%\nFor detailed fee info, contact @beinglazyyy.`,
      { parse_mode: 'HTML' }
    );
  });

  // ─── /dispute command (standalone) ───
  bot.command('dispute', async (ctx) => {
    await ctx.reply(
      `⚖️ <b>Open a Dispute</b>\n\nTo open a dispute on an active deal, use the ⚖️ Open Dispute button on the deal details view.\nYou can also use <code>/adddispute &lt;dispute_id&gt;</code> to add evidence.`,
      { parse_mode: 'HTML' }
    );
  });

  // ─── Step 1: Admin clicks "Payment Received" after forwarding a deal ───
  bot.action(/^gflow:payment_received:(\d+)$/, requireAdmin, async (ctx) => {
    const internalId = Number(ctx.match[1]);
    const deal = await groupDealService.getById(internalId);
    if (!deal) return ctx.answerCbQuery('Deal not found.', { show_alert: true });
    if (deal.status !== 'FORWARDED') {
      return ctx.answerCbQuery('This deal is not in a forwarded/active state.', { show_alert: true });
    }
    if (deal.status_after_payment && deal.status_after_payment !== 'PAYMENT_CONFIRMED') {
      return ctx.answerCbQuery('Payment already recorded for this deal.', { show_alert: true });
    }

    await ctx.answerCbQuery('💰 Payment recorded.');

    // Update deal in DB
    const etaMinutes = deal.eta_minutes || 0;
    const deadlineAt = deal.deadline_at || null;

    await db.query(
      `UPDATE group_deals
       SET payment_received_at = now(),
           payment_received_by = $2,
           status_after_payment = 'PAYMENT_CONFIRMED'
       WHERE id = $1`,
      [internalId, ctx.from.id]
    );

    const updatedDeal = await groupDealService.getById(internalId);

    // Update the group form message to show payment status
    await updateGroupFormMessage(bot, updatedDeal);

    // Notify both users in DM to continue the deal
    const dmText =
      `💰 <b>Payment Received — Deal ${escapeHtml(deal.escrow_id)}</b>\n\n` +
      `Admin has confirmed receiving the payment. Please continue your deal.\n\n` +
      `Description: ${escapeHtml(deal.description)}\n` +
      `Amount: ${escapeHtml(deal.amount)}\n` +
      (deadlineAt ? `Deadline: ${new Date(deadlineAt).toUTCString()}\n` : '');

    // Send buyer their Release button in DM
    if (deal.buyer_id) {
      await notify.safeSend(
        deal.buyer_id,
        dmText + `\n⚠️ Use the button below to release funds when the deal is complete.\n` +
        `<b>This action is IRREVERSIBLE after confirmation.</b>`,
        { parse_mode: 'HTML', ...releaseRefundKeyboard(internalId, 'buyer') }
      );
    }

    // Send seller their Refund button in DM
    if (deal.seller_id) {
      await notify.safeSend(
        deal.seller_id,
        dmText + `\n⚠️ Use the button below to request a refund if the deal goes wrong.\n` +
        `<b>This action is IRREVERSIBLE after confirmation.</b>`,
        { parse_mode: 'HTML', ...releaseRefundKeyboard(internalId, 'seller') }
      );
    }

    // Also post in group
    await ctx.reply(
      `💰 <b>Payment Confirmed</b> for deal ${escapeHtml(deal.escrow_id)}\n` +
      `@${escapeHtml(deal.seller_username || 'seller')} @${escapeHtml(deal.buyer_username || 'buyer')}\n` +
      `Please check your DMs for further action.`,
      { parse_mode: 'HTML' }
    );
  });

  // ─── Step 2: Buyer taps Release (or Seller taps Refund) — first tap shows confirmation ───
  bot.action(/^gflow:(release|refund):(\d+)$/, async (ctx) => {
    const action = ctx.match[1]; // 'release' or 'refund'
    const internalId = Number(ctx.match[2]);
    const deal = await groupDealService.getById(internalId);
    if (!deal) return ctx.answerCbQuery('Deal not found.', { show_alert: true });
    if (deal.status_after_payment !== 'PAYMENT_CONFIRMED') {
      return ctx.answerCbQuery('This deal is not in a payable state.', { show_alert: true });
    }

    const userId = ctx.from.id;

    // Role check: buyer can only release, seller can only refund
    if (action === 'release') {
      if (!isBuyer(deal, userId)) {
        return ctx.answerCbQuery('❌ Only the buyer can release funds.', { show_alert: true });
      }
    } else {
      if (!isSeller(deal, userId)) {
        return ctx.answerCbQuery('❌ Only the seller can request a refund.', { show_alert: true });
      }
    }

    await ctx.answerCbQuery();

    // Show confirmation keyboard — user must tap again to confirm
    if (action === 'release') {
      await ctx.reply(
        `⚠️ <b>FINAL CONFIRMATION</b>\n\n` +
        `You are about to <b>RELEASE</b> funds for deal ${escapeHtml(deal.escrow_id)}.\n` +
        `This action <b>CANNOT be reversed</b>.\n\n` +
        `Tap "✅ Confirm Release" to proceed.`,
        { parse_mode: 'HTML', ...confirmReleaseKeyboard(internalId) }
      );
    } else {
      await ctx.reply(
        `⚠️ <b>FINAL CONFIRMATION</b>\n\n` +
        `You are about to <b>REFUND</b> deal ${escapeHtml(deal.escrow_id)}.\n` +
        `This action <b>CANNOT be reversed</b>.\n\n` +
        `Tap "✅ Confirm Refund" to proceed.`,
        { parse_mode: 'HTML', ...confirmRefundKeyboard(internalId) }
      );
    }
  });

  // ─── Step 3: Buyer confirms Release ───
  bot.action(/^gflow:confirm_release:(\d+)$/, async (ctx) => {
    const internalId = Number(ctx.match[1]);
    const deal = await groupDealService.getById(internalId);
    if (!deal) return ctx.answerCbQuery('Deal not found.', { show_alert: true });
    if (deal.status_after_payment !== 'PAYMENT_CONFIRMED') {
      return ctx.answerCbQuery('This deal is no longer in a confirmable state.', { show_alert: true });
    }
    if (!isBuyer(deal, ctx.from.id)) {
      return ctx.answerCbQuery('❌ Only the buyer can confirm release.', { show_alert: true });
    }

    await ctx.answerCbQuery('✅ Funds released.');

    // Finalize in DB
    await db.query(
      `UPDATE group_deals
       SET status_after_payment = 'RELEASED',
           released_at = now(),
           released_by = $2
       WHERE id = $1`,
      [internalId, ctx.from.id]
    );

    const updatedDeal = await groupDealService.getById(internalId);
    await updateGroupFormMessage(bot, updatedDeal);

    // Notify both users
    const msg = `✅ <b>DEAL RELEASED</b>\n\nDeal ${escapeHtml(deal.escrow_id)} has been released by the buyer. Funds should be transferred to the seller.`;
    if (deal.buyer_id) await notify.safeSend(deal.buyer_id, msg, { parse_mode: 'HTML' });
    if (deal.seller_id) await notify.safeSend(deal.seller_id, msg, { parse_mode: 'HTML' });

    // Notify admins in DM
    for (const adminId of env.ADMIN_IDS) {
      await notify.safeSend(
        adminId,
        `✅ <b>RELEASE CONFIRMED</b>\n\nDeal ${escapeHtml(deal.escrow_id)} was released by buyer.\nBuyer ID: ${ctx.from.id}\nTime: ${new Date().toUTCString()}`,
        { parse_mode: 'HTML' }
      );
    }

    // Notify in group
    try {
      await bot.telegram.sendMessage(
        deal.chat_id,
        `✅ <b>DEAL RELEASED</b>\nDeal ${escapeHtml(deal.escrow_id)} — buyer confirmed release. @${escapeHtml(deal.seller_username || 'seller')} @${escapeHtml(deal.buyer_username || 'buyer')}`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.warn('Could not post release notification to group:', err.message);
    }
  });

  // ─── Step 3b: Seller confirms Refund ───
  bot.action(/^gflow:confirm_refund:(\d+)$/, async (ctx) => {
    const internalId = Number(ctx.match[1]);
    const deal = await groupDealService.getById(internalId);
    if (!deal) return ctx.answerCbQuery('Deal not found.', { show_alert: true });
    if (deal.status_after_payment !== 'PAYMENT_CONFIRMED') {
      return ctx.answerCbQuery('This deal is no longer in a confirmable state.', { show_alert: true });
    }
    if (!isSeller(deal, ctx.from.id)) {
      return ctx.answerCbQuery('❌ Only the seller can confirm refund.', { show_alert: true });
    }

    await ctx.answerCbQuery('✅ Refund confirmed.');

    // Finalize in DB
    await db.query(
      `UPDATE group_deals
       SET status_after_payment = 'REFUNDED',
           refunded_at = now(),
           refunded_by = $2
       WHERE id = $1`,
      [internalId, ctx.from.id]
    );

    const updatedDeal = await groupDealService.getById(internalId);
    await updateGroupFormMessage(bot, updatedDeal);

    // Notify both users
    const msg = `↩️ <b>DEAL REFUNDED</b>\n\nDeal ${escapeHtml(deal.escrow_id)} has been refunded. Funds should be returned to the buyer.`;
    if (deal.buyer_id) await notify.safeSend(deal.buyer_id, msg, { parse_mode: 'HTML' });
    if (deal.seller_id) await notify.safeSend(deal.seller_id, msg, { parse_mode: 'HTML' });

    // Notify admins in DM
    for (const adminId of env.ADMIN_IDS) {
      await notify.safeSend(
        adminId,
        `↩️ <b>REFUND CONFIRMED</b>\n\nDeal ${escapeHtml(deal.escrow_id)} was refunded by seller.\nSeller ID: ${ctx.from.id}\nTime: ${new Date().toUTCString()}`,
        { parse_mode: 'HTML' }
      );
    }

    // Notify in group
    try {
      await bot.telegram.sendMessage(
        deal.chat_id,
        `↩️ <b>DEAL REFUNDED</b>\nDeal ${escapeHtml(deal.escrow_id)} — seller confirmed refund. @${escapeHtml(deal.seller_username || 'seller')} @${escapeHtml(deal.buyer_username || 'buyer')}`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.warn('Could not post refund notification to group:', err.message);
    }
  });

  // ─── Cancel action button on confirmation keyboards ───
  bot.action(/^gflow:cancel_action:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery('Action cancelled.');
    await ctx.reply('❌ Action cancelled. No changes were made.');
  });
}

module.exports = { register };
