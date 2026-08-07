const db = require('../database/db');

/** Add or update a trigger word for a chat. */
async function setFilter(chatId, triggerWord, botResponse, adminId) {
  const { rows } = await db.query(
    `INSERT INTO chat_filters (chat_id, trigger_word, bot_response, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chat_id, trigger_word)
       DO UPDATE SET bot_response = EXCLUDED.bot_response, created_by = EXCLUDED.created_by
     RETURNING *`,
    [chatId, triggerWord.toLowerCase().trim(), botResponse, adminId]
  );
  return rows[0];
}

/** Remove a trigger word for a chat. */
async function deleteFilter(chatId, triggerWord) {
  const { rows } = await db.query(
    `DELETE FROM chat_filters WHERE chat_id = $1 AND trigger_word = $2 RETURNING *`,
    [chatId, triggerWord.toLowerCase().trim()]
  );
  return rows[0] || null;
}

/** Get the response for a trigger word in a chat. */
async function getFilter(chatId, triggerWord) {
  const { rows } = await db.query(
    `SELECT * FROM chat_filters WHERE chat_id = $1 AND trigger_word = $2`,
    [chatId, triggerWord.toLowerCase().trim()]
  );
  return rows[0] || null;
}

/** List all filters for a chat. */
async function listFilters(chatId) {
  const { rows } = await db.query(
    `SELECT * FROM chat_filters WHERE chat_id = $1 ORDER BY trigger_word`,
    [chatId]
  );
  return rows;
}

/** Check if any word in the message text triggers a filter. Returns the first match or null. */
async function matchFilter(chatId, text) {
  if (!text) return null;
  const words = text.toLowerCase().split(/\s+/);
  for (const word of words) {
    const filter = await getFilter(chatId, word);
    if (filter) return filter;
  }
  return null;
}

module.exports = { setFilter, deleteFilter, getFilter, listFilters, matchFilter };
