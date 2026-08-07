const db = require('../database/db');
const { generateDealId } = require('../utils/id');

class GroupDealError extends Error {}

function normUsername(u) {
  return u ? u.replace(/^@/, '').trim().toLowerCase() : null;
}

/** Local event log for group_deals — separate from deal_events, which FKs to the older `deals` table. */
async function logEvent(groupDealId, actorTelegramId, action, metadata = {}, client = db) {
  await client.query(
    `INSERT INTO group_deal_events (group_deal_id, actor_telegram_id, action, metadata) VALUES ($1,$2,$3,$4)`,
    [groupDealId, actorTelegramId, action, JSON.stringify(metadata)]
  );
}

async function createDraft(data, createdBy) {
  const { rows } = await db.query(
    `INSERT INTO group_deals
      (chat_id, description, amount, condition, eta, seller_username, buyer_username, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      data.chatId,
      data.description,
      data.amount,
      data.condition,
      data.eta,
      normUsername(data.sellerUsername),
      normUsername(data.buyerUsername),
      createdBy,
    ]
  );
  const deal = rows[0];
  await logEvent(deal.id, createdBy, 'GROUP_FORM_SUBMITTED', {}).catch(() => {});
  return deal;
}

async function getById(internalId) {
  const { rows } = await db.query(`SELECT * FROM group_deals WHERE id = $1`, [internalId]);
  return rows[0] || null;
}

async function getByEscrowId(escrowId) {
  const { rows } = await db.query(`SELECT * FROM group_deals WHERE escrow_id = $1`, [escrowId.toUpperCase()]);
  return rows[0] || null;
}

async function setFormMessage(internalId, chatId, messageId) {
  await db.query(`UPDATE group_deals SET chat_id = $2, form_message_id = $3 WHERE id = $1`, [
    internalId,
    chatId,
    messageId,
  ]);
}

/**
 * Records an agreement tap. Caller must already have verified the tapping
 * user's @username matches the role's username on the form.
 * Returns { deal, bothAgreed }.
 */
async function agree(internalId, role, telegramId) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM group_deals WHERE id = $1 FOR UPDATE`, [internalId]);
    const deal = rows[0];
    if (!deal) throw new GroupDealError('Deal not found.');
    if (deal.status !== 'AWAITING_AGREEMENT') throw new GroupDealError('This deal is no longer awaiting agreement.');

    const col = role === 'seller' ? 'seller_agreed' : 'buyer_agreed';
    const idCol = role === 'seller' ? 'seller_id' : 'buyer_id';
    const atCol = role === 'seller' ? 'seller_agreed_at' : 'buyer_agreed_at';

    if (deal[col]) throw new GroupDealError('ALREADY_AGREED');

    await client.query(
      `UPDATE group_deals SET ${col} = true, ${idCol} = $2, ${atCol} = now() WHERE id = $1`,
      [internalId, telegramId]
    );
    await logEvent(internalId, telegramId, `GROUP_FORM_${role.toUpperCase()}_AGREED`, {}, client);

    const { rows: after } = await client.query(`SELECT * FROM group_deals WHERE id = $1`, [internalId]);
    let deal2 = after[0];
    const bothAgreed = deal2.seller_agreed && deal2.buyer_agreed;

    if (bothAgreed) {
      let escrowId = generateDealId();
      // Extremely unlikely collision guard.
      for (let i = 0; i < 5; i++) {
        const { rows: clash } = await client.query(`SELECT 1 FROM group_deals WHERE escrow_id = $1`, [escrowId]);
        if (!clash.length) break;
        escrowId = generateDealId();
      }
      const { rows: updated } = await client.query(
        `UPDATE group_deals SET status = 'AWAITING_ADMIN', escrow_id = $2 WHERE id = $1 RETURNING *`,
        [internalId, escrowId]
      );
      deal2 = updated[0];
      await logEvent(internalId, telegramId, 'GROUP_FORM_ESCROW_ID_ISSUED', { escrowId }, client);
    }

    return { deal: deal2, bothAgreed };
  });
}

/** First eligible admin to tap "Accept Deal" claims it; only they can forward/discard after. */
async function claim(internalId, adminId) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM group_deals WHERE id = $1 FOR UPDATE`, [internalId]);
    const deal = rows[0];
    if (!deal) throw new GroupDealError('Deal not found.');
    if (deal.status !== 'AWAITING_ADMIN') throw new GroupDealError('Deal is not awaiting admin acceptance.');

    const { rows: updated } = await client.query(
      `UPDATE group_deals SET status = 'CLAIMED', claimed_by = $2, claimed_at = now() WHERE id = $1 RETURNING *`,
      [internalId, adminId]
    );
    await logEvent(internalId, adminId, 'GROUP_FORM_CLAIMED', {}, client);
    return updated[0];
  });
}

function requireClaimant(deal, adminId) {
  if (Number(deal.claimed_by) !== Number(adminId)) {
    throw new GroupDealError('NOT_CLAIMANT');
  }
}

async function forward(internalId, adminId) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM group_deals WHERE id = $1 FOR UPDATE`, [internalId]);
    const deal = rows[0];
    if (!deal) throw new GroupDealError('Deal not found.');
    if (deal.status !== 'CLAIMED') throw new GroupDealError('Deal is not in a claimed state.');
    requireClaimant(deal, adminId);

    const { rows: updated } = await client.query(
      `UPDATE group_deals SET status = 'FORWARDED', resolved_by = $2, resolved_at = now() WHERE id = $1 RETURNING *`,
      [internalId, adminId]
    );
    await logEvent(internalId, adminId, 'GROUP_FORM_FORWARDED', {}, client);
    return updated[0];
  });
}

async function discard(internalId, adminId) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM group_deals WHERE id = $1 FOR UPDATE`, [internalId]);
    const deal = rows[0];
    if (!deal) throw new GroupDealError('Deal not found.');
    if (!['CLAIMED', 'AWAITING_ADMIN'].includes(deal.status)) throw new GroupDealError('Deal cannot be discarded from its current state.');
    if (deal.status === 'CLAIMED') requireClaimant(deal, adminId);

    const { rows: updated } = await client.query(
      `UPDATE group_deals SET status = 'DISCARDED', resolved_by = $2, resolved_at = now() WHERE id = $1 RETURNING *`,
      [internalId, adminId]
    );
    await logEvent(internalId, adminId, 'GROUP_FORM_DISCARDED', {}, client);
    return updated[0];
  });
}

module.exports = {
  GroupDealError,
  createDraft,
  getById,
  getByEscrowId,
  setFormMessage,
  agree,
  claim,
  forward,
  discard,
  normUsername,
};
