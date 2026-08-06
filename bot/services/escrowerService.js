const db = require('../database/db');

async function addEscrower(telegramId, username, displayName, maxLimit = 1000) {
  await db.query(
    `INSERT INTO users (telegram_id, username, display_name, role)
     VALUES ($1, $2, $3, 'escrower')
     ON CONFLICT (telegram_id) DO UPDATE SET role = 'escrower', username = EXCLUDED.username`,
    [telegramId, username, displayName]
  );
  const { rows } = await db.query(
    `INSERT INTO escrowers (telegram_id, username, display_name, max_deal_limit)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_id) DO UPDATE
       SET status = 'ACTIVE', username = EXCLUDED.username, max_deal_limit = EXCLUDED.max_deal_limit
     RETURNING *`,
    [telegramId, username, displayName, maxLimit]
  );
  return rows[0];
}

async function removeEscrower(telegramId) {
  const { rows } = await db.query(
    `UPDATE escrowers SET status = 'INACTIVE' WHERE telegram_id = $1 RETURNING *`,
    [telegramId]
  );
  return rows[0];
}

async function suspendEscrower(telegramId) {
  const { rows } = await db.query(
    `UPDATE escrowers SET status = 'SUSPENDED' WHERE telegram_id = $1 RETURNING *`,
    [telegramId]
  );
  return rows[0];
}

async function unsuspendEscrower(telegramId) {
  const { rows } = await db.query(
    `UPDATE escrowers SET status = 'ACTIVE' WHERE telegram_id = $1 RETURNING *`,
    [telegramId]
  );
  return rows[0];
}

async function setLimit(telegramId, limit) {
  const { rows } = await db.query(
    `UPDATE escrowers SET max_deal_limit = $2 WHERE telegram_id = $1 RETURNING *`,
    [telegramId, limit]
  );
  return rows[0];
}

async function getEscrower(telegramId) {
  const { rows } = await db.query(`SELECT * FROM escrowers WHERE telegram_id = $1`, [telegramId]);
  return rows[0] || null;
}

async function listEscrowers({ activeOnly = false } = {}) {
  const { rows } = await db.query(
    activeOnly
      ? `SELECT * FROM escrowers WHERE status = 'ACTIVE' ORDER BY joined_at`
      : `SELECT * FROM escrowers ORDER BY joined_at`
  );
  return rows;
}

async function isAuthorizedEscrower(telegramId) {
  const e = await getEscrower(telegramId);
  return !!e && e.status === 'ACTIVE';
}

async function incrementCompleted(telegramId) {
  await db.query(
    `UPDATE escrowers SET completed_deals = completed_deals + 1 WHERE telegram_id = $1`,
    [telegramId]
  );
}

async function incrementDisputes(telegramId) {
  await db.query(
    `UPDATE escrowers SET disputes_handled = disputes_handled + 1 WHERE telegram_id = $1`,
    [telegramId]
  );
}

module.exports = {
  addEscrower,
  removeEscrower,
  suspendEscrower,
  unsuspendEscrower,
  setLimit,
  getEscrower,
  listEscrowers,
  isAuthorizedEscrower,
  incrementCompleted,
  incrementDisputes,
};
