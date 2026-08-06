/**
 * /filter, /filters, /delfilter — MissRose-style chat filters.
 * Admin only. When an admin uses /filter while replying to a message
 * (swipe-left to reply), the bot tags both deal users along with the
 * filter response.
 */
const filterService = require('../services/filterService');
const { requireAdmin } = require('../middleware/auth');
const groupDealService = require('../services/groupDealService');
const { escapeHtml } = require('../utils/format');

/** Parse: /filter <word> <response text> */
function parseFilterArgs(text) {
  // Remove /filter or /filters command prefix
  const cleaned = text.replace(/^\/filter(s)?(@\w+)?\s*/i, '');
  const spaceIdx = cleaned.indexOf(' ');
  if (spaceIdx === -1) return null;
  return {
    word: cleaned.slice(0, spaceIdx).trim(),
    response: cleaned.slice(spaceIdx + 1).trim(),
  };
}

function register(bot) {
  // /filter <word> <response> — set a filter (admin only)
  bot.command('filter', requireAdmin, async (ctx) => {
    const args = parseFilterArgs(ctx.message.text);
    if (!args || !args.word || !args.response) {
      return ctx.reply(
        'Usage: /filter <word> <bot response>\n' +
        'Example: /filter scam ⚠️ This user is flagged.\n' +
        'Reply to a deal message to tag both users automatically.'
      );
    }

    await filterService.setFilter(ctx.chat.id, args.word, args.response, ctx.from.id);

    // If admin is replying to a message (swipe-left / reply-to), try to tag deal users
    const replyMsg = ctx.message.reply_to_message;
    let tagLine = '';
    if (replyMsg) {
      // Try to find if the replied message is a group deal form
      const repliedText = replyMsg.text || replyMsg.caption || '';
      const escrowMatch = repliedText.match(/ESC-[A-Z0-9]{6}/);
      if (escrowMatch) {
        const deal = await groupDealService.getByEscrowId(escrowMatch[0]);
        if (deal) {
          const tags = [];
          if (deal.seller_username) tags.push(`@${escapeHtml(deal.seller_username)}`);
          if (deal.buyer_username) tags.push(`@${escapeHtml(deal.buyer_username)}`);
          if (tags.length) tagLine = `\n${tags.join(' ')}`;
        }
      }
    }

    await ctx.reply(`✅ Filter set: "${escapeHtml(args.word)}" → ${escapeHtml(args.response)}${tagLine}`);
  });

  // /filters — list all filters in this chat (admin only)
  bot.command('filters', requireAdmin, async (ctx) => {
    const filters = await filterService.listFilters(ctx.chat.id);
    if (!filters.length) {
      return ctx.reply('No filters set in this chat.\nUse /filter <word> <response> to add one.');
    }
    const lines = filters.map((f) => `• <code>${escapeHtml(f.trigger_word)}</code> → ${escapeHtml(f.bot_response)}`);
    await ctx.reply(`🔧 <b>Active Filters</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });

  // /delfilter <word> — remove a filter (admin only)
  bot.command('delfilter', requireAdmin, async (ctx) => {
    const word = ctx.message.text.replace(/^\/delfilter(@\w+)?\s*/i, '').trim().toLowerCase();
    if (!word) {
      return ctx.reply('Usage: /delfilter <word>');
    }
    const removed = await filterService.deleteFilter(ctx.chat.id, word);
    if (!removed) {
      return ctx.reply(`⚠️ Filter "${escapeHtml(word)}" not found.`);
    }
    await ctx.reply(`🗑️ Filter "${escapeHtml(word)}" removed.`);
  });
}

module.exports = { register };
