const cron = require('node-cron');
const db = require('../database/db');
const notify = require('../services/notificationService');
const env = require('../config/env');
const { escapeHtml } = require('../utils/format');

/**
 * Deadline-based deal alerts for group_deals.
 *
 * A forwarded deal with a deadline gets:
 *   1st warning  → when current time >= deadline
 *   2nd warning  → at deadline + 50% of original ETA
 *   Auto-reverse → at deadline + 100% of original ETA (i.e. 2nd warning + 50% of ETA)
 *
 * Example: ETA = 1 hour
 *   Deal starts at 12:00, deadline = 13:00
 *   1st warning at 13:00 (deadline crossed)
 *   2nd warning at 13:30 (50% of 1h = 30min after 1st warning)
 *   Auto-reverse at 14:00 (50% of 1h = 30min after 2nd warning)
 */

async function processDealAlerts() {
  const now = new Date();

  // Only process deals that are forwarded and have a deadline
  const { rows: deals } = await db.query(
    `SELECT * FROM group_deals
     WHERE status = 'FORWARDED'
       AND deadline_at IS NOT NULL
       AND status_after_payment = 'PAYMENT_CONFIRMED'
       AND expired_after_warnings = false`
  );

  for (const deal of deals) {
    const deadline = new Date(deadline.deadline_at);
    const etaMs = deal.eta_minutes * 60 * 1000;
    const halfEtaMs = etaMs / 2;

    // ─── 1st Warning: deadline crossed ───
    if (!deal.first_warning_sent && now >= deadline) {
      await db.query(`UPDATE group_deals SET first_warning_sent = true WHERE id = $1`, [deal.id]);

      const warnMsg =
        `⏰ <b>DEAL DEADLINE WARNING</b>\n\n` +
        `Deal ${escapeHtml(deal.escrow_id)} has crossed its deadline!\n` +
        `Please complete the deal or take action immediately.\n` +
        `A second and final warning will follow.`;

      // Notify in DM
      if (deal.buyer_id) await notify.safeSend(deal.buyer_id, warnMsg, { parse_mode: 'HTML' });
      if (deal.seller_id) await notify.safeSend(deal.seller_id, warnMsg, { parse_mode: 'HTML' });

      // Notify in group
      try {
        const { pool } = require('../database/db');
        await env._bot?.telegram?.sendMessage(
          deal.chat_id,
          warnMsg + `\n@${escapeHtml(deal.seller_username || '')} @${escapeHtml(deal.buyer_username || '')}`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        console.warn(`Could not post 1st warning to group for deal ${deal.id}:`, err.message);
      }

      // Notify admins
      for (const adminId of env.ADMIN_IDS) {
        await notify.safeSend(adminId, `⏰ 1st WARNING: Deal ${escapeHtml(deal.escrow_id)} deadline crossed.`, { parse_mode: 'HTML' });
      }

      console.log(`Deal ${deal.escrow_id}: 1st warning sent`);
    }

    // ─── 2nd Warning: 50% of ETA after 1st warning ───
    const secondWarningTime = new Date(deadline.getTime() + halfEtaMs);
    const updatedDeal = deal.first_warning_sent
      ? deal
      : (await db.query(`SELECT * FROM group_deals WHERE id = $1`, [deal.id])).rows[0];

    if (updatedDeal && updatedDeal.first_warning_sent && !updatedDeal.second_warning_sent && now >= secondWarningTime) {
      await db.query(`UPDATE group_deals SET second_warning_sent = true WHERE id = $1`, [deal.id]);

      const warnMsg =
        `🔴 <b>FINAL WARNING — DEAL EXPIRY IMMINENT</b>\n\n` +
        `Deal ${escapeHtml(deal.escrow_id)} has still not been completed!\n` +
        `This deal will be <b>automatically REVERSED</b> if not resolved.\n` +
        `Take action NOW.`;

      if (deal.buyer_id) await notify.safeSend(deal.buyer_id, warnMsg, { parse_mode: 'HTML' });
      if (deal.seller_id) await notify.safeSend(deal.seller_id, warnMsg, { parse_mode: 'HTML' });

      try {
        await env._bot?.telegram?.sendMessage(
          deal.chat_id,
          warnMsg + `\n@${escapeHtml(deal.seller_username || '')} @${escapeHtml(deal.buyer_username || '')}`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        console.warn(`Could not post 2nd warning to group for deal ${deal.id}:`, err.message);
      }

      for (const adminId of env.ADMIN_IDS) {
        await notify.safeSend(adminId, `🔴 FINAL WARNING: Deal ${escapeHtml(deal.escrow_id)} will auto-reverse soon.`, { parse_mode: 'HTML' });
      }

      console.log(`Deal ${deal.escrow_id}: 2nd/final warning sent`);
    }

    // ─── Auto-Reverse: 100% of ETA after 1st warning (i.e. 50% after 2nd warning) ───
    const reverseTime = new Date(deadline.getTime() + etaMs);
    const latestDeal = (await db.query(`SELECT * FROM group_deals WHERE id = $1`, [deal.id])).rows[0];

    if (latestDeal && latestDeal.second_warning_sent && !latestDeal.expired_after_warnings && now >= reverseTime) {
      await db.query(
        `UPDATE group_deals
         SET status_after_payment = 'REVERSED',
             reversed_at = now(),
             expired_after_warnings = true
         WHERE id = $1`,
        [deal.id]
      );

      const reverseMsg =
        `🔄 <b>DEAL AUTO-REVERSED</b>\n\n` +
        `Deal ${escapeHtml(deal.escrow_id)} has been automatically reversed due to inactivity after deadline.\n` +
        `Funds should be returned to the buyer.`;

      if (deal.buyer_id) await notify.safeSend(deal.buyer_id, reverseMsg, { parse_mode: 'HTML' });
      if (deal.seller_id) await notify.safeSend(deal.seller_id, reverseMsg, { parse_mode: 'HTML' });

      try {
        await env._bot?.telegram?.sendMessage(
          deal.chat_id,
          reverseMsg + `\n@${escapeHtml(deal.seller_username || '')} @${escapeHtml(deal.buyer_username || '')}`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        console.warn(`Could not post auto-reverse to group for deal ${deal.id}:`, err.message);
      }

      for (const adminId of env.ADMIN_IDS) {
        await notify.safeSend(adminId, `🔄 AUTO-REVERSED: Deal ${escapeHtml(deal.escrow_id)} expired after warnings.`, { parse_mode: 'HTML' });
      }

      console.log(`Deal ${deal.escrow_id}: auto-reversed`);
    }
  }
}

function start() {
  // Run every 1 minute for precise deadline checking
  cron.schedule('* * * * *', () => {
    processDealAlerts().catch((err) => console.error('dealAlertJob failed:', err));
  });
  console.log('dealAlertJob started (every 1 min)');
}

module.exports = { start, processDealAlerts };
