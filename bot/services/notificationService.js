const { fmtUser, statusLabel, escapeHtml } = require('../utils/format');

let botInstance = null;
function init(bot) {
  botInstance = bot;
}

async function safeSend(telegramId, text, extra = {}) {
  if (!botInstance || !telegramId) return;
  try {
    await botInstance.telegram.sendMessage(telegramId, text, { parse_mode: 'HTML', ...extra });
  } catch (err) {
    // Swallow send failures (e.g. user blocked the bot) — never crash a workflow over a notify.
    console.warn(`notify failed for ${telegramId}:`, err.message);
  }
}

/** Notify only the deal's actual participants (buyer, seller, escrower if set), excluding the actor if desired. */
async function notifyDealParticipants(deal, text, { excludeId = null } = {}) {
  const recipients = new Set([deal.buyer_id, deal.seller_id, deal.escrower_id].filter(Boolean));
  if (excludeId) recipients.delete(Number(excludeId));
  for (const id of recipients) {
    await safeSend(id, text);
  }
}

function dealSummaryHtml(deal) {
  return (
    `🛡️ <b>ESCORW DEAL</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `ID: #${deal.id}\n` +
    `Type: ${deal.deal_type}\n` +
    `Amount: ${deal.amount} ${escapeHtml(deal.currency)}\n` +
    `Status: ${statusLabel(deal.status)}\n` +
    `━━━━━━━━━━━━━━━━`
  );
}

module.exports = { init, safeSend, notifyDealParticipants, dealSummaryHtml };
