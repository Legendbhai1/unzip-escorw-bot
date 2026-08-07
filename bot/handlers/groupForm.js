const { escapeHtml } = require('../utils/format');
const {
  groupFormAgreeKeyboard,
  groupFormAdminClaimKeyboard,
  groupFormAdminActionKeyboard,
  paymentReceivedKeyboard,
} = require('../keyboards');
const groupDealService = require('../services/groupDealService');
const notify = require('../services/notificationService');
const botInfo = require('../state/botInfo');
const env = require('../config/env');
const db = require('../database/db');
const { parseTimeToMinutes, formatMinutes } = require('../utils/timeParse');

const USERNAME_RE = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/;

function officialTag() {
  return botInfo.get() || env.BOT_USERNAME || 'ESCROW_BY_NFT_MRKT_bot';
}

function emptyFormTemplate() {
  return (
    `➤ <b>NFT MRTK ESCROW FORM</b>\n\n` +
    `◉ Deal description ➤\n\n` +
    `◉ total deal amount ➤\n\n` +
    `◉ Condition ➤\n\n` +
    `◉ seller ➤\n\n` +
    `◉ Buyer ➤\n\n` +
    `◉ estimated time to complete ➤\n\n` +
    `◉ Deal only through official nft Mark escrow always verify username 🔎\n` +
    `@admins @${officialTag()}`
  );
}

function looksLikeFormAttempt(text) {
  if (!text) return false;
  // Must have the signature ◉ ... ➤ field markers from our form template
  const bulletCount = (text.match(/◉/g) || []).length;
  const fieldCount = (text.match(/➤/g) || []).length;
  return bulletCount >= 5 && fieldCount >= 5;
}

// Form verification is structure-based (◉ bullets + ➤ fields).
// The bot name in the form template is for user-side verification only.
// No tag/reply-to check needed — bot detects forms purely by structure.

/** Parses a filled-in form. Returns { fields } on success or { missing: [...] } on failure. */
function parseForm(text) {
  const fields = {};
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.includes('◉') || !line.includes('➤')) continue;
    const arrowIdx = line.indexOf('➤');
    const label = line.slice(line.indexOf('◉') + 1, arrowIdx).trim().toLowerCase();
    const value = line.slice(arrowIdx + 1).trim();
    if (!value) continue;
    if (label.includes('description')) fields.description = value;
    else if (label.includes('amount')) fields.amount = value;
    else if (label.includes('condition')) fields.condition = value;
    else if (label === 'seller' || label.includes('seller')) fields.sellerRaw = value;
    else if (label.includes('buyer')) fields.buyerRaw = value;
    else if (label.includes('time') || label.includes('eta') || label.includes('estimated')) fields.eta = value;
  }

  const missing = [];
  if (!fields.description) missing.push('Deal description');
  if (!fields.amount) missing.push('total deal amount');
  if (!fields.condition) missing.push('Condition');
  if (!fields.sellerRaw) missing.push('seller');
  if (!fields.buyerRaw) missing.push('Buyer');
  if (!fields.eta) missing.push('estimated time to complete');
  if (missing.length) return { missing };

  if (!USERNAME_RE.test(fields.sellerRaw)) return { missing: [], invalid: 'seller must be a valid @username' };
  if (!USERNAME_RE.test(fields.buyerRaw)) return { missing: [], invalid: 'Buyer must be a valid @username' };
  if (fields.sellerRaw.toLowerCase() === fields.buyerRaw.toLowerCase()) {
    return { missing: [], invalid: 'seller and Buyer cannot be the same @username' };
  }

  // Validate ETA format — whole numbers only
  const timeResult = parseTimeToMinutes(fields.eta);
  if (!timeResult.valid) {
    return { missing: [], invalid: timeResult.error };
  }
  fields.etaMinutes = timeResult.minutes;

  return { fields };
}

const PAYMENT_STATUS_LABELS = {
  null: '',
  PAYMENT_CONFIRMED: '💰 Payment confirmed — awaiting buyer/seller action',
  RELEASED: '✅ Funds released',
  REFUNDED: '↩️ Deal refunded',
  REVERSED: '🔄 Deal auto-reversed (deadline expired)',
};

