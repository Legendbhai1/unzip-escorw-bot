const db = require('../database/db');

/** Returns true if this chat is an active, admin-approved group. */
async function isAllowed(chatId) {
  const { rows } = await db.query(
    `SELECT 1 FROM allowed_groups WHERE chat_id = $1 AND status = 'active'`,
    [chatId]
  );
  return rows.length > 0;
}

/** Approves a group (insert or reactivate). */
async function allowGroup(chatId, title, addedBy) {
  const { rows } = await db.query(
    `INSERT INTO allowed_groups (chat_id, title, added_by, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (chat_id)
     DO UPDATE SET status = 'active', title = COALESCE(EXCLUDED.title, allowed_groups.title), added_by = EXCLUDED.added_by
     RETURNING *`,
    [chatId, title || null, addedBy]
  );
  return rows[0];
}

/** Revokes a group's access without deleting the record (keeps history). */
async function disallowGroup(chatId) {
  const { rows } = await db.query(
    `UPDATE allowed_groups SET status = 'revoked' WHERE chat_id = $1 RETURNING *`,
    [chatId]
  );
  return rows[0] || null;
}

async function listAllowed() {
  const { rows } = await db.query(
    `SELECT chat_id, title, added_by, added_at, status FROM allowed_groups WHERE status = 'active' ORDER BY added_at DESC`
  );
  return rows;
}

async function getGroup(chatId) {
  const { rows } = await db.query(`SELECT * FROM allowed_groups WHERE chat_id = $1`, [chatId]);
  return rows[0] || null;
}

module.exports = { isAllowed, allowGroup, disallowGroup, listAllowed, getGroup };
