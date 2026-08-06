/** Escapes user-generated text so it can't break Telegram HTML parse mode. */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function money(amount, currency) {
  return `${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2 })} ${escapeHtml(currency)}`;
}

const STATUS_LABELS = {
  PENDING: '🟡 PENDING',
  ACTIVE: '🟢 ACTIVE',
  RELEASE_REQUESTED: '🔓 RELEASE REQUESTED',
  DISPUTED: '⚖️ DISPUTED',
  RESOLVED_RELEASE: '⚖️ RESOLVED (RELEASE)',
  RESOLVED_REFUND: '⚖️ RESOLVED (REFUND)',
  COMPLETED: '✅ COMPLETED',
  CANCELLED: '❌ CANCELLED',
  EXPIRED: '⏰ EXPIRED',
};

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function fmtUser(telegramId, username) {
  if (username) return `@${escapeHtml(username)}`;
  return `ID:${telegramId}`;
}

module.exports = { escapeHtml, money, statusLabel, fmtUser };
