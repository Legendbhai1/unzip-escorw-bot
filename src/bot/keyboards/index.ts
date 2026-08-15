import { InlineKeyboard } from "grammy";

// ── Main Menu ─────────────────────────────────────────────────
export const mainMenu = new InlineKeyboard()
  .text("\u{1F91D}  Create Deal", "menu:create_deal")
  .row()
  .text("\u{1F4CB}  My Deals", "menu:my_deals")
  .text("\u{1F4DC}  My Transactions", "menu:history")
  .row()
  .text("\u{1F4D6}  How It Works", "menu:how_it_works")
  .text("\u{1F198}  Support", "menu:support");

// ── Payment Method Selection (only these two methods are supported) ──
export const paymentMethodSelect = new InlineKeyboard()
  .text("\u{1F4B3}  INR / UPI", "form:payment:INR")
  .row()
  .text("\u{1FA99}  USDT (BEP20)", "form:payment:USDT")
  .row()
  .text("\u{274C}  Cancel", "menu:main");

// ── Role Selection ────────────────────────────────────────────
export const roleSelect = new InlineKeyboard()
  .text("\u{1F6D2}  I'm Buying", "form:role:buyer")
  .row()
  .text("\u{1F4BC}  I'm Selling", "form:role:seller")
  .row()
  .text("\u{274C}  Cancel", "menu:main");

// ── Crypto payer selection (USDT deals only) ───────────────────
// The bot only RECORDS who pays — the escrower manually receives and
// verifies the USDT outside the bot.
export const cryptoPayerSelect = new InlineKeyboard()
  .text("\u{1F6D2}  Buyer pays", "form:crypto_payer:BUYER")
  .row()
  .text("\u{1F4BC}  Seller pays", "form:crypto_payer:SELLER")
  .row()
  .text("\u{274C}  Cancel", "menu:main");

// ── Category Selection ────────────────────────────────────────
export const categorySelect = new InlineKeyboard()
  .text("Freelance Services", "form:cat:FREELANCE_SERVICES")
  .row()
  .text("Physical Goods", "form:cat:PHYSICAL_GOODS")
  .row()
  .text("Gift Cards", "form:cat:GIFT_CARDS")
  .row()
  .text("Other Lawful", "form:cat:OTHER_LAWFUL")
  .row()
  .text("\u{274C}  Cancel", "menu:main");

// ── Deal Form Confirmation ────────────────────────────────────
export function formConfirm() {
  return new InlineKeyboard()
    .text("\u{2705}  Confirm & Post", "form:confirm")
    .text("\u{270F}\u{FE0F}  Edit", "form:edit")
    .row()
    .text("\u{274C}  Cancel", "menu:main");
}

// ── Active form handling (user typed /form mid-form) ──────────
export function activeFormOptions() {
  return new InlineKeyboard()
    .text("\u{25B6}\u{FE0F}  Continue", "form:continue")
    .text("\u{1F504}  Restart", "form:restart")
    .row()
    .text("\u{274C}  Cancel", "menu:main");
}

// ── Seller Accept/Reject ───────────────────────────────────────
export function acceptRejectDeal() {
  return new InlineKeyboard()
    .text("\u{2705}  Accept Deal", "deal:accept")
    .text("\u{274C}  Reject", "deal:reject");
}

// ── Deal Status Actions ────────────────────────────────────────
export function dealActions(dealId: string, status: string) {
  const k = new InlineKeyboard();
  if (status === "AWAITING_PAYMENT") {
    k.text("\u{2705}  I've Paid", `deal:paid:${dealId}`)
      .row()
      .text("\u{274C}  Cancel Deal", `deal:cancel:${dealId}`);
  } else if (status === "PAYMENT_REPORTED") {
    k.text("\u{23F3}  Payment Under Verification", `deal:status:${dealId}`);
  } else if (status === "PAYMENT_RECEIVED") {
    // Terminal state for the current flow — the escrower continues delivery
    // and payout manually outside the bot. No further bot actions.
    k.text("\u{2705}  Deal Complete — Continue Manually", `deal:status:${dealId}`);
  } else if (status === "DISPUTED" || status === "UNDER_REVIEW") {
    k.text("\u{1F50D}  Under Review", `deal:status:${dealId}`);
  }
  k.row().text("\u{1F3E0}  Main Menu", "menu:main");
  return k;
}

// ── Transactions / Payment History Menu ───────────────────────
// There is no Deposit/Withdraw — the bot has no custody of funds.
export const historyMenu = new InlineKeyboard()
  .text("\u{1F504}  Refresh", "menu:history")
  .row()
  .text("\u{1F3E0}  Main Menu", "menu:main");

// ── My Deals Tabs ─────────────────────────────────────────────
export const dealTabs = new InlineKeyboard()
  .text("\u{1F7E2}  Active", "deals:active")
  .text("\u{2705}  Completed", "deals:completed")
  .text("\u{1F534}  Disputed", "deals:disputed")
  .row()
  .text("\u{1F3E0}  Main Menu", "menu:main");

// ── Back to Main Menu ──────────────────────────────────────────
export const backToMain = new InlineKeyboard().text("\u{1F3E0}  Main Menu", "menu:main");
