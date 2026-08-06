const db = require('../database/db');
const { generateDealId } = require('../utils/id');
const audit = require('./auditService');
const escrowerService = require('./escrowerService');
const env = require('../config/env');

class DealError extends Error {}

async function createDeal(data, createdBy) {
  const id = generateDealId();
  const feePercent = env.DEFAULT_FEE_PERCENT;
  const deadline = data.deadlineIso || null;

  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO deals
        (id, deal_type, description, amount, currency, buyer_id, seller_id,
         release_condition, refund_condition, notes, fee_percent, deadline, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        id,
        data.dealType,
        data.description,
        data.amount,
        data.currency,
        data.buyerId,
        data.sellerId,
        data.releaseCondition || null,
        data.refundCondition || null,
        data.notes || null,
        feePercent,
        deadline,
        createdBy,
      ]
    );
    const deal = rows[0];

    await client.query(
      `INSERT INTO deal_participants (deal_id, telegram_id, role) VALUES ($1,$2,'buyer'),($1,$3,'seller')`,
      [id, data.buyerId, data.sellerId]
    );

    await audit.logDealEvent(id, createdBy, 'DEAL_CREATED', { dealType: data.dealType, amount: data.amount }, client);
    return deal;
  });
}

async function getDeal(dealId) {
  const { rows } = await db.query(`SELECT * FROM deals WHERE id = $1`, [dealId]);
  return rows[0] || null;
}

async function listDealsForUser(telegramId, limit = 20) {
  const { rows } = await db.query(
    `SELECT * FROM deals
     WHERE buyer_id = $1 OR seller_id = $1 OR escrower_id = $1 OR created_by = $1
     ORDER BY created_at DESC LIMIT $2`,
    [telegramId, limit]
  );
  return rows;
}

async function listActiveDeals(limit = 50) {
  const { rows } = await db.query(
    `SELECT * FROM deals WHERE status IN ('PENDING','ACTIVE','RELEASE_REQUESTED','DISPUTED') ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

/** Only an authorized, active escrower under their limit may activate a PENDING deal. */
async function activateDeal(dealId, escrowerTelegramId) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM deals WHERE id = $1 FOR UPDATE`, [dealId]);
    const deal = rows[0];
    if (!deal) throw new DealError('Deal not found.');
    if (deal.status !== 'PENDING') throw new DealError('Deal is not pending activation.');

    const escrower = await escrowerService.getEscrower(escrowerTelegramId);
    if (!escrower || escrower.status !== 'ACTIVE') {
      throw new DealError('You are not an authorized active escrower.');
    }
    if (Number(deal.amount) > Number(escrower.max_deal_limit)) {
      const e = new DealError('LIMIT_EXCEEDED');
      e.dealAmount = deal.amount;
      e.escrowerLimit = escrower.max_deal_limit;
      throw e;
    }

    const { rows: updated } = await client.query(
      `UPDATE deals SET status = 'ACTIVE', escrower_id = $2, activated_by_user_id = $2,
        activated_at = now(), last_activity_at = now(), warned_12h=false, warned_23h=false
       WHERE id = $1 RETURNING *`,
      [dealId, escrowerTelegramId]
    );
    await client.query(
      `INSERT INTO deal_participants (deal_id, telegram_id, role) VALUES ($1,$2,'escrower')
       ON CONFLICT DO NOTHING`,
      [dealId, escrowerTelegramId]
    );
    await audit.logDealEvent(dealId, escrowerTelegramId, 'DEAL_ACTIVATED', {}, client);
    return updated[0];
  });
}

async function markDelivered(dealId, actorId) {
  const deal = await requireActive(dealId);
  if (deal.deal_type !== 'NORMAL') throw new DealError('Only NORMAL deals track delivery.');
  if (Number(deal.seller_id) !== Number(actorId)) throw new DealError('Only the seller can mark delivery.');
  await db.query(`UPDATE deals SET delivered = true, last_activity_at = now() WHERE id = $1`, [dealId]);
  await audit.logDealEvent(dealId, actorId, 'DELIVERY_MARKED');
  return getDeal(dealId);
}

async function markPayment(dealId, actorId) {
  const deal = await requireActive(dealId);
  if (deal.deal_type !== 'P2P') throw new DealError('Only P2P deals track payment.');
  if (Number(deal.buyer_id) !== Number(actorId)) throw new DealError('Only the buyer can mark payment.');
  await db.query(`UPDATE deals SET payment_marked = true, last_activity_at = now() WHERE id = $1`, [dealId]);
  await audit.logDealEvent(dealId, actorId, 'PAYMENT_MARKED');
  return getDeal(dealId);
}

