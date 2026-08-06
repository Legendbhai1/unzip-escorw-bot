const PRIVATE_NOTICE =
  '🛡️ This bot only works inside the official escrow group chat — it does not operate in DMs. ' +
  'Please open the group and use the commands there.';

// Callback patterns allowed in private chats (deal flow DM buttons)
const DM_ALLOWED_CALLBACKS = [
  /^gflow:/,          // release/refund confirmation buttons
  /^release:/,        // legacy release confirm/reject
];

/** Blocks most interaction in private chats, but allows specific DM callback patterns. */
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
    return ctx.reply(PRIVATE_NOTICE).catch(() => {});
  }
  return next();
}

module.exports = { groupOnly };
