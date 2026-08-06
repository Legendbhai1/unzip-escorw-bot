const db = require('../database/db');

async function get(key, fallback = null) {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = $1`, [key]);
  return rows[0] ? rows[0].value : fallback;
}

async function set(key, value) {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}

async function getFeePercent() {
  return Number(await get('fee_percent', '0'));
}

async function getInactivityTimeoutHours() {
  return Number(await get('inactivity_timeout_hours', '24'));
}

module.exports = { get, set, getFeePercent, getInactivityTimeoutHours };