async function requireActive(dealId) {
  const deal = await getDeal(dealId);
  if (!deal) throw new DealError('Deal not found.');
  if (deal.status !== 'ACTIVE' && deal.status !== 'RELEASE_REQUESTED') {
    throw new DealError('Deal is not active.');
  }
  return deal;
}

/** The correct counter-party requests release. Never auto-completes. */
async function requestRelease(dealId, requestedBy) {
  const deal = await requireActive(dealId);
  const requesterRole = requesterRoleFor(deal, requestedBy);
  if (!requesterRole) throw new DealError('You are not a participant on this deal.');

  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO release_requests (deal_id, requested_by) VALUES ($1,$2) RETURNING *`,
      [dealId, requestedBy]
    );
    await client.query(
      `UPDATE deals SET status = 'RELEASE_REQUESTED', last_activity_at = now() WHERE id = $1`,
      [dealId]
    );
    await audit.logDealEvent(dealId, requestedBy, 'RELEASE_REQUESTED', {}, client);
    return rows[0];
  });
}

function requesterRoleFor(deal, telegramId) {
  const id = Number(telegramId);
  if (deal.deal_type === 'NORMAL' && Number(deal.seller_id) === id) return 'seller';
  if (deal.deal_type === 'P2P' && Number(deal.buyer_id) === id) return 'buyer';
  return null;
}

function confirmerIdFor(deal) {
  return deal.deal_type === 'NORMAL' ? Number(deal.buyer_id) : Number(deal.seller_id);
}

async function confirmRelease(requestId, confirmedBy) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM release_requests WHERE id = $1 FOR UPDATE`, [requestId]);
    const request = rows[0];
    if (!request || request.status !== 'PENDING') throw new DealError('Release request no longer pending.');
    const deal = (await client.query(`SELECT * FROM deals WHERE id = $1 FOR UPDATE`, [request.deal_id])).rows[0];
    if (confirmerIdFor(deal) !== Number(confirmedBy)) {
      throw new DealError('You are not authorized to confirm this release.');
    }
    await client.query(
      `UPDATE release_requests SET status = 'CONFIRMED', confirmed_by = $2, resolved_at = now() WHERE id = $1`,
      [requestId, confirmedBy]
    );
    await audit.logDealEvent(deal.id, confirmedBy, 'RELEASE_CONFIRMED', {}, client);
    return { request, deal };
  });
}

async function rejectRelease(requestId, rejectedBy) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM release_requests WHERE id = $1 FOR UPDATE`, [requestId]);
    const request = rows[0];
    if (!request || request.status !== 'PENDING') throw new DealError('Release request no longer pending.');
    const deal = (await client.query(`SELECT * FROM deals WHERE id = $1 FOR UPDATE`, [request.deal_id])).rows[0];
    if (confirmerIdFor(deal) !== Number(rejectedBy)) {
      throw new DealError('You are not authorized to reject this release.');
    }
    await client.query(`UPDATE release_requests SET status = 'REJECTED', resolved_at = now() WHERE id = $1`, [requestId]);
    await client.query(`UPDATE deals SET status = 'ACTIVE', last_activity_at = now() WHERE id = $1`, [deal.id]);
    await audit.logDealEvent(deal.id, rejectedBy, 'RELEASE_REJECTED', {}, client);
    return deal;
  });
}

/**
 * Only the escrower who activated the deal may complete it, unless an admin
 * explicitly overrides (adminOverride=true), which is always logged.
 */
async function completeDeal(dealId, actorId, { adminOverride = false } = {}) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM deals WHERE id = $1 FOR UPDATE`, [dealId]);
    const deal = rows[0];
    if (!deal) throw new DealError('Deal not found.');
    if (!['ACTIVE', 'RELEASE_REQUESTED'].includes(deal.status)) {
      throw new DealError('Deal cannot be completed from its current status.');
    }
    if (!adminOverride && Number(deal.activated_by_user_id) !== Number(actorId)) {
      const e = new DealError('NOT_AUTHORIZED_ESCROWER');
      throw e;
    }
    // Require a confirmed release request unless admin override.
    if (!adminOverride) {
      const { rows: reqs } = await client.query(
        `SELECT * FROM release_requests WHERE deal_id = $1 AND status = 'CONFIRMED' ORDER BY resolved_at DESC LIMIT 1`,
        [dealId]
      );
      if (!reqs[0]) throw new DealError('Release must be confirmed by the counter-party before completion.');
    }

    const { rows: updated } = await client.query(
      `UPDATE deals SET status = 'COMPLETED', completed_by_user_id = $2, completed_at = now()
       WHERE id = $1 RETURNING *`,
      [dealId, actorId]
    );
    await audit.logDealEvent(dealId, actorId, 'DEAL_COMPLETED', { adminOverride }, client);
    return updated[0];
  }).then(async (deal) => {
    if (deal.escrower_id) await escrowerService.incrementCompleted(deal.escrower_id);
    return deal;
  });
}

