const groupAccessService = require('../services/groupAccessService');

// Commands that must always work, even in an unapproved group,
// so an admin can actually activate the bot there.
const EXEMPT_COMMANDS = ['/allowgroup', '/disallowgroup', '/listgroups', '/groupstatus'];

function isExemptCommand(text) {
  if (!text || !text.startsWith('/')) return false;
  const cmd = text.split(/[\s@]/)[0];
  return EXEMPT_COMMANDS.includes(cmd);
}

/**
 * Blocks all bot activity in group/supergroup chats that haven't been
 * approved by an admin via /allowgroup. Private chats are never affected.
 */
async function groupAccess(ctx, next) {
  const chat = ctx.chat;
  if (!chat || chat.type === 'private') return next();

  const text = ctx.message && ctx.message.text;

  // Admins can always run the allowlist-management commands, even here.
  if (ctx.state.isAdmin && isExemptCommand(text)) return next();

  const allowed = await groupAccessService.isAllowed(chat.id);
  if (allowed) return next();

  // Not approved: stay quiet for ordinary messages to avoid spamming the group,
  // but let a real command attempt know why nothing happened.
  if (text && text.startsWith('/')) {
    await ctx
      .reply('🚫 This group is not approved to use this bot. An admin can enable it with /allowgroup.')
      .catch(() => {});
  }
  // Swallow everything else silently (no next()).
}

module.exports = { groupAccess };
