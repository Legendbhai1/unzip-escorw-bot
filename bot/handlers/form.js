const { Scenes } = require('telegraf');
const { dealTypeKeyboard, formPreviewKeyboard } = require('../keyboards');
const { escapeHtml } = require('../utils/format');
const dealService = require('../services/dealService');
const notify = require('../services/notificationService');
const { dealCreatedKeyboard } = require('../keyboards');

const STEPS = [
  { key: 'description', prompt: '📝 Enter a short <b>deal description</b>:' },
  { key: 'amount', prompt: '💰 Enter the <b>deal amount</b> (numbers only):' },
  { key: 'currency', prompt: '🪙 Enter the <b>currency/asset</b> (e.g. USDT):' },
  { key: 'sellerRef', prompt: '👤 Enter the <b>seller</b>\'s @username or numeric Telegram ID:' },
  { key: 'buyerRef', prompt: '👤 Enter the <b>buyer</b>\'s @username or numeric Telegram ID:' },
  // deal type is chosen via buttons, handled separately
  { key: 'deadline', prompt: '⏰ Enter the <b>finish/deadline time</b> (e.g. "2026-08-10 18:00 UTC" or "24h"):' },
  { key: 'releaseCondition', prompt: '🔓 Enter the <b>release condition</b>:' },
  { key: 'refundCondition', prompt: '↩️ Enter the <b>refund condition</b>:' },
  { key: 'notes', prompt: '🗒️ Any <b>additional notes</b>? (send "-" to skip)' },
];

function parseUserRef(text) {
  const t = text.trim();
  if (/^-?\d+$/.test(t)) return { id: Number(t), username: null };
  if (t.startsWith('@')) return { id: null, username: t.slice(1) };
  return null;
}

function parseDeadline(text) {
  const t = text.trim();
  // Accept whole-number time formats (1h, 30m, 2w, 3d) or absolute dates
  const { parseTimeToMinutes } = require('../utils/timeParse');
  const timeResult = parseTimeToMinutes(t);
  if (timeResult.valid) {
    const d = new Date(Date.now() + timeResult.minutes * 60 * 1000);
    return d.toISOString();
  }
  const d = new Date(t);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return null;
}

