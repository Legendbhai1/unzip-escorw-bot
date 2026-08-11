import { prisma } from "./db.js";
import { config } from "../config/index.js";
import { esc } from "./html.js";

/**
 * Admin-entered escrow payment settings (rows in the admin_settings table).
 * Settings are scoped per authorized escrow GROUP so different groups can have
 * different escrow admins with different receiving details:
 *   - a (key, groupId) row is that group's OWN detail;
 *   - the (key, "") row is the GLOBAL fallback;
 *   - env vars (ESCROW_UPI_ID etc.) are the last-resort fallback for global.
 * Only authorized admins can change them (see /settings in src/bot/admin.ts).
 * The bot NEVER generates, derives or fabricates a receiving address.
 */
export const SETTING_KEYS = {
  upiId: "upi_id",
  upiName: "upi_name",
  usdtBep20Address: "usdt_bep20_address",
  escrowGroupId: "escrow_group_id",
} as const;

/** "" is the global fallback scope. */
export const GLOBAL_GROUP_ID = "";

/**
 * Read one admin setting for a scope. groupId "" = global. Resolution order:
 *   1. the group's own row (when groupId is non-empty)
 *   2. the global DB row ("" scope)
 *   3. the env fallback (global only)
 */
export async function getAdminSetting(key: string, groupId: string = GLOBAL_GROUP_ID): Promise<string> {
  try {
    const row = await prisma.adminSetting.findUnique({
      where: { key_groupId: { key, groupId } },
    });
    if (row?.value?.trim()) return row.value.trim();
    if (groupId !== GLOBAL_GROUP_ID) {
      const global = await prisma.adminSetting.findUnique({
        where: { key_groupId: { key, groupId: GLOBAL_GROUP_ID } },
      });
      if (global?.value?.trim()) return global.value.trim();
    }
  } catch {
    /* DB unavailable — fall through to env */
  }
  // Env vars (ESCROW_UPI_ID etc.) are the deployment-level default: they apply
  // at every scope until an admin enters group-specific (or global) details.
  if (key === SETTING_KEYS.upiId) return config.escrow.upiId.trim();
  if (key === SETTING_KEYS.upiName) return config.escrow.upiName.trim();
  if (key === SETTING_KEYS.usdtBep20Address) return (config.escrow.cryptoAddresses["USDT_BEP20"] ?? "").trim();
  if (key === SETTING_KEYS.escrowGroupId) return config.escrowGroupId.trim();
  return "";
}

/** Persist an admin-entered setting for a scope ("" = global fallback). */
export async function setAdminSetting(
  key: string,
  value: string,
  updatedByUserId: string,
  groupId: string = GLOBAL_GROUP_ID
) {
  const clean = value.trim();
  return prisma.adminSetting.upsert({
    where: { key_groupId: { key, groupId } },
    create: { key, groupId, value: clean, updatedBy: updatedByUserId },
    update: { value: clean, updatedBy: updatedByUserId },
  });
}

/** Remove a setting for a scope ("" = the global fallback row). */
export async function deleteAdminSetting(key: string, groupId: string = GLOBAL_GROUP_ID) {
  return prisma.adminSetting.deleteMany({ where: { key, groupId } });
}

/**
 * The escrow group chat id deal cards are posted to. This is a GLOBAL setting
 * (`escrow_group_id` or the ESCROW_GROUP_ID env fallback) — the admin-entered
 * value wins so the group can be re-pointed without redeploying.
 */
export async function getEscrowGroupId(): Promise<string> {
  return (await getAdminSetting(SETTING_KEYS.escrowGroupId, GLOBAL_GROUP_ID)).trim();
}

export const UNAVAILABLE_MESSAGE =
  "Payment method is currently unavailable. Please contact an admin.";

/**
 * Resolve the scope a deal's payment instructions come from: the group the
 * deal card was posted to (deal.groupChatId) when known, else the caller's
 * explicit groupId, else the global fallback.
 */
export function dealSettingsScope(deal: { groupChatId?: string | null }, groupId?: string): string {
  return String(deal.groupChatId ?? groupId ?? GLOBAL_GROUP_ID).trim();
}

/**
 * Payment instructions come ONLY from the escrower's manually entered details
 * (admin_settings, scoped to the deal's group) or the configured env fallbacks.
 * The bot NEVER generates, derives or fabricates an address. Only two payment
 * methods are supported:
 *   - INR / UPI
 *   - USDT on BEP20
 * Any other denomination is reported as unavailable.
 */
export async function getPaymentInstructionsText(
  deal: { asset: string; network: string; paymentMethod: string; groupChatId?: string | null },
  groupId?: string
): Promise<string> {
  const scope = dealSettingsScope(deal, groupId);
  const method = deal.paymentMethod?.toUpperCase?.() ?? "CRYPTO";

  if (method === "INR") {
    const upiId = await getAdminSetting(SETTING_KEYS.upiId, scope);
    const upiName = await getAdminSetting(SETTING_KEYS.upiName, scope);
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

  const address = await getAdminSetting(SETTING_KEYS.usdtBep20Address, scope);
  if (!address) return UNAVAILABLE_MESSAGE;

  const lines: string[] = [];
  lines.push("Network: <b>USDT BEP20</b> (only USDT on BEP20 is supported)");
  lines.push(`Send <b>USDT</b> on <b>BEP20</b> to the escrower:`);
  lines.push(`<code>${esc(address)}</code>`);
  lines.push("Pay the exact deal total (deal amount + buyer fee).");
  return lines.join("\n");
}

/** True when payment instructions for this deal (scoped to its group) are configured. */
export async function hasPaymentInstructions(
  deal: { asset: string; network: string; paymentMethod: string; groupChatId?: string | null },
  groupId?: string
): Promise<boolean> {
  const scope = dealSettingsScope(deal, groupId);
  const method = deal.paymentMethod?.toUpperCase?.() ?? "CRYPTO";
  if (method === "INR") {
    return Boolean(
      (await getAdminSetting(SETTING_KEYS.upiId, scope)) ||
      (await getAdminSetting(SETTING_KEYS.upiName, scope))
    );
  }
  const asset = String(deal.asset ?? "").toUpperCase();
  const network = String(deal.network ?? "").toUpperCase();
  if (asset !== "USDT" || network !== "BEP20") return false;
  return Boolean(await getAdminSetting(SETTING_KEYS.usdtBep20Address, scope));
}
