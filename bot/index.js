const { Telegraf, Scenes, session } = require('telegraf');
const http = require('http');
const env = require('./config/env');
const authMw = require('./middleware/auth');
const { groupOnly } = require('./middleware/groupOnly');
const idempotency = require('./middleware/idempotency');
const notify = require('./services/notificationService');
const botInfo = require('./state/botInfo');
const { registerAll: registerCommands } = require('./services/registerCommands');
const filterService = require('./services/filterService');

const startHandler = require('./handlers/start');
const formHandler = require('./handlers/form');
const dealHandler = require('./handlers/deal');
const releaseHandler = require('./handlers/release');
const disputeHandler = require('./handlers/dispute');
const escrowerHandler = require('./handlers/escrower');
const adminHandler = require('./handlers/admin');
const groupFormHandler = require('./handlers/groupForm');
const filterHandler = require('./handlers/filterHandler');
const dealFlowHandler = require('./handlers/dealFlowHandler');
const autoCancelJob = require('./jobs/autoCancel');
const dealAlertJob = require('./jobs/dealAlertJob');

const bot = new Telegraf(env.BOT_TOKEN);
notify.init(bot);

// Store bot reference for dealAlertJob group notifications
env._bot = bot;

const stage = new Scenes.Stage([formHandler.wizard]);

bot.use(groupOnly);
bot.use(session());
bot.use(authMw.identify);
bot.use(idempotency.dedupeCallback);
bot.use(stage.middleware());

// Register handlers (order matters — groupForm's text listener must be last)
startHandler.register(bot);
formHandler.register(bot, stage);
dealHandler.register(bot);
releaseHandler.register(bot);
disputeHandler.register(bot);
escrowerHandler.register(bot);
adminHandler.register(bot);
groupFormHandler.register(bot);
filterHandler.register(bot);
dealFlowHandler.register(bot);

// ─── Auto-reply filter middleware (runs after all command/action handlers) ───
// Checks if any word in the message matches a configured filter for this chat.
bot.on('text', async (ctx, next) => {
  // Only trigger on group messages, skip commands
  if (!ctx.chat || ctx.chat.type === 'private') return next();
  const text = ctx.message.text;
  if (!text || text.startsWith('/')) return next();

  try {
    const matched = await filterService.matchFilter(ctx.chat.id, text);
    if (matched) {
      // If admin is replying to a message, tag deal users
      let tagLine = '';
      const replyMsg = ctx.message.reply_to_message;
      if (replyMsg) {
        const repliedText = replyMsg.text || replyMsg.caption || '';
        const escrowMatch = repliedText.match(/ESC-[A-Z0-9]{6}/);
        if (escrowMatch) {
          const groupDealService = require('./services/groupDealService');
          const { escapeHtml } = require('./utils/format');
          const deal = await groupDealService.getByEscrowId(escrowMatch[0]);
          if (deal) {
            const tags = [];
            if (deal.seller_username) tags.push(`@${escapeHtml(deal.seller_username)}`);
            if (deal.buyer_username) tags.push(`@${escapeHtml(deal.buyer_username)}`);
            if (tags.length) tagLine = `\n${tags.join(' ')}`;
          }
        }
      }
      await ctx.reply(matched.bot_response + tagLine);
      return; // Don't pass to next handler
    }
  } catch (err) {
    console.warn('Filter check failed:', err.message);
  }
  return next();
});

bot.catch((err, ctx) => {
  console.error(`Unhandled error for update ${ctx.updateType}:`, err);
  if (ctx.reply) ctx.reply('⚠️ Something went wrong processing that. Please try again.').catch(() => {});
});

// Minimal health-check server for Render's port binding requirement.
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ESCORW bot is running.');
  })
  .listen(env.PORT, () => console.log(`Health check server listening on :${env.PORT}`));

bot.telegram
  .getMe()
  .then((me) => {
    botInfo.set(me.username);
    console.log(`Bot identity resolved: @${me.username}`);
  })
  .catch((err) => console.warn('Could not resolve bot username via getMe():', err.message));

bot.launch().then(() => {
  console.log('ESCORW bot launched (polling mode).');

  // Register slash commands with Telegram API (native menu)
  registerCommands(bot.telegram).catch((err) => {
    console.warn('Command registration failed:', err.message);
  });

  // Start cron jobs
  autoCancelJob.start();
  dealAlertJob.start();
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));