async function cancelDeal(dealId, actorId, reason, { admin = false } = {}) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM deals WHERE id = $1 FOR UPDATE`, [dealId]);
    const deal = rows[0];
    if (!deal) throw new DealError('Deal not found.');
    if (['COMPLETED', 'CANCELLED'].includes(deal.status)) {
      throw new DealError('Deal is already finalized.');
    }
    if (deal.status === 'DISPUTED' && !admin) {
      throw new DealError('Deal is under dispute; only an admin can cancel it.');
    }
    const { rows: updated } = await client.query(
      `UPDATE deals SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1 RETURNING *`,
      [dealId]
    );
    await audit.logDealEvent(dealId, actorId, 'DEAL_CANCELLED', { reason: reason || null, admin }, client);
    return updated[0];
  });
}

async function openDispute(dealId, openedBy, reason) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM deals WHERE id = $1 FOR UPDATE`, [dealId]);
    const deal = rows[0];
    if (!deal) throw new DealError('Deal not found.');
    if (!['ACTIVE', 'RELEASE_REQUESTED'].includes(deal.status)) {
      throw new DealError('Only active deals can be disputed.');
    }
    const { rows: disputeRows } = await client.query(
      `INSERT INTO disputes (deal_id, opened_by, reason) VALUES ($1,$2,$3) RETURNING *`,
      [dealId, openedBy, reason || null]
    );
    await client.query(`UPDATE deals SET status = 'DISPUTED', last_activity_at = now() WHERE id = $1`, [dealId]);
    await audit.logDealEvent(dealId, openedBy, 'DISPUTE_OPENED', { reason }, client);
    return disputeRows[0];
  });
}

async function addDisputeMessage(disputeId, senderId, message) {
  const { rows } = await db.query(
    `INSERT INTO dispute_messages (dispute_id, sender_telegram_id, message) VALUES ($1,$2,$3) RETURNING *`,
    [disputeId, senderId, message]
  );
  return rows[0];
}

async function resolveDispute(disputeId, resolvedBy, resolution) {
  // resolution: 'RESOLVED_RELEASE' | 'RESOLVED_REFUND' | 'CANCELLED'
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM disputes WHERE id = $1 FOR UPDATE`, [disputeId]);
    const dispute = rows[0];
    if (!dispute || dispute.status !== 'DISPUTED') throw new DealError('Dispute already resolved.');

    await client.query(
      `UPDATE disputes SET status = $2, resolved_by = $3, resolved_at = now() WHERE id = $1`,
      [disputeId, resolution, resolvedBy]
    );
    const dealStatus = resolution === 'CANCELLED' ? 'CANCELLED' : resolution;
    await client.query(
      `UPDATE deals SET status = $2, ${resolution === 'CANCELLED' ? 'cancelled_at = now(),' : ''} last_activity_at = now()
       WHERE id = $1`,
      [dispute.deal_id, dealStatus]
    );
    await audit.logDealEvent(dispute.deal_id, resolvedBy, 'DISPUTE_RESOLVED', { resolution }, client);

    const deal = (await client.query(`SELECT * FROM deals WHERE id = $1`, [dispute.deal_id])).rows[0];
    if (deal.escrower_id) await escrowerService.incrementDisputes(deal.escrower_id);
    return { dispute, deal };
  });
}

async function reassignEscrower(dealId, newEscrowerId, adminId) {
  return db.withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT * FROM deals WHERE id = $1 FOR UPDATE`, [dealId]);
    const deal = rows[0];
    if (!deal) throw new DealError('Deal not found.');
    await client.query(
      `UPDATE deals SET escrower_id = $2, activated_by_user_id = $2 WHERE id = $1`,
      [dealId, newEscrowerId]
    );
    await audit.logDealEvent(dealId, adminId, 'ESCROWER_REASSIGNED', { newEscrowerId }, client);
    return getDeal(dealId);
  });
}

module.exports = {
  DealError,
  createDeal,
  getDeal,
  listDealsForUser,
  listActiveDeals,
  activateDeal,
  markDelivered,
  markPayment,
  requestRelease,
  confirmRelease,
  rejectRelease,
  completeDeal,
  cancelDeal,
  openDispute,
  addDisputeMessage,
  resolveDispute,
  reassignEscrower,
};