function filledFormText(deal) {
  const sellerMark = deal.seller_agreed ? '✅' : '⏳';
  const buyerMark = deal.buyer_agreed ? '✅' : '⏳';
  let text =
    `🛡️ <b>NFT MRKT ESCROW FORM</b>\n\n` +
    `◉ Deal description ➤ ${escapeHtml(deal.description)}\n\n` +
    `◉ total deal amount ➤ ${escapeHtml(deal.amount)}\n\n` +
    `◉ Condition ➤ ${escapeHtml(deal.condition)}\n\n` +
    `◉ seller ➤ @${escapeHtml(deal.seller_username)} ${sellerMark}\n\n` +
    `◉ Buyer ➤ @${escapeHtml(deal.buyer_username)} ${buyerMark}\n\n` +
    `◉ estimated time to complete ➤ ${escapeHtml(deal.eta)}${
      deal.eta_minutes ? ` (${formatMinutes(deal.eta_minutes)})` : ''
    }\n\n` +
    `◉ Deal only through official nft Mark escrow always verify username 🔎\n` +
    `@admins @${officialTag()}`;

  if (deal.escrow_id) {
    text += `\n\n🔐 Escrow ID: <code>${deal.escrow_id}</code>\nCheck status anytime: /dealstatus ${deal.escrow_id}`;
  }

  if (deal.status === 'CLAIMED') {
    text += '\n\n🛡️ Claimed by an admin — awaiting their decision.';
  } else if (deal.status === 'FORWARDED') {
    text += '\n\n✅ Deal accepted and moving forward.';
    const paymentStatus = PAYMENT_STATUS_LABELS[deal.status_after_payment] || '';
    if (paymentStatus) text += `\n${paymentStatus}`;
  } else if (deal.status === 'DISCARDED') {
    text += '\n\n❌ Deal discarded by an admin.';
  } else if (deal.status === 'AWAITING_ADMIN') {
    text += '\n\n🟡 Both parties agreed — waiting for admin/owner to accept the deal.';
  }

  return text;
}

async function isEligibleAdmin(ctx, chatId, userId) {
  if (env.ADMIN_IDS.includes(Number(userId))) return true;
  try {
    const member = await ctx.telegram.getChatMember(chatId, userId);
    return member && member.status === 'creator';
  } catch (err) {
    return false;
  }
}

async function sendCreateDealForm(ctx) {
  await ctx.reply(
    emptyFormTemplate() +
      `\n\n<i>Copy this message, fill in every ➤ field on its own line, and send it back here as one message.</i>\n\n` +
      `<i>⚠️ Time format: whole numbers only — 1h, 30m, 2w, 3d (no fractions like 1.5h)</i>`,
    { parse_mode: 'HTML' }
  );
}

