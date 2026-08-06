const dealService = require('../services/dealService');
const notify = require('../services/notificationService');
const env = require('../config/env');
const { Markup } = require('telegraf');

function register(bot) {
  bot.action(/^deal:dispute:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.awaitingDisputeReason = ctx.match[1];
    await ctx.reply('⚖️ Please describe the reason for this dispute in one message:');
  });

  // Generic text listener for dispute reasons / evidence messages. Runs after
  // scene middleware so it only fires when no scene has claimed the update.
  bot.on('text', async (ctx, next) => {
    if (ctx.session && ctx.session.awaitingDisputeReason) {
      const dealId = ctx.session.awaitingDisputeReason;
      ctx.session.awaitingDisputeReason = null;
      try {
        const dispute = await dealService.openDispute(dealId, ctx.from.id, ctx.message.text);
        await ctx.reply(`⚖️ Dispute opened on deal #${dealId}. It is now frozen pending resolution.`);
        const deal = await dealService.getDeal(dealId);
        await notify.notifyDealParticipants(deal, `⚖️ A dispute was opened on deal #${dealId}.`, {
          excludeId: ctx.from.id,
        });
        for (const adminId of env.ADMIN_IDS) {
          await notify.safeSend(adminId, `⚖️ Dispute #${dispute.id} opened on deal #${dealId}. Use /disputeinfo ${dispute.id} to review.`);
        }
      } catch (err) {
        await ctx.reply(`⚠️ ${err.message}`);
      }
      return;
    }
    if (ctx.session && ctx.session.awaitingDisputeMessage) {
      const disputeId = ctx.session.awaitingDisputeMessage;
      ctx.session.awaitingDisputeMessage = null;
      await dealService.addDisputeMessage(disputeId, ctx.from.id, ctx.message.text);
      await ctx.reply('📩 Your message was added to the dispute record.');
      return;
    }
    return next();
  });

  bot.command('adddispute', async (ctx) => {
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Usage: /adddispute <dispute_id> then send your message next.');
    ctx.session.awaitingDisputeMessage = Number(id);
    await ctx.reply('Send your evidence/message for this dispute:');
  });

  // Admin resolution: /resolvedispute <id> RELEASE|REFUND|CANCEL
  bot.command('resolvedispute', async (ctx) => {
    if (!ctx.state.isAdmin) return ctx.reply('❌ Admins only.');
    const parts = ctx.message.text.split(' ');
    const disputeId = Number(parts[1]);
    const choice = (parts[2] || '').toUpperCase();
    const map = { RELEASE: 'RESOLVED_RELEASE', REFUND: 'RESOLVED_REFUND', CANCEL: 'CANCELLED' };
    if (!disputeId || !map[choice]) {
      return ctx.reply('Usage: /resolvedispute <dispute_id> RELEASE|REFUND|CANCEL');
    }
    try {
      const { deal } = await dealService.resolveDispute(disputeId, ctx.from.id, map[choice]);
      await ctx.reply(`⚖️ Dispute #${disputeId} resolved as ${map[choice]}.`);
      await notify.notifyDealParticipants(deal, `⚖️ The dispute on deal #${deal.id} was resolved: ${map[choice]}.`, {
        excludeId: ctx.from.id,
      });
    } catch (err) {
      await ctx.reply(`⚠️ ${err.message}`);
    }
  });
}

module.exports = { register };
