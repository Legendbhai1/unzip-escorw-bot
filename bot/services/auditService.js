const db = require('../database/db');

async function logDealEvent(dealId, actorTelegramId, action, metadata = {}, client = db) {
  await client.query(
    `INSERT INTO deal_events (deal_id, actor_telegram_id, action, metadata)
     VALUES ($1, $2, $3, $4)`,
    [dealId, actorTelegramId, action, JSON.stringify(metadata)]
  );
}

async function logAdminAction(adminTelegramId, action, dealId = null, metadata = {}) {
  await db.query(
    `INSERT INTO admin_actions (admin_telegram_id, action, deal_id, metadata)
     VALUES ($1, $2, $3, $4)`,
    [adminTelegramId, action, dealId, JSON.stringify(metadata)]
  );
}

async function getDealEvents(dealId, limit = 50) {
  const { rows } = await db.query(
    `SELECT * FROM deal_events WHERE deal_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [dealId, limit]
  );
  return rows;
}

async function getAdminActions(limit = 50) {
  const { rows } = await db.query(
    `SELECT * FROM admin_actions ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = { logDealEvent, logAdminAction, getDealEvents, getAdminActions };
