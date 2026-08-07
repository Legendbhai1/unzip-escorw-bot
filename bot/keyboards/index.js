const { Markup } = require('telegraf');

const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback('📝 Create Deal', 'menu:create_deal')],
  [Markup.button.callback('📖 How Escrow Works', 'menu:how_it_works')],
  [Markup.button.callback('📜 Rules', 'menu:rules')],
  [Markup.button.callback('👥 Official Escrowers', 'menu:escrowers')],
  [Markup.button.callback('🆘 Support', 'menu:support')],
]);

const dealTypeKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('NORMAL DEAL', 'form:type:NORMAL')],
  [Markup.button.callback('P2P DEAL', 'form:type:P2P')],
]);

const formPreviewKeyboard = (draftId) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✅ Submit Deal', `form:submit:${draftId}`)],
    [Markup.button.callback('✏️ Edit', `form:edit:${draftId}`)],
    [Markup.button.callback('❌ Cancel', `form:cancel:${draftId}`)],
  ]);

const dealCreatedKeyboard = (dealId) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('👤 View Deal', `deal:view:${dealId}`)],
    [Markup.button.callback('✅ Activate Deal', `deal:activate:${dealId}`)],
    [Markup.button.callback('❌ Cancel Deal', `deal:cancel:${dealId}`)],
  ]);

const activeDealKeyboard = (deal) => {
  const rows = [];
  if (deal.deal_type === 'NORMAL') {
    rows.push([Markup.button.callback('📦 Seller Delivered', `deal:delivered:${deal.id}`)]);
  } else {
    rows.push([Markup.button.callback('💰 Payment Sent', `deal:payment:${deal.id}`)]);
  }
  rows.push([Markup.button.callback('🔓 Request Release', `deal:request_release:${deal.id}`)]);
  rows.push([Markup.button.callback('⚖️ Open Dispute', `deal:dispute:${deal.id}`)]);
  rows.push([Markup.button.callback('📋 Deal Details', `deal:view:${deal.id}`)]);
  return Markup.inlineKeyboard(rows);
};

const releaseRequestKeyboard = (requestId) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Confirm', `release:confirm:${requestId}`),
      Markup.button.callback('❌ Reject', `release:reject:${requestId}`),
    ],
    [Markup.button.callback('⚖️ Dispute', `release:dispute:${requestId}`)],
  ]);

const escrowerCompleteKeyboard = (dealId) =>
  Markup.inlineKeyboard([[Markup.button.callback('🏁 Complete Deal', `deal:complete:${dealId}`)]]);

const confirmCancelKeyboard = (dealId) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('⚠️ Yes, cancel', `deal:cancel_confirm:${dealId}`),
      Markup.button.callback('Back', `deal:view:${dealId}`),
    ],
  ]);

const groupFormAgreeKeyboard = (internalId, { sellerAgreed, buyerAgreed }) => {
  const rows = [];
  if (!sellerAgreed) rows.push([Markup.button.callback('✅ Seller Agree', `gform:agree:${internalId}:seller`)]);
  if (!buyerAgreed) rows.push([Markup.button.callback('✅ Buyer Agree', `gform:agree:${internalId}:buyer`)]);
  return Markup.inlineKeyboard(rows);
};

const groupFormAdminClaimKeyboard = (internalId) =>
  Markup.inlineKeyboard([[Markup.button.callback('🛡️ Accept Deal', `gform:claim:${internalId}`)]]);

const groupFormAdminActionKeyboard = (internalId) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('➡️ Forward Deal', `gform:forward:${internalId}`)],
    [Markup.button.callback('🗑️ Discard Deal', `gform:discard:${internalId}`)],
  ]);

// ─── New deal flow keyboards ───

/** Shown on the forwarded deal form in group — admin taps to confirm payment received */
const paymentReceivedKeyboard = (internalId) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('💰 Payment Received', `gflow:payment_received:${internalId}`)],
  ]);

/**
 * Sent to buyer (role='buyer') or seller (role='seller') in DM.
 * Buyer sees only Release, seller sees only Refund.
 */
const releaseRefundKeyboard = (internalId, role) => {
  if (role === 'buyer') {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🔓 Release Funds', `gflow:release:${internalId}`)],
    ]);
  }
  return Markup.inlineKeyboard([
    [Markup.button.callback('↩️ Refund Deal', `gflow:refund:${internalId}`)],
  ]);
};

/** Final confirmation for release */
const confirmReleaseKeyboard = (internalId) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✅ Confirm Release', `gflow:confirm_release:${internalId}`)],
    [Markup.button.callback('❌ Cancel', `gflow:cancel_action:${internalId}`)],
  ]);

/** Final confirmation for refund */
const confirmRefundKeyboard = (internalId) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('✅ Confirm Refund', `gflow:confirm_refund:${internalId}`)],
    [Markup.button.callback('❌ Cancel', `gflow:cancel_action:${internalId}`)],
  ]);

module.exports = {
  mainMenu,
  dealTypeKeyboard,
  formPreviewKeyboard,
  dealCreatedKeyboard,
  activeDealKeyboard,
  releaseRequestKeyboard,
  escrowerCompleteKeyboard,
  confirmCancelKeyboard,
  groupFormAgreeKeyboard,
  groupFormAdminClaimKeyboard,
  groupFormAdminActionKeyboard,
  // New deal flow keyboards
  paymentReceivedKeyboard,
  releaseRefundKeyboard,
  confirmReleaseKeyboard,
  confirmRefundKeyboard,
};
