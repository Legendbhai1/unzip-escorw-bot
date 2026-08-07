const { mainMenu } = require('../keyboards');
const env = require('../config/env');
const escrowerService = require('../services/escrowerService');
const userService = require('../services/userService');
const { fmtUser } = require('../utils/format');

const SUPPORT_USER = 'beinglazyyy';

const WELCOME = (
  `🛡️ <b>ESCORW — BY NFT MRKT</b>\n\n` +
  `A structured escrow management system for buyers, sellers and verified escrowers.\n\n` +
  `⚠️ This bot manages deal records and coordination only. It does not guarantee ` +
  `any transaction — always verify deal details and the identity of your escrower ` +
  `before proceeding.`
);

const DM_WELCOME = (
  `🛡️ <b>ESCORW — BY NFT MRKT</b>\n\n` +
  `✅ You are now registered! You can use the bot in the group.\n\n` +
  `⚠️ <b>Important:</b> You must have a Telegram @username set on your profile to participate in deals.\n` +
  `If you don't have one, set it in Telegram Settings → Username before using the escrow.\n\n` +
  `🆘 Support: @${SUPPORT_USER}`
);

const HOW_IT_WORKS = (
  `📖 <b>How Escrow Works</b>\n\n` +
  `<b>NORMAL DEAL</b>\n` +
  `1. Seller delivers the agreed item/service first.\n` +
  `2. Seller requests release.\n` +
  `3. Buyer confirms.\n` +
  `4. The authorized escrower completes the deal.\n\n` +
  `<b>P2P DEAL</b>\n` +
  `1. Buyer completes payment.\n` +
  `2. Buyer requests release.\n` +
  `3. Seller confirms.\n` +
  `4. The authorized escrower completes the deal.\n\n` +
  `A release request never completes a deal by itself — it always requires the ` +
  `counter-party's confirmation and the assigned escrower's authorization.`
);

const RULES = (
  `📜 <b>Rules</b>\n\n` +
  `• Everyone must have a Telegram @username to participate in deals.\n` +
  `• Only deal with escrowers listed in 👥 Official Escrowers.\n` +
  `• Never send funds outside the agreed release process.\n` +
  `• All deal actions are logged and auditable.\n` +
  `• Disputes freeze the deal until resolved by the assigned escrower or an admin.\n` +
  `• Deals with no required activity for ${env.INACTIVITY_TIMEOUT_HOURS}h are automatically cancelled.\n` +
  `• This bot cannot guarantee outcomes — always verify who you are dealing with.`
);

async function sendWelcome(ctx) {
  await ctx.reply(WELCOME, { parse_mode: 'HTML', ...mainMenu });
}

function register(bot) {
  // /start in DM: registers the user and allows group access
  bot.start(async (ctx) => {
    const isPrivate = ctx.chat && ctx.chat.type === 'private';

    if (isPrivate) {
      // Upsert user into DB (this is what the gatekeeper checks)
      await userService.upsertUser(ctx);

      // Warn if no username
      if (!ctx.from.username) {
        await ctx.reply(
          `⚠️ <b>No @username detected!</b>\n\n` +
          `You must set a Telegram username before you can participate in deals.\n` +
          `Go to Settings → Username and set one, then /start again.\n\n` +
          `Support: @${SUPPORT_USER}`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      await ctx.reply(DM_WELCOME, { parse_mode: 'HTML' });
      return;
    }

    // In group, show the normal welcome
    await sendWelcome(ctx);
  });

  bot.command('help', sendWelcome);

  bot.action('menu:how_it_works', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(HOW_IT_WORKS, { parse_mode: 'HTML' });
  });

  bot.action('menu:rules', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(RULES, { parse_mode: 'HTML' });
  });

  bot.command('rules', async (ctx) => ctx.reply(RULES, { parse_mode: 'HTML' }));

  bot.action('menu:escrowers', async (ctx) => {
    await ctx.answerCbQuery();
    const escrowers = await escrowerService.listEscrowers({ activeOnly: true });
    if (!escrowers.length) return ctx.reply('No official escrowers are currently listed.');
    const lines = escrowers.map(
      (e) => `• ${fmtUser(e.telegram_id, e.username)} — limit: ${Number(e.max_deal_limit).toLocaleString()} — completed: ${e.completed_deals}`
    );
    await ctx.reply(`👥 <b>Official Escrowers</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });

  bot.action('menu:support', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(`🆘 Support: @${SUPPORT_USER}`);
  });

  bot.command('support', async (ctx) => {
    await ctx.reply(`🆘 Support: @${SUPPORT_USER}`);
  });
}

module.exports = { register, sendWelcome };
