import { prisma } from "./db.js";
import { config } from "../config/index.js";
import { esc } from "./html.js";

/**
 * Admin-entered escrow payment settings (keys in the admin_settings table).
 * Only authorized admins can change them (see /settings in src/bot/admin.ts).
 * Env vars (ESCROW_UPI_ID etc.) are a fallback for deployments that have not
 * entered settings in the bot yet — the DB value always wins.
 */
export const SETTING_KEYS = {
  upiId: "upi_id",
  upiName: "upi_name",
  usdtBep20Address: "usdt_bep20_address",
  escrowGroupId: "escrow_group_id",
} as const;

/** Read one admin setting, falling back to env config when absent. */
export async function getAdminSetting(key: string): Promise<string> {
  try {
    const row = await prisma.adminSetting.findUnique({ where: { key } });
    if (row?.value?.trim()) return row.value.trim();
  } catch {
    /* DB unavailable — fall back to env */
  }
  if (key === SETTING_KEYS.upiId) return config.escrow.upiId.trim();
  if (key === SETTING_KEYS.upiName) return config.escrow.upiName.trim();
  if (key === SETTING_KEYS.usdtBep20Address) return (config.escrow.cryptoAddresses["USDT_BEP20"] ?? "").trim();
  if (key === SETTING_KEYS.escrowGroupId) return config.escrowGroupId.trim();
  return "";
}

/**
 * The escrow group chat id deal cards are posted to. The admin-entered
 * `escrow_group_id` setting wins (settable via /settings without redeploying);
 * otherwise the `ESCROW_GROUP_ID` env fallback is used.
 */
export async function getEscrowGroupId(): Promise<string> {
  return (await getAdminSetting(SETTING_KEYS.escrowGroupId)).trim();
}

export const UNAVAILABLE_MESSAGE =
  "Payment method is currently unavailable. Please contact an admin.";

/**
 * Payment instructions come ONLY from the escrower's manually entered details
 * (admin_settings) or the configured env fallbacks. The bot NEVER generates,
 * derives or fabricates an address. Only two payment methods are supported:
 *   - INR / UPI
 *   - USDT on BEP20
 * Any other denomination is reported as unavailable.
 *
 * `deal` is the Prisma deal row (or any object with asset + network).
 */
export async function getPaymentInstructionsText(deal: {
  asset: string;
  network: string;
  paymentMethod: string;
}): Promise<string> {
  const method = deal.paymentMethod?.toUpperCase?.() ?? "CRYPTO";

  if (method === "INR") {
    const upiId = await getAdminSetting(SETTING_KEYS.upiId);
    const upiName = await getAdminSetting(SETTING_KEYS.upiName);
    if (!upiId && !upiName) return UNAVAILABLE_MESSAGE;
    const lines: string[] = [];
    if (upiName) lines.push(`Payee: <b>${esc(upiName)}</b>`);
    if (upiId) lines.push(`UPI ID: <code>${esc(upiId)}</code>`);
    lines.push("Pay the exact deal total (deal amount + buyer fee) to the UPI ID above.");
    return lines.join("\n");
  }

  // CRYPTO — only USDT on BEP20 is supported.
  const asset = String(deal.asset ?? "").toUpperCase();
  const network = String(deal.network ?? "").toUpperCase();
  if (asset !== "USDT" || network !== "BEP20") return UNAVAILABLE_MESSAGE;

  const address = await getAdminSetting(SETTING_KEYS.usdtBep20Address);
  if (!address) return UNAVAILABLE_MESSAGE;

  const lines: string[] = [];
  lines.push("Network: <b>USDT BEP20</b> (only USDT on BEP20 is supported)");
  lines.push(`Send <b>USDT</b> on <b>BEP20</b> to the escrower:`);
  lines.push(`<code>${esc(address)}</code>`);
  lines.push("Pay the exact deal total (deal amount + buyer fee).");
  return lines.join("\n");
}

/**
 * True when payment instructions for this deal are configured.
 */
export async function hasPaymentInstructions(deal: {
  asset: string;
  network: string;
  paymentMethod: string;
}): Promise<boolean> {
  const method = deal.paymentMethod?.toUpperCase?.() ?? "CRYPTO";
  if (method === "INR") {
    return Boolean((await getAdminSetting(SETTING_KEYS.upiId)) || (await getAdminSetting(SETTING_KEYS.upiName)));
  }
  const asset = String(deal.asset ?? "").toUpperCase();
  const network = String(deal.network ?? "").toUpperCase();
  if (asset !== "USDT" || network !== "BEP20") return false;
  return Boolean(await getAdminSetting(SETTING_KEYS.usdtBep20Address));
}
