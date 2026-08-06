const cron = require('node-cron');
const db = require('../database/db');
const auditService = require('../services/auditService');
const notify = require('../services/notificationService');
const settingsService = require('../services/settingsService');

const ELIGIBLE_STATUSES = ['PENDING', 'ACTIVE', 'RELEASE_REQUESTED'];

async function processWarningsAndExpiry() {
  const timeoutHours = await settingsService.getInactivityTimeoutHours();

  // 12h warning
  await warnAt(12, 'warned_12h', timeoutHours);
  // 23h warning (or timeout-1h if a custom timeout is configured)
  const secondWarningHour = timeoutHours > 1 ? timeoutHours - 1 : timeoutHours;
  await warnAt(secondWarningHour, 'warned_23h', timeoutHours);

  // Expire deals past the timeout, excluding disputed/completed/cancelled/paused.
  const { rows: expiring } = await db.query(
    `SELECT * FROM deals
     WHERE status = ANY($1)
       AND timer_paused = false
       AND last_activity_at < now() - ($2 || ' hours')::interval
     `,
    [ELIGIBLE_STATUSES, timeoutHours]
  );

  for (const deal of expiring) {
    await db.withTransaction(async (client) => {
      await client.query(`UPDATE deals SET status = 'EXPIRED', cancelled_at = now() WHERE id = $1`, [deal.id]);
      await auditService.logDealEvent(deal.id, 0, 'DEAL_CANCELLED', { reason: 'auto-expired' }, client);
    });
    await notify.notifyDealParticipants(deal, `⏰ Deal #${deal.id} was automatically expired after ${timeoutHours}h of inactivity.`);
  }
}

async function warnAt(hours, flagColumn, timeoutHours) {
  if (hours >= timeoutHours) return; // don't warn at/after the expiry point itself
  const { rows } = await db.query(
    `SELECT * FROM deals
     WHERE status = ANY($1)
       AND timer_paused = false
       AND ${flagColumn} = false
       AND last_activity_at < now() - ($2 || ' hours')::interval`,
    [ELIGIBLE_STATUSES, hours]
  );
  for (const deal of rows) {
    await db.query(`UPDATE deals SET ${flagColumn} = true WHERE id = $1`, [deal.id]);
    const remaining = timeoutHours - hours;
    await notify.notifyDealParticipants(
      deal,
      `⏰ Deal #${deal.id} has had no required activity for ${hours}h. It will auto-cancel in ~${remaining}h without action.`
    );
  }
}

function start() {
  // Runs every 15 minutes.
  cron.schedule('*/15 * * * *', () => {
    processWarningsAndExpiry().catch((err) => console.error('autoCancel job failed:', err));
  });
  console.log('autoCancel scheduler started (every 15 min)');
}

module.exports = { start, processWarningsAndExpiry };
