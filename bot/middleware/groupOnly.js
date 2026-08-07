const env = require('../config/env');
const userService = require('./auth');

// Callback patterns allowed in private chats (deal flow DM buttons)
const DM_ALLOWED_CALLBACKS = [
  /^gflow:/,          // release/refund confirmation buttons
  /^release:/,        // legacy release confirm/reject
];

// Group-allowlist admin commands must work from DM too (see admin.js).
const ADMIN_DM_COMMANDS = ['/allowgroup', '/disallowgroup', '/listgroups', '/groupstatus'];

/**
 * In private chats: only allow /start + whitelisted callbacks (+ admin allowlist commands).
 * In groups: pass through (gatekeeper is a separate middleware).
 */
async function groupOnly(ctx, next) {
  const chatType = ctx.chat && ctx.chat.type;
  if (chatType === 'private') {
    // Allow whitelisted callback queries in DMs (e.g. deal flow buttons)
    if (ctx.updateType === 'callback_query' && ctx.callbackQuery && ctx.callbackQuery.data) {
      const data = ctx.callbackQuery.data;
      if (DM_ALLOWED_CALLBACKS.some((re) => re.test(data))) {
        return next();
      }
      return ctx.answerCbQuery('This only works inside the group chat.', { show_alert: true }).catch(() => {});
    }
    // Allow /start and /help in DM so users can onboard
    if (ctx.updateType === 'message' && ctx.message && ctx.message.text) {
      const cmd = ctx.message.text.split(/\s+/)[0].toLowerCase().split('@')[0];
      if (cmd === '/start' || cmd === '/help') {
        return next();
      }
      // Admins can manage the group allowlist from DM
      if (ADMIN_DM_COMMANDS.includes(cmd) && ctx.from && env.ADMIN_IDS.includes(Number(ctx.from.id))) {
        return next();
      }
    }
    // Everything else in DM → redirect to group
    return ctx.reply(
      '🛡️ This bot works inside the official escrow group. Use commands there after starting me here.'
    ).catch(() => {});
  }
  return next();
}

module.exports = { groupOnly };
