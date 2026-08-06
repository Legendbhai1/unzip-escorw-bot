const PRIVATE_NOTICE =
  '🛡️ This bot only works inside the official escrow group chat — it does not operate in DMs. ' +
  'Please open the group and use the commands there.';

/** Blocks all interaction in private chats. Group/supergroup (and channel) updates pass through. */
async function groupOnly(ctx, next) {
  const chatType = ctx.chat && ctx.chat.type;
  if (chatType === 'private') {
    if (ctx.updateType === 'callback_query') {
      return ctx.answerCbQuery('This only works inside the group chat.', { show_alert: true }).catch(() => {});
    }
    return ctx.reply(PRIVATE_NOTICE).catch(() => {});
  }
  return next();
}

module.exports = { groupOnly };