function register(bot) {
  // /form is an alias for /createdeal
  bot.command('form', sendCreateDealForm);
  bot.command('createdeal', sendCreateDealForm);
  bot.action('menu:create_deal', async (ctx) => {
    await ctx.answerCbQuery();
    await sendCreateDealForm(ctx);
  });

  // ─── Form text listener ───
  bot.on('text', async (ctx, next) => {
    const text = ctx.message.text;
    if (!text || text.startsWith('/')) return next();
    if (!looksLikeFormAttempt(text)) return next();

    const result = parseForm(text);
    if (result.invalid) {
      await ctx.reply(`⚠️ ${result.invalid}. Use /form to get a fresh form.`);
      return;
    }
    if (result.missing && result.missing.length) {
      await ctx.reply(
        `⚠️ Missing or empty fields: ${result.missing.join(', ')}.\nUse /form to get a fresh form and fill in every ➤ field.`
      );
      return;
    }

    const { fields } = result;

    // Verify both buyer and seller have started the bot (exist in users table)
    const { rows: sellerCheck } = await db.query(
      `SELECT telegram_id, username FROM users WHERE username = $1`,
      [fields.sellerRaw.replace('@', '').toLowerCase()]
    );
    const { rows: buyerCheck } = await db.query(
      `SELECT telegram_id, username FROM users WHERE username = $1`,
      [fields.buyerRaw.replace('@', '').toLowerCase()]
    );

    if (!sellerCheck.length) {
      await ctx.reply(
        `⚠️ @${escapeHtml(fields.sellerRaw)} has not started the bot yet. ` +
        `Ask them to DM the bot and send /start first, then resubmit this form.`
      );
      return;
    }
    if (!buyerCheck.length) {
      await ctx.reply(
        `⚠️ @${escapeHtml(fields.buyerRaw)} has not started the bot yet. ` +
        `Ask them to DM the bot and send /start first, then resubmit this form.`
      );
      return;
    }

    const deal = await groupDealService.createDraft(
      {
        chatId: ctx.chat.id,
        description: fields.description,
        amount: fields.amount,
        condition: fields.condition,
        eta: fields.eta,
        etaMinutes: fields.etaMinutes,
        sellerUsername: fields.sellerRaw,
        buyerUsername: fields.buyerRaw,
      },
      ctx.from.id
    );

    // Store eta_minutes and deadline_at
    if (fields.etaMinutes) {
      const deadlineAt = new Date(Date.now() + fields.etaMinutes * 60 * 1000);
      await db.query(
        `UPDATE group_deals SET eta_minutes = $2, deadline_at = $3 WHERE id = $1`,
        [deal.id, fields.etaMinutes, deadlineAt.toISOString()]
      );
    }

    const freshDeal = await groupDealService.getById(deal.id);
    const sent = await ctx.reply(filledFormText(freshDeal), {
      parse_mode: 'HTML',
      ...groupFormAgreeKeyboard(deal.id, { sellerAgreed: false, buyerAgreed: false }),
    });
    await groupDealService.setFormMessage(deal.id, ctx.chat.id, sent.message_id);
  });

  // ─── Agreement buttons ───
  bot.action(/^gform:agree:(\d+):(seller|buyer)$/, async (ctx) => {
    const internalId = Number(ctx.match[1]);
    const role = ctx.match[2];

    const deal = await groupDealService.getById(internalId);
    if (!deal) return ctx.answerCbQuery('Deal not found.', { show_alert: true });
    if (deal.status !== 'AWAITING_AGREEMENT') {
      return ctx.answerCbQuery('This deal is no longer awaiting agreement.', { show_alert: true });
    }

    const expected = role === 'seller' ? deal.seller_username : deal.buyer_username;
    const actual = ctx.from.username ? ctx.from.username.toLowerCase() : null;
    if (!actual) {
      return ctx.answerCbQuery('You need a Telegram @username set to do this.', { show_alert: true });
    }
    if (actual !== expected) {
      return ctx.answerCbQuery(`Only @${expected} can tap this as the ${role}.`, { show_alert: true });
    }

    try {
      const { deal: updated, bothAgreed } = await groupDealService.agree(internalId, role, ctx.from.id);
      await ctx.answerCbQuery('✅ Agreed.');
      await ctx.editMessageText(filledFormText(updated), {
        parse_mode: 'HTML',
        ...(bothAgreed
          ? groupFormAdminClaimKeyboard(internalId)
          : groupFormAgreeKeyboard(internalId, { sellerAgreed: updated.seller_agreed, buyerAgreed: updated.buyer_agreed })),
      });
    } catch (err) {
      if (err.message === 'ALREADY_AGREED') return ctx.answerCbQuery('You already agreed.', { show_alert: true });
      console.error(err);
      return ctx.answerCbQuery('⚠️ Could not record your agreement. Try again.', { show_alert: true });
    }
  });

  // ─── Admin claim ───
  bot.action(/^gform:claim:(\d+)$/, async (ctx) => {
    const internalId = Number(ctx.match[1]);
    const deal = await groupDealService.getById(internalId);
    if (!deal) return ctx.answerCbQuery('Deal not found.', { show_alert: true });

    const eligible = await isEligibleAdmin(ctx, deal.chat_id, ctx.from.id);
    if (!eligible) return ctx.answerCbQuery('❌ Only an admin or the group owner can accept deals.', { show_alert: true });

    try {
      const updated = await groupDealService.claim(internalId, ctx.from.id);
      await ctx.answerCbQuery('🛡️ Deal claimed.');
      await ctx.editMessageText(filledFormText(updated), {
        parse_mode: 'HTML',
        ...groupFormAdminActionKeyboard(internalId),
      });
    } catch (err) {
      console.error(err);
      return ctx.answerCbQuery(
        `⚠️ ${err.message === 'Deal is not awaiting admin acceptance.' ? err.message : 'Could not claim deal.'}`,
        { show_alert: true }
      );
    }
  });

  // ─── Admin forward / discard ───
  bot.action(/^gform:(forward|discard):(\d+)$/, async (ctx) => {
    const action = ctx.match[1];
    const internalId = Number(ctx.match[2]);
    const deal = await groupDealService.getById(internalId);
    if (!deal) return ctx.answerCbQuery('Deal not found.', { show_alert: true });

    if (Number(deal.claimed_by) !== Number(ctx.from.id)) {
      return ctx.answerCbQuery('❌ Only the admin who accepted this deal can do that.', { show_alert: true });
    }

    try {
      const updated =
        action === 'forward'
          ? await groupDealService.forward(internalId, ctx.from.id)
          : await groupDealService.discard(internalId, ctx.from.id);
      await ctx.answerCbQuery(action === 'forward' ? '➡️ Deal forwarded.' : '🗑️ Deal discarded.');

      if (action === 'forward') {
        // After forwarding, show the Payment Received button for admin
        await ctx.editMessageText(filledFormText(updated), {
          parse_mode: 'HTML',
          ...paymentReceivedKeyboard(internalId),
        });
      } else {
        await ctx.editMessageText(filledFormText(updated), { parse_mode: 'HTML' });
      }

      const note =
        action === 'forward'
          ? `✅ Your deal <code>${updated.escrow_id}</code> was accepted and is moving forward.`
          : `❌ Your deal <code>${updated.escrow_id}</code> was discarded by an admin.`;
      if (updated.seller_id) await notify.safeSend(updated.seller_id, note, { parse_mode: 'HTML' });
      if (updated.buyer_id) await notify.safeSend(updated.buyer_id, note, { parse_mode: 'HTML' });
    } catch (err) {
      console.error(err);
      return ctx.answerCbQuery('⚠️ Could not update the deal.', { show_alert: true });
    }
  });

  // ─── /dealstatus command ───
  bot.command('dealstatus', async (ctx) => {
    const arg = ctx.message.text.split(/\s+/)[1];
    if (!arg) return ctx.reply('Usage: /dealstatus <escrow id>\nExample: /dealstatus ESC-8F42A1');

    const deal = await groupDealService.getByEscrowId(arg);
    if (!deal) return ctx.reply(`No deal found with escrow ID ${escapeHtml(arg.toUpperCase())}.`);

    const statusLabels = {
      AWAITING_AGREEMENT: '🟡 Awaiting buyer/seller agreement',
      AWAITING_ADMIN: '🟡 Awaiting admin acceptance',
      CLAIMED: '🛡️ Claimed by admin, pending decision',
      FORWARDED: '✅ Accepted — moving forward',
      DISCARDED: '❌ Discarded',
    };

    const paymentLabels = {
      PAYMENT_CONFIRMED: '💰 Payment confirmed — awaiting release/refund',
      RELEASED: '✅ Released',
      REFUNDED: '↩️ Refunded',
      REVERSED: '🔄 Auto-reversed',
    };

    let text =
      `🔐 <b>Deal ${escapeHtml(deal.escrow_id)}</b>\n` +
      `Status: ${statusLabels[deal.status] || deal.status}\n\n` +
      `Description: ${escapeHtml(deal.description)}\n` +
      `Amount: ${escapeHtml(deal.amount)}\n` +
      `Condition: ${escapeHtml(deal.condition)}\n` +
      `Seller: @${escapeHtml(deal.seller_username)} ${deal.seller_agreed ? '✅' : '⏳'}\n` +
      `Buyer: @${escapeHtml(deal.buyer_username)} ${deal.buyer_agreed ? '✅' : '⏳'}\n` +
      `ETA: ${escapeHtml(deal.eta)}`;

    if (deal.deadline_at) {
      text += `\nDeadline: ${new Date(deal.deadline_at).toUTCString()}`;
    }

    if (deal.status_after_payment && deal.status_after_payment !== 'PAYMENT_CONFIRMED') {
      text += `\n\nPayment Status: ${paymentLabels[deal.status_after_payment] || deal.status_after_payment}`;
    }

    if (deal.payment_received_at) {
      text += `\nPayment confirmed at: ${new Date(deal.payment_received_at).toUTCString()}`;
    }
    if (deal.released_at) {
      text += `\nReleased at: ${new Date(deal.released_at).toUTCString()}`;
    }
    if (deal.refunded_at) {
      text += `\nRefunded at: ${new Date(deal.refunded_at).toUTCString()}`;
    }
    if (deal.reversed_at) {
      text += `\nAuto-reversed at: ${new Date(deal.reversed_at).toUTCString()}`;
    }

    await ctx.reply(text, { parse_mode: 'HTML' });
  });
}

module.exports = { register, sendCreateDealForm, filledFormText };
