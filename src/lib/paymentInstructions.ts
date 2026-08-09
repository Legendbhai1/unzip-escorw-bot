import { config } from "../config/index.js";
import { esc } from "./html.js";

/**
 * Payment instructions come ONLY from configured escrower details
 * (ESCROW_UPI_ID / ESCROW_UPI_NAME / ESCROW_CRYPTO_ADDRESS_*). The bot never
 * generates, derives or fabricates an address. If nothing is configured for
 * the deal's payment method, a clear fallback is returned.
 *
 * `deal` is the Prisma deal row (or any object with asset + network).
 */
export function getPaymentInstructionsText(deal: { asset: string; network: string; paymentMethod: string }): string {
  const method = deal.paymentMethod?.toUpperCase?.() ?? "CRYPTO";

  if (method === "INR") {
    const upiId = config.escrow.upiId.trim();
    const upiName = config.escrow.upiName.trim();
    if (!upiId && !upiName) {
      return "Payment instructions are currently unavailable. Please contact the escrower.";
    }
    const lines: string[] = [];
    if (upiName) lines.push(`Payee: <b>${esc(upiName)}</b>`);
    if (upiId) lines.push(`UPI ID: <code>${esc(upiId)}</code>`);
    lines.push("Pay the exact deal total (deal amount + buyer fee) to the UPI ID above.");
    return lines.join("\n");
  }

  // CRYPTO: denomination only — the escrower's own receive address.
  const key = `${deal.asset}_${deal.network}`.toUpperCase();
  const address = config.escrow.cryptoAddresses[key]?.trim?.() ?? "";
  if (!address) {
    return "Payment instructions are currently unavailable. Please contact the escrower.";
  }
  const lines: string[] = [];
  lines.push(`Send <b>${esc(deal.asset)}</b> on <b>${esc(deal.network)}</b> to the escrower:`);
  lines.push(`<code>${esc(address)}</code>`);
  lines.push("Pay the exact deal total (deal amount + buyer fee).");
  return lines.join("\n");
}

/**
 * True when payment instructions for this deal are configured.
 */
export function hasPaymentInstructions(deal: { asset: string; network: string; paymentMethod: string }): boolean {
  const method = deal.paymentMethod?.toUpperCase?.() ?? "CRYPTO";
  if (method === "INR") {
    return Boolean(config.escrow.upiId.trim() || config.escrow.upiName.trim());
  }
  const key = `${deal.asset}_${deal.network}`.toUpperCase();
  return Boolean(config.escrow.cryptoAddresses[key]?.trim?.());
}