function previewText(d) {
  return (
    `🛡️ <b>ESCORW DEAL</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `Deal Description: ${escapeHtml(d.description)}\n` +
    `Amount: ${escapeHtml(d.amount)}\n` +
    `Currency: ${escapeHtml(d.currency)}\n` +
    `Deal Type: ${escapeHtml(d.dealType)}\n` +
    `Seller: ${d.sellerRef.username ? '@' + escapeHtml(d.sellerRef.username) : 'ID:' + d.sellerRef.id}\n` +
    `Buyer: ${d.buyerRef.username ? '@' + escapeHtml(d.buyerRef.username) : 'ID:' + d.buyerRef.id}\n` +
    `Finish Time: ${d.deadlineIso ? new Date(d.deadlineIso).toUTCString() : 'not set'}\n` +
    `Release Condition: ${escapeHtml(d.releaseCondition)}\n` +
    `Refund Condition: ${escapeHtml(d.refundCondition)}\n` +
    `Escrow Fee: 0%\n` +
    `━━━━━━━━━━━━━━━━`
  );
}

const wizard = new Scenes.WizardScene(
  'deal-form-wizard',
  // Step 0: intro + description prompt
  async (ctx) => {
    ctx.wizard.state.draft = {};
    await ctx.reply(STEPS[0].prompt, { parse_mode: 'HTML' });
    return ctx.wizard.next();
  },
  // Step 1: capture description -> ask amount
  async (ctx) => stepText(ctx, 'description', 1),
  // Step 2: capture amount -> ask currency
  async (ctx) => {
    const text = ctx.message && ctx.message.text;
    if (!text || Number.isNaN(Number(text))) {
      await ctx.reply('⚠️ Please enter a valid number for the amount.');
      return;
    }
    ctx.wizard.state.draft.amount = Number(text);
    await ctx.reply(STEPS[2].prompt, { parse_mode: 'HTML' });
    return ctx.wizard.next();
  },
  // Step 3: capture currency -> ask seller
  async (ctx) => stepText(ctx, 'currency', 3),
  // Step 4: capture seller -> ask buyer
  async (ctx) => {
    const text = ctx.message && ctx.message.text;
    const ref = text && parseUserRef(text);
    if (!ref) {
      await ctx.reply('⚠️ Send a valid @username or numeric Telegram ID for the seller.');
      return;
    }
    ctx.wizard.state.draft.sellerRef = ref;
    await ctx.reply(STEPS[4].prompt, { parse_mode: 'HTML' });
    return ctx.wizard.next();
  },
  // Step 5: capture buyer -> ask deal type via buttons
  async (ctx) => {
    const text = ctx.message && ctx.message.text;
    const ref = text && parseUserRef(text);
    if (!ref) {
      await ctx.reply('⚠️ Send a valid @username or numeric Telegram ID for the buyer.');
      return;
    }
    ctx.wizard.state.draft.buyerRef = ref;
    await ctx.reply('Select the deal type:', dealTypeKeyboard);
    return ctx.wizard.next();
  },
  // Step 6: capture deal type action -> ask deadline
  async (ctx) => {
    if (!ctx.callbackQuery) {
      await ctx.reply('Please tap NORMAL DEAL or P2P DEAL above.');
      return;
    }
    await ctx.answerCbQuery();
    const type = ctx.callbackQuery.data.split(':')[2];
    ctx.wizard.state.draft.dealType = type;
    await ctx.reply(STEPS[5].prompt, { parse_mode: 'HTML' });
    return ctx.wizard.next();
  },
  // Step 7: capture deadline -> ask release condition
  async (ctx) => {
    const text = ctx.message && ctx.message.text;
    if (!text) return;
    const iso = parseDeadline(text);
    ctx.wizard.state.draft.deadlineIso = iso;
    await ctx.reply(STEPS[6].prompt, { parse_mode: 'HTML' });
    return ctx.wizard.next();
  },
  // Step 8: capture release condition -> ask refund condition
  async (ctx) => stepText(ctx, 'releaseCondition', 8),
  // Step 9: capture refund condition -> ask notes
  async (ctx) => stepText(ctx, 'refundCondition', 9),
  // Step 10: capture notes -> show preview
  async (ctx) => {
    const text = ctx.message && ctx.message.text;
    if (!text) return;
    ctx.wizard.state.draft.notes = text === '-' ? '' : text;
    const draftId = `${ctx.from.id}:${Date.now()}`;
    ctx.wizard.state.draftId = draftId;
    await ctx.reply(previewText(ctx.wizard.state.draft), {
      parse_mode: 'HTML',
      ...formPreviewKeyboard(draftId),
    });
    return ctx.wizard.next();
  },
  // Step 11: handle submit/edit/cancel
  async (ctx) => {
    if (!ctx.callbackQuery) return;
    const [, action] = ctx.callbackQuery.data.split(':');
    await ctx.answerCbQuery();

    if (action === 'cancel') {
      await ctx.reply('❌ Deal form cancelled.');
      return ctx.scene.leave();
    }
    if (action === 'edit') {
      ctx.wizard.selectStep(0);
      await ctx.reply(STEPS[0].prompt, { parse_mode: 'HTML' });
      return;
    }
    if (action === 'submit') {
      const d = ctx.wizard.state.draft;
      // Resolve seller/buyer to numeric IDs where possible. Usernames alone are
      // display-only; real authorization always keys off numeric Telegram IDs
      // captured once those users interact with the bot.
      if (!d.sellerRef.id || !d.buyerRef.id) {
        await ctx.reply(
          '⚠️ Note: for full protection, both buyer and seller should have started this bot at least ' +
            'once so we can bind their numeric Telegram ID. Proceeding with the info provided — an admin ' +
            'can correct participant IDs later if needed.'
        );
      }
      try {
        const deal = await dealService.createDeal(
          {
            description: d.description,
            amount: d.amount,
            currency: d.currency,
            dealType: d.dealType,
            sellerId: d.sellerRef.id || 0,
            buyerId: d.buyerRef.id || 0,
            deadlineIso: d.deadlineIso,
            releaseCondition: d.releaseCondition,
            refundCondition: d.refundCondition,
            notes: d.notes,
          },
          ctx.from.id
        );
        await ctx.reply(
          `🔐 <b>DEAL CREATED</b>\nDeal ID: #${deal.id}\nStatus: 🟡 PENDING`,
          { parse_mode: 'HTML', ...dealCreatedKeyboard(deal.id) }
        );
        if (deal.buyer_id) await notify.safeSend(deal.buyer_id, `You were added as buyer on deal #${deal.id}.`);
        if (deal.seller_id) await notify.safeSend(deal.seller_id, `You were added as seller on deal #${deal.id}.`);
      } catch (err) {
        console.error(err);
        await ctx.reply('⚠️ Could not create the deal. Please try again.');
      }
      return ctx.scene.leave();
    }
  }
);

async function stepText(ctx, field, nextIndex) {
  const text = ctx.message && ctx.message.text;
  if (!text) {
    await ctx.reply('⚠️ Please send a text reply.');
    return;
  }
  ctx.wizard.state.draft[field] = text;
  await ctx.reply(STEPS[nextIndex].prompt, { parse_mode: 'HTML' });
  return ctx.wizard.next();
}

function register(bot, stage) {
  // /form is now handled by groupForm.js as alias for /createdeal.
  // The wizard scene remains registered for backward compatibility but is not
  // triggered by any command. It can be entered programmatically if needed.
}

module.exports = { wizard, register };
