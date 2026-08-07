const escrowerService = require('../services/escrowerService');
const dealService = require('../services/dealService');
const auditService = require('../services/auditService');
const settingsService = require('../services/settingsService');
const groupAccessService = require('../services/groupAccessService');
const notify = require('../services/notificationService');
const { requireAdmin } = require('../middleware/auth');
const { statusLabel, fmtUser } = require('../utils/format');
const { Markup } = require('telegraf');

function parseUserRef(text) {
  if (/^\d+$/.test(text)) return { id: Number(text), username: null };
  if (text.startsWith('@')) return { id: null, username: text.slice(1) };
  return null;
}

function register(bot) {
  // --- Escrower management ---

  bot.command('addescrower', requireAdmin, async (ctx) => {
    const [, idStr, usernameArg, limitArg] = ctx.message.text.split(' ');
    if (!idStr || !/^\d+$/.test(idStr)) {
      return ctx.reply('Usage: /addescrower <telegram_id> [username] [max_limit]');
    }
    const escrower = await escrowerService.addEscrower(
      Number(idStr),
      usernameArg ? usernameArg.replace('@', '') : null,
      null,
      limitArg ? Number(limitArg) : 1000
    );
    await auditService.logAdminAction(ctx.from.id, 'ESCROWER_ASSIGNED', null, { escrowerId: idStr });
    await ctx.reply(`✅ Escrower added: ${fmtUser(escrower.telegram_id, escrower.username)} (limit ${escrower.max_deal_limit})`);
    await notify.safeSend(escrower.telegram_id, '🎉 You have been added as an official ESCORW escrower.');
  });

  bot.command('removeescrower', requireAdmin, async (ctx) => {
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Usage: /removeescrower <telegram_id>');
    const escrower = await escrowerService.removeEscrower(Number(id));
    if (!escrower) return ctx.reply('Escrower not found.');
    await auditService.logAdminAction(ctx.from.id, 'ESCROWER_REMOVED', null, { escrowerId: id });
    await ctx.reply(`🚫 Escrower ${id} set to INACTIVE.`);
  });

  bot.command('escrowerinfo', requireAdmin, async (ctx) => {
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Usage: /escrowerinfo <telegram_id>');
    const e = await escrowerService.getEscrower(Number(id));
    if (!e) return ctx.reply('Escrower not found.');
    await ctx.reply(
      `👤 ${fmtUser(e.telegram_id, e.username)}\nStatus: ${e.status}\nLimit: ${e.max_deal_limit}\n` +
        `Completed: ${e.completed_deals}\nDisputes: ${e.disputes_handled}\nJoined: ${new Date(e.joined_at).toUTCString()}`
    );
  });

  bot.command('setlimit', requireAdmin, async (ctx) => {
    const [, id, limit] = ctx.message.text.split(' ');
    if (!id || !limit) return ctx.reply('Usage: /setlimit <telegram_id> <amount>');
    const e = await escrowerService.setLimit(Number(id), Number(limit));
    if (!e) return ctx.reply('Escrower not found.');
    await auditService.logAdminAction(ctx.from.id, 'SET_LIMIT', null, { escrowerId: id, limit });
    await ctx.reply(`✅ Limit for ${id} set to ${limit}.`);
  });

  bot.command('suspend', requireAdmin, async (ctx) => {
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Usage: /suspend <telegram_id>');
    const e = await escrowerService.suspendEscrower(Number(id));
    if (!e) return ctx.reply('Escrower not found.');
    await auditService.logAdminAction(ctx.from.id, 'ESCROWER_SUSPENDED', null, { escrowerId: id });
    await ctx.reply(`⛔ Escrower ${id} SUSPENDED.`);
  });

  bot.command('unsuspend', requireAdmin, async (ctx) => {
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Usage: /unsuspend <telegram_id>');
    const e = await escrowerService.unsuspendEscrower(Number(id));
    if (!e) return ctx.reply('Escrower not found.');
    await auditService.logAdminAction(ctx.from.id, 'ESCROWER_UNSUSPENDED', null, { escrowerId: id });
    await ctx.reply(`✅ Escrower ${id} reactivated.`);
  });

  // --- Deal oversight ---

  bot.command('activedeals', requireAdmin, async (ctx) => {
    const deals = await dealService.listActiveDeals();
    if (!deals.length) return ctx.reply('No active deals.');
    const lines = deals.map((d) => `#${d.id} — ${statusLabel(d.status)} — ${d.amount} ${d.currency}`);
    await ctx.reply(lines.join('\n'));
  });

  bot.command('finddeal', requireAdmin, async (ctx) => {
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Usage: /finddeal <deal_id>');
    const deal = await dealService.getDeal(id.replace(/^#/, ''));
    if (!deal) return ctx.reply('Deal not found.');
    await ctx.reply(JSON.stringify(deal, null, 2).slice(0, 3500));
  });

  bot.command('reassign', requireAdmin, async (ctx) => {
    const [, dealId, newEscrowerId] = ctx.message.text.split(' ');
    if (!dealId || !newEscrowerId) return ctx.reply('Usage: /reassign <deal_id> <new_escrower_telegram_id>');
    const escrower = await escrowerService.getEscrower(Number(newEscrowerId));
    if (!escrower || escrower.status !== 'ACTIVE') return ctx.reply('That user is not an active escrower.');
    const deal = await dealService.reassignEscrower(dealId, Number(newEscrowerId), ctx.from.id);
    await auditService.logAdminAction(ctx.from.id, 'ADMIN_OVERRIDE', dealId, { action: 'reassign', newEscrowerId });
    await ctx.reply(`✅ Deal #${dealId} reassigned to ${fmtUser(newEscrowerId)}.`);
    await notify.safeSend(Number(newEscrowerId), `You have been assigned as escrower on deal #${dealId}.`);
  });

  bot.command('override', requireAdmin, async (ctx) => {
    // /override <deal_id> COMPLETE|CANCEL  -- requires CONFIRM as a 3rd arg
    const [, dealId, action, confirm] = ctx.message.text.split(' ');
    if (!dealId || !action) return ctx.reply('Usage: /override <deal_id> COMPLETE|CANCEL CONFIRM');
    if (confirm !== 'CONFIRM') {
      return ctx.reply(`⚠️ Destructive action. Re-send as:\n/override ${dealId} ${action.toUpperCase()} CONFIRM`);
    }
    try {
      let deal;
      if (action.toUpperCase() === 'COMPLETE') {
        deal = await dealService.completeDeal(dealId, ctx.from.id, { adminOverride: true });
      } else if (action.toUpperCase() === 'CANCEL') {
        deal = await dealService.cancelDeal(dealId, ctx.from.id, 'admin override', { admin: true });
      } else {
        return ctx.reply('Action must be COMPLETE or CANCEL.');
      }
      await auditService.logAdminAction(ctx.from.id, 'ADMIN_OVERRIDE', dealId, { action });
      await ctx.reply(`✅ Admin override applied: deal #${dealId} → ${statusLabel(deal.status)}`);
      await notify.notifyDealParticipants(deal, `⚠️ An admin override was applied to deal #${dealId} (${action}).`, {
        excludeId: ctx.from.id,
      });
    } catch (err) {
      await ctx.reply(`⚠️ ${err.message}`);
    }
  });

  // --- Stats & audit ---

  bot.command('stats', requireAdmin, async (ctx) => {
    const active = await dealService.listActiveDeals(1000);
    const escrowers = await escrowerService.listEscrowers();
    const counts = active.reduce((acc, d) => {
      acc[d.status] = (acc[d.status] || 0) + 1;
      return acc;
    }, {});
    await ctx.reply(
      `📊 Stats\n\n` +
        Object.entries(counts).map(([k, v]) => `${statusLabel(k)}: ${v}`).join('\n') +
        `\n\nEscrowers: ${escrowers.length} (active: ${escrowers.filter((e) => e.status === 'ACTIVE').length})`
    );
  });

  bot.command('auditlog', requireAdmin, async (ctx) => {
    const actions = await auditService.getAdminActions(20);
    if (!actions.length) return ctx.reply('No admin actions logged yet.');
    const lines = actions.map(
      (a) => `${new Date(a.created_at).toISOString()} — ${a.action} by ${a.admin_telegram_id}${a.deal_id ? ' on #' + a.deal_id : ''}`
    );
    await ctx.reply(lines.join('\n'));
  });

  // --- Settings ---

  bot.command('setfee', requireAdmin, async (ctx) => {
    const pct = ctx.message.text.split(' ')[1];
    if (pct === undefined || Number.isNaN(Number(pct))) return ctx.reply('Usage: /setfee <percent>');
    await settingsService.set('fee_percent', Number(pct));
    await auditService.logAdminAction(ctx.from.id, 'SET_FEE', null, { percent: pct });
    await ctx.reply(`💰 Escrow fee updated to ${pct}%.`);
  });

  bot.command('settimeout', requireAdmin, async (ctx) => {
    const hours = ctx.message.text.split(' ')[1];
    if (hours === undefined || Number.isNaN(Number(hours))) return ctx.reply('Usage: /settimeout <hours>');
    await settingsService.set('inactivity_timeout_hours', Number(hours));
    await auditService.logAdminAction(ctx.from.id, 'SET_TIMEOUT', null, { hours });
    await ctx.reply(`⏰ Inactivity timeout updated to ${hours}h.`);
  });

  bot.command('broadcast', requireAdmin, async (ctx) => {
    const text = ctx.message.text.replace(/^\/broadcast(@\w+)?\s*/, '');
    if (!text) return ctx.reply('Usage: /broadcast <message>');
    const { pool } = require('../database/db');
    const { rows } = await pool.query('SELECT telegram_id FROM users');
    let sent = 0;
    for (const row of rows) {
      await notify.safeSend(row.telegram_id, `📢 ${text}`);
      sent += 1;
    }
    await auditService.logAdminAction(ctx.from.id, 'BROADCAST', null, { recipients: sent });
    await ctx.reply(`📢 Broadcast sent to ${sent} users.`);
  });

  // --- Group allowlist (only approved groups can use the bot) ---

  bot.command('allowgroup', requireAdmin, async (ctx) => {
    const arg = ctx.message.text.split(' ')[1];
    let chatId;
    let title = null;

    if (ctx.chat.type !== 'private') {
      // Run directly inside the group being approved.
      chatId = ctx.chat.id;
      title = ctx.chat.title || null;
    } else if (arg && /^-?\d+$/.test(arg)) {
      // Run from DM with an explicit chat id.
      chatId = Number(arg);
    } else {
      return ctx.reply('Usage:\n• Run /allowgroup inside the group to approve it, or\n• From DM: /allowgroup <group_chat_id>');
    }

    await groupAccessService.allowGroup(chatId, title, ctx.from.id);
    await auditService.logAdminAction(ctx.from.id, 'GROUP_ALLOWED', null, { chatId });
    await ctx.reply(`✅ This group is now approved to use the bot.\nChat ID: ${chatId}`);
  });

  bot.command('disallowgroup', requireAdmin, async (ctx) => {
    const arg = ctx.message.text.split(' ')[1];
    let chatId;

    if (ctx.chat.type !== 'private') {
      chatId = ctx.chat.id;
    } else if (arg && /^-?\d+$/.test(arg)) {
      chatId = Number(arg);
    } else {
      return ctx.reply('Usage:\n• Run /disallowgroup inside the group to revoke it, or\n• From DM: /disallowgroup <group_chat_id>');
    }

    const result = await groupAccessService.disallowGroup(chatId);
    if (!result) return ctx.reply('That group was never approved.');
    await auditService.logAdminAction(ctx.from.id, 'GROUP_REVOKED', null, { chatId });
    await ctx.reply(`🚫 Access revoked for chat ID: ${chatId}`);
  });

  bot.command('listgroups', requireAdmin, async (ctx) => {
    const groups = await groupAccessService.listAllowed();
    if (!groups.length) return ctx.reply('No groups are currently approved.');
    const lines = groups.map(
      (g) => `• ${g.title || '(untitled)'} — ${g.chat_id} — added ${new Date(g.added_at).toUTCString()}`
    );
    await ctx.reply(`✅ Approved groups (${groups.length}):\n${lines.join('\n')}`);
  });

  bot.command('groupstatus', requireAdmin, async (ctx) => {
    const arg = ctx.message.text.split(' ')[1];
    const chatId = ctx.chat.type !== 'private' ? ctx.chat.id : arg && Number(arg);
    if (!chatId) return ctx.reply('Usage: /groupstatus (in group) or /groupstatus <chat_id> (in DM)');
    const g = await groupAccessService.getGroup(chatId);
    if (!g) return ctx.reply(`Chat ID ${chatId} has never been approved.`);
    await ctx.reply(`Chat ID: ${g.chat_id}\nTitle: ${g.title || '(untitled)'}\nStatus: ${g.status}\nAdded: ${new Date(g.added_at).toUTCString()}`);
  });
}

module.exports = { register };
