/**
 * Gatekeeper: users must /start the bot in DM before they can
 * send messages (or interact) in the group.
 *
 * Why? So the bot has their telegram_id on file and can DM them
 * deal notifications (payment received, release/refund buttons, alerts).
 *
 * Exemptions:
 *   - Admins (ADMIN_IDS)
 *   - Group chat admins / creators
 *   - Callback queries (button taps) — those are DM-routed separately
 *   - The bot's own messages
 */

const env = require('../config/env');

const GATEKEEPER_MSG =
  '🚫 <b>You must start the bot first.</b>\n\n' +
  'DM the bot (@{bot}) and send /start, then come back here.\n' +
  'This is required so the bot can send you deal notifications in DM.';

/** Check if a user has started the bot (exists in `users` table). */
async function hasStarted(telegramId) {
  if (!telegramId) return false;
  const { pool } = require('../database/db');
  const { rows } = await pool.query(
    'SELECT 1 FROM users WHERE telegram_id = $1',
    [telegramId]
  );
  return rows.length > 0;
}

async function requireStarted(ctx, next) {
  // Only enforce in groups / supergroups
  const chatType = ctx.chat && ctx.chat.type;
  if (chatType !== 'supergroup' && chatType !== 'group') return next();

  // Skip callback queries (buttons) — handled by DM whitelist in groupOnly.js
  if (ctx.updateType === 'callback_query') return next();

  // Skip if no sender (e.g. channel posts, anonymous admins)
  if (!ctx.from) return next();

  // Admins are always allowed
  if (env.ADMIN_IDS.includes(Number(ctx.from.id))) return next();

  // Check if user exists in DB (i.e. they /start'd the bot in DM)
  const started = await hasStarted(ctx.from.id);
  if (started) return next();

  // Also allow group admins/creators even if they haven't started
  try {
    const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    if (member && (member.status === 'administrator' || member.status === 'creator')) {
      return next();
    }
  } catch (err) {
    // If we can't check, block to be safe
  }

  const botTag = ctx.me ? ctx.me.username : '';
  await ctx.reply(
    GATEKEEPER_MSG.replace('{bot}', botTag),
    { parse_mode: 'HTML' }
  ).catch(() => {});

  // Delete the user's message so the group stays clean
  try {
    await ctx.deleteMessage().catch(() => {});
  } catch (err) {
    // Ignore — bot might not have delete permission
  }
}

module.exports = { requireStarted, hasStarted };
