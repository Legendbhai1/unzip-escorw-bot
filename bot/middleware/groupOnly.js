const env = require('../config/env');
const userService = require('./auth');

// Callback patterns allowed in private chats (deal flow DM buttons)
const DM_ALLOWED_CALLBACKS = [
  /^gflow:/,          // release/refund confirmation buttons
  /^release:/,        // legacy release confirm/reject
];

/**
 * In private chats: only allow /start + whitelisted callbacks.
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
      const cmd = ctx.message.text.split(/\s+/)[0].toLowerCase();
      if (cmd === '/start' || cmd === '/help') {
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
