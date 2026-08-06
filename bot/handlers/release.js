const dealService = require('../services/dealService');
const notify = require('../services/notificationService');
const { releaseRequestKeyboard, escrowerCompleteKeyboard } = require('../keyboards');
const { fmtUser } = require('../utils/format');

function register(bot) {
  bot.action(/^deal:request_release:(.+)$/, async (ctx) => {
    const dealId = ctx.match[1];
    try {
      const request = await dealService.requestRelease(dealId, ctx.from.id);
      await ctx.answerCbQuery('Release requested.');
      await ctx.reply(
        `🔓 <b>RELEASE REQUESTED</b>\n\nDeal: #${dealId}\nRequested by: ${fmtUser(
          ctx.from.id,
          ctx.from.username
        )}\nTime: ${new Date(request.requested_at).toUTCString()}`,
        { parse_mode: 'HTML', ...releaseRequestKeyboard(request.id) }
      );
      const deal = await dealService.getDeal(dealId);
      await notify.notifyDealParticipants(
        deal,
        `🔓 Release requested on deal #${dealId} by ${fmtUser(ctx.from.id, ctx.from.username)}.`,
        { excludeId: ctx.from.id }
      );
    } catch (err) {
      await ctx.answerCbQuery(err.message, { show_alert: true });
    }
  });

  bot.action(/^release:confirm:(\d+)$/, async (ctx) => {
    const requestId = Number(ctx.match[1]);
    try {
      const { deal } = await dealService.confirmRelease(requestId, ctx.from.id);
      await ctx.answerCbQuery('Release confirmed.');
      await ctx.reply(
        `✅ Release confirmed on deal #${deal.id}. The assigned escrower can now complete the deal.`
      );
      if (deal.escrower_id) {
        await notify.safeSend(
          deal.escrower_id,
          `✅ Both parties have confirmed release on deal #${deal.id}. You may now complete it.`,
          escrowerCompleteKeyboard(deal.id)
        );
      }
    } catch (err) {
      await ctx.answerCbQuery(err.message, { show_alert: true });
    }
  });

  bot.action(/^release:reject:(\d+)$/, async (ctx) => {
    const requestId = Number(ctx.match[1]);
    try {
      const deal = await dealService.rejectRelease(requestId, ctx.from.id);
      await ctx.answerCbQuery('Release rejected.');
      await ctx.reply(`❌ Release request rejected on deal #${deal.id}. Deal remains ACTIVE.`);
      await notify.notifyDealParticipants(deal, `❌ Release request on deal #${deal.id} was rejected.`, {
        excludeId: ctx.from.id,
      });
    } catch (err) {
      await ctx.answerCbQuery(err.message, { show_alert: true });
    }
  });

  bot.action(/^release:dispute:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('To open a dispute, use the ⚖️ Open Dispute button on the deal details view.');
  });
}

module.exports = { register };
