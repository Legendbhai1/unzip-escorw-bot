const dealService = require('../services/dealService');
const escrowerService = require('../services/escrowerService');
const notify = require('../services/notificationService');
const {
  activeDealKeyboard,
  dealCreatedKeyboard,
  confirmCancelKeyboard,
  escrowerCompleteKeyboard,
} = require('../keyboards');
const { escapeHtml, statusLabel, fmtUser } = require('../utils/format');

function detailText(deal) {
  return (
    `🛡️ <b>ESCORW DEAL</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `ID: #${deal.id}\n` +
    `Type: ${deal.deal_type}\n` +
    `Description: ${escapeHtml(deal.description)}\n` +
    `Amount: ${deal.amount} ${escapeHtml(deal.currency)}\n` +
    `Buyer: ${fmtUser(deal.buyer_id)}\n` +
    `Seller: ${fmtUser(deal.seller_id)}\n` +
    `Escrower: ${deal.escrower_id ? fmtUser(deal.escrower_id) : 'not assigned'}\n` +
    `Status: ${statusLabel(deal.status)}\n` +
    `Escrow Fee: ${deal.fee_percent}%\n` +
    `Deadline: ${deal.deadline ? new Date(deal.deadline).toUTCString() : 'not set'}\n` +
    `━━━━━━━━━━━━━━━━`
  );
}

function isParticipant(deal, userId) {
  const id = Number(userId);
  return [deal.buyer_id, deal.seller_id, deal.escrower_id, deal.created_by].includes(id);
}

async function replyDealNotFound(ctx) {
  await ctx.reply('⚠️ Deal not found.');
}

function register(bot) {
  bot.command('mydeals', async (ctx) => {
    const deals = await dealService.listDealsForUser(ctx.from.id);
    if (!deals.length) return ctx.reply('You have no deals yet. Use /form to create one.');
    const lines = deals.map((d) => `#${d.id} — ${statusLabel(d.status)} — ${d.amount} ${d.currency}`);
    await ctx.reply(lines.join('\n'));
  });

  bot.command('deal', async (ctx) => {
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Usage: /deal <id>');
    const deal = await dealService.getDeal(id.replace(/^#/, ''));
    if (!deal) return replyDealNotFound(ctx);
    await ctx.reply(detailText(deal), { parse_mode: 'HTML' });
  });

  bot.action(/^deal:view:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const deal = await dealService.getDeal(ctx.match[1]);
    if (!deal) return replyDealNotFound(ctx);
    await ctx.reply(detailText(deal), { parse_mode: 'HTML' });
  });

  bot.action(/^deal:activate:(.+)$/, async (ctx) => {
    const dealId = ctx.match[1];
    try {
      const deal = await dealService.activateDeal(dealId, ctx.from.id);
      await ctx.answerCbQuery('Deal activated.');
      await ctx.reply(
        `🟢 <b>DEAL ACTIVATED</b>\nDeal ID: #${deal.id}\nEscrower: ${fmtUser(ctx.from.id, ctx.from.username)}\nStatus: ACTIVE`,
        { parse_mode: 'HTML' }
      );
      await notify.notifyDealParticipants(deal, `🟢 Deal #${deal.id} is now ACTIVE. Escrower assigned.`, {
        excludeId: ctx.from.id,
      });
    } catch (err) {
      if (err.message === 'LIMIT_EXCEEDED') {
        await ctx.answerCbQuery();
        await ctx.reply(
          `⚠️ <b>LIMIT EXCEEDED</b>\n\nDeal Amount: ${err.dealAmount}\nEscrower Limit: ${err.escrowerLimit}\n\nPlease select an escrower with sufficient authorized limit.`,
          { parse_mode: 'HTML' }
        );
      } else {
        await ctx.answerCbQuery(err.message || 'Could not activate deal.', { show_alert: true });
      }
    }
  });

  bot.action(/^deal:cancel:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Are you sure you want to cancel this deal?', confirmCancelKeyboard(ctx.match[1]));
  });

  bot.action(/^deal:cancel_confirm:(.+)$/, async (ctx) => {
    const dealId = ctx.match[1];
    try {
      const deal = await dealService.cancelDeal(dealId, ctx.from.id, 'user requested', {
        admin: ctx.state.isAdmin,
      });
      await ctx.answerCbQuery('Deal cancelled.');
      await ctx.reply(`❌ Deal #${deal.id} has been CANCELLED.`);
      await notify.notifyDealParticipants(deal, `❌ Deal #${deal.id} was cancelled.`, { excludeId: ctx.from.id });
    } catch (err) {
      await ctx.answerCbQuery(err.message || 'Could not cancel deal.', { show_alert: true });
    }
  });

  bot.action(/^deal:delivered:(.+)$/, async (ctx) => {
    try {
      const deal = await dealService.markDelivered(ctx.match[1], ctx.from.id);
      await ctx.answerCbQuery('Marked as delivered.');
      await notify.notifyDealParticipants(deal, `📦 Seller marked delivery on deal #${deal.id}.`, {
        excludeId: ctx.from.id,
      });
      await ctx.reply(detailText(deal), { parse_mode: 'HTML', ...activeDealKeyboard(deal) });
    } catch (err) {
      await ctx.answerCbQuery(err.message, { show_alert: true });
    }
  });

  bot.action(/^deal:payment:(.+)$/, async (ctx) => {
    try {
      const deal = await dealService.markPayment(ctx.match[1], ctx.from.id);
      await ctx.answerCbQuery('Marked as paid.');
      await notify.notifyDealParticipants(deal, `💰 Buyer marked payment sent on deal #${deal.id}.`, {
        excludeId: ctx.from.id,
      });
      await ctx.reply(detailText(deal), { parse_mode: 'HTML', ...activeDealKeyboard(deal) });
    } catch (err) {
      await ctx.answerCbQuery(err.message, { show_alert: true });
    }
  });

  bot.action(/^deal:complete:(.+)$/, async (ctx) => {
    const dealId = ctx.match[1];
    try {
      const deal = await dealService.completeDeal(dealId, ctx.from.id, { adminOverride: false });
      await ctx.answerCbQuery('Deal completed.');
      await ctx.reply(
        `🏁 <b>DEAL COMPLETED</b>\n━━━━━━━━━━━━━━━━\nDeal ID: #${deal.id}\nEscrower: ${fmtUser(
          ctx.from.id,
          ctx.from.username
        )}\nStatus: ✅ COMPLETED\nCompleted At: ${new Date(deal.completed_at).toUTCString()}\n━━━━━━━━━━━━━━━━`,
        { parse_mode: 'HTML' }
      );
      await notify.notifyDealParticipants(deal, `✅ Deal #${deal.id} has been completed by the escrower.`, {
        excludeId: ctx.from.id,
      });
    } catch (err) {
      if (err.message === 'NOT_AUTHORIZED_ESCROWER') {
        await ctx.answerCbQuery();
        await ctx.reply('❌ You are not authorized to complete this deal.\nOnly the escrower who activated this deal can complete it.');
      } else {
        await ctx.answerCbQuery(err.message, { show_alert: true });
      }
    }
  });
}

module.exports = { register, detailText, isParticipant };
