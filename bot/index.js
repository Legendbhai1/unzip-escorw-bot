const { Telegraf, Scenes, session } = require('telegraf');
const http = require('http');
const env = require('./config/env');
const authMw = require('./middleware/auth');
const { groupOnly } = require('./middleware/groupOnly');
const idempotency = require('./middleware/idempotency');
const notify = require('./services/notificationService');
const botInfo = require('./state/botInfo');

const startHandler = require('./handlers/start');
const formHandler = require('./handlers/form');
const dealHandler = require('./handlers/deal');
const releaseHandler = require('./handlers/release');
const disputeHandler = require('./handlers/dispute');
const escrowerHandler = require('./handlers/escrower');
const adminHandler = require('./handlers/admin');
const groupFormHandler = require('./handlers/groupForm');
const autoCancelJob = require('./jobs/autoCancel');

const bot = new Telegraf(env.BOT_TOKEN);
notify.init(bot);

const stage = new Scenes.Stage([formHandler.wizard]);

bot.use(groupOnly);
bot.use(session());
bot.use(authMw.identify);
bot.use(idempotency.dedupeCallback);
bot.use(stage.middleware());

startHandler.register(bot);
formHandler.register(bot, stage);
dealHandler.register(bot);
releaseHandler.register(bot);
disputeHandler.register(bot);
escrowerHandler.register(bot);
adminHandler.register(bot);
groupFormHandler.register(bot); // registers a catch-all text listener — keep it last

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
  autoCancelJob.start();
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
