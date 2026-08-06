const db = require('../database/db');
const env = require('../config/env');

async function upsertUser(ctx) {
  const from = ctx.from;
  if (!from) return null;
  const role = env.ADMIN_IDS.includes(from.id) ? 'admin' : 'user';
  const { rows } = await db.query(
    `INSERT INTO users (telegram_id, username, display_name, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_id) DO UPDATE
       SET username = EXCLUDED.username,
           display_name = EXCLUDED.display_name,
           updated_at = now()
     RETURNING *`,
    [from.id, from.username || null, [from.first_name, from.last_name].filter(Boolean).join(' '), role]
  );
  return rows[0];
}

function isAdmin(telegramId) {
  return env.ADMIN_IDS.includes(Number(telegramId));
}

module.exports = { upsertUser, isAdmin };
