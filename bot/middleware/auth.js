const userService = require('../services/userService');
const escrowerService = require('../services/escrowerService');

/** Attaches ctx.state.isAdmin / ctx.state.isEscrower and upserts the user row. Runs on every update. */
async function identify(ctx, next) {
  const user = await userService.upsertUser(ctx);
  ctx.state.user = user;
  ctx.state.isAdmin = ctx.from ? userService.isAdmin(ctx.from.id) : false;
  return next();
}

function requireAdmin(ctx, next) {
  if (!ctx.state.isAdmin) {
    return ctx.reply('❌ This command is restricted to administrators.');
  }
  return next();
}

async function requireEscrower(ctx, next) {
  if (!ctx.from) return;
  const ok = await escrowerService.isAuthorizedEscrower(ctx.from.id);
  if (!ok && !ctx.state.isAdmin) {
    return ctx.reply('❌ You are not an authorized active escrower.');
  }
  return next();
}

module.exports = { identify, requireAdmin, requireEscrower };
