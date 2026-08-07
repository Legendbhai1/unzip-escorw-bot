const escrowerService = require('../services/escrowerService');
const { fmtUser } = require('../utils/format');

function register(bot) {
  bot.command('escrowers', async (ctx) => {
    const list = await escrowerService.listEscrowers({ activeOnly: true });
    if (!list.length) return ctx.reply('No official escrowers are currently listed.');
    const lines = list.map(
      (e) => `• ${fmtUser(e.telegram_id, e.username)} — limit: ${Number(e.max_deal_limit).toLocaleString()} — completed: ${e.completed_deals}`
    );
    await ctx.reply(`👥 Official Escrowers\n\n${lines.join('\n')}`);
  });

  bot.command('escrower', async (ctx) => {
    const arg = ctx.message.text.split(' ')[1];
    if (!arg) return ctx.reply('Usage: /escrower <username or numeric ID>');
    let escrower = null;
    if (/^\d+$/.test(arg)) {
      escrower = await escrowerService.getEscrower(Number(arg));
    } else {
      const list = await escrowerService.listEscrowers();
      escrower = list.find((e) => e.username && e.username.toLowerCase() === arg.replace('@', '').toLowerCase());
    }
    if (!escrower) return ctx.reply('Escrower not found.');
    await ctx.reply(
      `👤 ${fmtUser(escrower.telegram_id, escrower.username)}\n` +
        `Status: ${escrower.status}\n` +
        `Max limit: ${Number(escrower.max_deal_limit).toLocaleString()}\n` +
        `Completed deals: ${escrower.completed_deals}\n` +
        `Disputes handled: ${escrower.disputes_handled}\n` +
        `Joined: ${new Date(escrower.joined_at).toUTCString()}`
    );
  });
}

module.exports = { register };
