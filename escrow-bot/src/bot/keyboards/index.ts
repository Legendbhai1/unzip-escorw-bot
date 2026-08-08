import { InlineKeyboard } from "grammy";

// ── Main Menu ─────────────────────────────────────────────────
export const mainMenu = new InlineKeyboard()
  .text("\u{1F91D}  Create Deal", "menu:create_deal")
  .row()
  .text("\u{1F4CB}  My Deals", "menu:my_deals")
  .text("\u{1F4B0}  Wallet", "menu:wallet")
  .row()
  .text("\u{1F4D6}  How It Works", "menu:how_it_works")
  .text("\u{1F198}  Support", "menu:support");

// ── Role Selection ────────────────────────────────────────────
export const roleSelect = new InlineKeyboard()
  .text("\u{1F6D2}  I'm Buying", "role:buyer")
  .row()
  .text("\u{1F4BC}  I'm Selling", "role:seller")
  .row()
  .text("\u{274C}  Cancel", "menu:main");

// ── Asset Selection ───────────────────────────────────────────
export const assetSelect = new InlineKeyboard()
  .text("USDT (TRC20)", "asset:USDT_TRC20")
  .text("USDT (BEP20)", "asset:USDT_BEP20")
  .row()
  .text("USDC", "asset:USDC")
  .text("BTC", "asset:BTC")
  .row()
  .text("LTC", "asset:LTC")
  .text("TON", "asset:TON")
  .row()
  .text("\u{274C}  Cancel", "menu:main");

// ── Category Selection ────────────────────────────────────────
export const categorySelect = new InlineKeyboard()
  .text("Freelance Services", "cat:FREELANCE_SERVICES")
  .row()
  .text("Physical Goods", "cat:PHYSICAL_GOODS")
  .row()
  .text("Gift Cards", "cat:GIFT_CARDS")
  .row()
  .text("Other Lawful", "cat:OTHER_LAWFUL")
  .row()
  .text("\u{274C}  Cancel", "menu:main");

// ── Deal Confirmation ─────────────────────────────────────────
export function dealConfirm() {
  return new InlineKeyboard()
    .text("\u{2705}  Create Deal", "deal:confirm")
    .text("\u{270F}\u{FE0F}  Edit", "deal:edit")
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
  if (status === "FUNDED" || status === "IN_PROGRESS") {
    if (status === "FUNDED") k.text("\u{1F4E6}  Mark as Delivered", `deal:deliver:${dealId}`).row();
    k.text("\u{1F6A8}  Open Dispute", `deal:dispute:${dealId}`);
  } else if (status === "DELIVERED") {
    k.text("\u{2705}  Accept & Release", `deal:release:${dealId}`)
      .row()
      .text("\u{1F6A8}  Open Dispute", `deal:dispute:${dealId}`);
  } else if (status === "AWAITING_DEPOSIT") {
    k.text("\u{1F4B0}  Fund from Wallet", `deal:fund:${dealId}`)
      .row()
      .text("\u{274C}  Cancel Deal", `deal:cancel:${dealId}`);
  }
  k.row().text("\u{1F3E0}  Main Menu", "menu:main");
  return k;
}

// ── Wallet Menu ────────────────────────────────────────────────
export const walletMenu = new InlineKeyboard()
  .text("\u{1F4E5}  Deposit", "wallet:deposit")
  .text("\u{1F4E4}  Withdraw", "wallet:withdraw")
  .row()
  .text("\u{1F4DC}  Transactions", "wallet:transactions")
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
